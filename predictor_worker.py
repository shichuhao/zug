#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
常驻预测 worker（2026-09-14 压测后的架构修复）

背景
────
原架构 spawn-per-request：每个 /api/train 请求都 `python train_insight.py ...`，
而 ProductionPredictor() 构造要 joblib.load(21MB 模型) + FeatureCache() 读取
recent7/station_hist/line_hist/131MB train_hist —— 实测 **72.4s / 3.29GB**，
占冷启动 82s 的 88%；真正的推理只要 **0.91s**。
并发 N 就等于同时跑 N 份这样的加载 → 4 核下 CPU 与内存双重打满 → 全员超时 502
（压测实测 100 并发冷车次 0/100 成功）。

本 worker 的做法
────────────────
进程常驻，模型与历史表只加载一次（train_insight._get_shared_predictor 单例），
之后每个请求只付「网络抓取 + 特征装配 + 推理」的代价。

设计要点
────────
1. 零第三方依赖：只用标准库 http.server。本机 miniconda 环境装有 lightgbm/
   scipy/pandas 等重依赖，再 pip install fastapi/uvicorn 有破坏环境的风险。
2. 不重写业务逻辑：通过 redirect_stdout 捕获 train_insight.main(argv) 的 JSON
   输出。main() 内部的大量修复（RE/RB z 键、行程模板对齐、联邦州指纹、
   PieBro 补位、DB 实时…）全部原样复用，零重写风险。
3. 传参全部走 argv，不用 os.environ：多线程下环境变量会被并发请求互相串改。
   （train_insight.main 已为此新增 --ride-from/--ride-to/--ride-time。）
4. 串行队列 + 并发上限：防止 N 个请求同时抓取把 zugfinder 打到限流。
   GIL 下真正的并行收益有限，限并发主要是保护外部 API 配额与内存峰值。

启动
────
    /root/miniconda/bin/python predictor_worker.py [--port 5099]

环境变量
────────
    PREDICTOR_WORKER_PORT   监听端口（默认 5099）
    PREDICTOR_MAX_CONCURRENCY  同时执行的预测数（默认 1，见下方说明）
    ZUGFINDER_PRO_DIR       zugfinder Pro 数据目录（透传给 train_insight）
"""

import argparse
import contextlib
import io
import json
import os
import queue
import socketserver
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# ── 全局状态 ─────────────────────────────────────────────────────────────
_started_at = time.time()
_ready = False            # predictor 单例是否已预热
_ready_lock = threading.Lock()
_stats = {"served": 0, "failed": 0, "total_ms": 0.0, "lock": threading.Lock()}

# 并发闸门：默认同时最多 4 个预测在跑（压测实测 8 已是 CPU 拐点）
# 并发上限默认 1，不是保守，是实测结论（2026-09-14 并发压测）：
#   N=1 稳。N=4 时 worker RssAnon 从 3468MB 冲到 4622MB（+1.15GB）后进程被
#   cgroup OOM 清掉（oom_kill +2），因为 4 核配额下 4 个线程各自释放 GIL 跑
#   numpy/pandas，中间数组同时驻留 —— 串行时是逐次释放的，并发时峰值叠加。
# 单次预测 23~26s（RB 车次抓取较慢）已可接受；把并发让给「多开几个 worker 实例」
# 或请求合并（server.js 侧已做同 cacheKey 合并）更划算。
MAX_CONCURRENCY = max(1, int(os.environ.get("PREDICTOR_MAX_CONCURRENCY", "1")))
_sem = threading.Semaphore(MAX_CONCURRENCY)

# 预测前要求的最小可用内存（MB）。见 run_prediction 内注释：worker 稳态 3.5~3.8GB，
# 8GB cgroup 下余量本就薄，低于此值就拒服务，避免被内核 OOM 清掉整个常驻进程。
#
# 2026-09-14 两次误判的教训（不要退回老方案）：
#   1) 800MB：实测余量 807MB 判定放行、487MB 判定拒绝，阈值卡在正常工作区间里，
#      导致正常查询被间歇性 503（表现为"ICE 847 查不了"，其实与车次无关）。
#   2) 改成 500MB 后仍在 487MB 处再次误拒 —— 说明「余量绝对值」这个判据本身是错的。
#
# 根因：cgroup 8GB 里还住着 sandbox-proxy(~1.1GB) 等与本服务无关的常驻进程，
# 容器总余量被它们长期压低到临界区，用它做判据必然抖动。
#
# 现方案：只看「worker 自身 RssAnon 距 cgroup 限额还剩多少」，并留出
# PREDICT_HEADROOM_MB（默认 400MB，覆盖单次预测峰值 ~0.3GB）。这样只有真正
# "再跑一次就要撞限额"时才拒绝，与我们关心的 OOM 风险一一对应。
MIN_FREE_MB_FOR_PREDICT = max(200, int(os.environ.get("PREDICTOR_MIN_FREE_MB", "500")))
PREDICT_HEADROOM_MB = max(200, int(os.environ.get("PREDICTOR_HEADROOM_MB", "400")))


def _cgroup_limit_mb():
    """cgroup v2 内存限额（MB）；无限制/探测不到返回 None。"""
    try:
        with open("/sys/fs/cgroup/memory.max") as f:
            mx = f.read().strip()
        if mx and mx != "max":
            return int(mx) // (1024 * 1024)
    except Exception:
        pass
    try:
        with open("/sys/fs/cgroup/memory/memory.limit_in_bytes") as f:
            v = int(f.read().strip())
        if 0 < v < (1 << 62):
            return v // (1024 * 1024)
    except Exception:
        pass
    return None


def _self_rss_anon_mb():
    """本进程匿名内存（MB）—— 预测峰值主要体现为这块的增长。"""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("RssAnon:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


def _available_mb():
    """可用内存（MB）。优先 cgroup v2 限额（容器内真实约束），回落 /proc/meminfo。"""
    # cgroup v2: memory.max / memory.current
    try:
        with open("/sys/fs/cgroup/memory.max") as f:
            mx = f.read().strip()
        if mx and mx != "max":
            with open("/sys/fs/cgroup/memory.current") as f:
                cur = int(f.read().strip())
            return max(0, (int(mx) - cur) // (1024 * 1024))
    except Exception:
        pass
    # 回落：/proc/meminfo 的 MemAvailable
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None  # 探测不到就不阻断

def memory_guard():
    """预测前的内存自保护。返回 None 表示放行，否则返回错误 dict。

    主判据：本进程匿名内存 + 预测峰值预留 必须小于 cgroup 限额。
    不再使用「容器总余量」——容器内混住着无关进程（sandbox-proxy 等），
    会让全局余量长期停在临界区，阈值判定随之抖动、误伤正常请求。
    """
    limit = _cgroup_limit_mb()
    own = _self_rss_anon_mb()
    if limit is None or own is None:
        return None  # 探测不到就不阻断
    if own + PREDICT_HEADROOM_MB <= limit:
        return None  # 跑完这一单仍不会撞限额 → 放行
    # 拒绝前再看一眼绝对余量，便于日志定位（不参与判定）
    avail = _available_mb()
    return {"error": "预测服务内存紧张，请稍后重试", "retryable": True,
            "memory": {"own_anon_mb": own, "headroom_mb": PREDICT_HEADROOM_MB,
                       "cgroup_limit_mb": limit, "available_mb": avail}}




def _log(msg):
    sys.stderr.write("[worker %d] %s\n" % (os.getpid(), msg))
    sys.stderr.flush()


# ── 预热：真正吃掉那 72s 的一次性开销 ─────────────────────────────────────
def warmup():
    """后台预热 predictor 单例。失败不致命 —— 首个请求会再试一次。"""
    global _ready
    try:
        t0 = time.time()
        import train_insight
        from production_predictor import ProductionPredictor
        # _get_shared_predictor 内部懒构造，这里显式触发以避免首访踩坑
        train_insight._get_shared_predictor(ProductionPredictor)
        with _ready_lock:
            _ready = True
        _log("预热完成，用时 %.1fs（此后每请求省掉这笔加载）" % (time.time() - t0))
    except Exception as e:
        _log("预热失败（首个请求将重试）: %s" % e)
        traceback.print_exc()


# ── 预测执行 ─────────────────────────────────────────────────────────────
def run_prediction(params):
    """
    执行一次预测，返回结果 dict。
    通过 stdout 重定向复用 train_insight.main() 的完整业务逻辑。
    """
    import train_insight

    train = str(params.get("train") or "").strip()
    if not train:
        return {"error": "缺少参数 train"}

    # 内存自保护：worker 稳态约 3.5~3.8GB，一次预测峰值还要再涨 ~0.3GB。
    # cgroup 只有 8GB，且与 node/sandbox-proxy/定时抓取同处一个限额。
    # 判据见 memory_guard()：只看本进程距限额还剩多少，不看容器总余量
    # （后者被无关进程长期压低，会把正常请求误判成内存紧张）。
    _reject = memory_guard()
    if _reject:
        return _reject

    days = params.get("days") or 8
    days = max(3, min(8, int(days)))

    argv = [train, "--days", str(days)]
    if params.get("date"):
        argv += ["--date", str(params["date"])]
    if params.get("destination"):
        argv += ["--destination", str(params["destination"])]
    if params.get("ride_from"):
        argv += ["--ride-from", str(params["ride_from"])]
    if params.get("ride_to"):
        argv += ["--ride-to", str(params["ride_to"])]
    if params.get("ride_time"):
        argv += ["--ride-time", str(params["ride_time"])]

    buf = io.StringIO()
    try:
        # main() 的所有输出都走 print(json.dumps(...))，重定向即可取回
        # server.js 正是靠解析这段 stdout 工作的，语义100%对齐
        with contextlib.redirect_stdout(buf):
            rc = train_insight.main(argv)
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else 0
    except BaseException:
        return {"error": "worker 内部异常: " + traceback.format_exc()[-500:]}

    raw = buf.getvalue().strip()
    if not raw:
        return {"error": "worker 无输出 (rc=%s)" % rc}
    try:
        data = json.loads(raw)
    except Exception:
        return {"error": "worker 输出非 JSON: " + raw[:300]}
    return data


# ── HTTP 服务 ────────────────────────────────────────────────────────────
MAX_BODY = 64 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "PredictorWorker/1.0"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        if n > MAX_BODY:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def log_message(self, fmt, *args):
        pass  # 静默访问日志，减少干扰

    def do_GET(self):
        if self.path in ("/health", "/ping"):
            with _stats["lock"]:
                served, failed, total = (_stats["served"], _stats["failed"],
                                         _stats["total_ms"])
            with _ready_lock:
                ready = _ready
            return self._send(200, {
                "ok": True,
                "pid": os.getpid(),
                "ready": ready,
                "uptime_s": round(time.time() - _started_at, 1),
                "max_concurrency": MAX_CONCURRENCY,
                "in_use": MAX_CONCURRENCY - _sem._value,
                "served": served,
                "failed": failed,
                "avg_ms": round(total / served, 1) if served else 0,
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/predict":
            return self._send(404, {"error": "not found"})

        params = self._read_body()
        if not params.get("train"):
            return self._send(400, {"error": "缺少参数 train"})

        t0 = time.time()
        # 并发闸门：非阻塞尝试，排队满了就快速失败（让 node 侧降级/排队），
        # 而不是让用户无限期等待后被自己的超时掐掉
        if not _sem.acquire(blocking=False):
            return self._send(503, {
                "error": "worker_busy",
                "hint": "预测 worker 已达并发上限 %d，请稍后重试" % MAX_CONCURRENCY,
                "max_concurrency": MAX_CONCURRENCY,
            })
        try:
            data = run_prediction(params)
        finally:
            _sem.release()

        ms = int((time.time() - t0) * 1000)
        with _stats["lock"]:
            _stats["served"] += 1
            _stats["total_ms"] += ms
            if isinstance(data, dict) and data.get("error"):
                _stats["failed"] += 1

        # 状态码语义要与 node 侧的分支判定对齐：
        #   200 正常 / 502 业务错误（车次不存在等，重试无用）/
        #   503 暂时性失败（繁忙、内存紧张 —— retryable，等几秒再来）
        # node 侧对 503 一律不降级 spawn（降级会 fork 3.4GB），对 502 透传。
        if not isinstance(data, dict) or not data.get("error"):
            code = 200
        elif data.get("retryable"):
            code = 503
        else:
            code = 502
        return self._send(code, data)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="常驻列车晚点预测 worker")
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("PREDICTOR_WORKER_PORT", "5099")))
    ap.add_argument("--no-warmup", action="store_true", help="跳过预热")
    args = ap.parse_args()

    _log("启动中… port=%d max_concurrency=%d" % (args.port, MAX_CONCURRENCY))

    if not args.no_warmup:
        threading.Thread(target=warmup, daemon=True).start()

    srv = Server(("127.0.0.1", args.port), Handler)
    _log("已监听 http://127.0.0.1:%d" % args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        _log("收到中断，退出")


if __name__ == "__main__":
    main()
