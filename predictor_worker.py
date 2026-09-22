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
from collections import deque
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

# ── 排队参数（2026-09-23，替代"秒拒 503"）────────────────────────────────
# 原行为：闸门满 → 立刻 503 worker_busy。线上 server.log 里 12 条 busy 全是
# duration_ms<10ms 的秒拒 —— 用户高峰期直接看到「预测服务繁忙」，但此刻 worker
# 其实只是在跑上一单（15~30s），等一等就有。
#
# 改为 FIFO 短队列：满了就按先来后到等，等不到才 503。两个硬参数：
#   PREDICTOR_MAX_WAIT_SEC  队列里最长等 45s。
#     约束：45 + 单次预测(15~30s) < WORKER_TIMEOUT_MS(server.js:205 默认 120s)。
#     这条必须守住 —— worker 撑到 node 超时会被判「worker 失败」→ 降级 spawn
#     （fork 3.4GB python，OOM 老路）；而显式 503 走的是不降级分支。
#   PREDICTOR_MAX_QUEUE     队列上限 6。超过的毫秒级 503，不让客户端干等。
MAX_WAIT_SEC = max(0.0, float(os.environ.get("PREDICTOR_MAX_WAIT_SEC", "45")))
MAX_QUEUE = max(0, int(os.environ.get("PREDICTOR_MAX_QUEUE", "6")))


class _FairGate:
    """FIFO 公平闸门。

    为什么不用 Semaphore.acquire(timeout)：Semaphore 唤醒哪个线程由调度器决定，
    **无公平性保证** —— 队列里等了 40s 的请求可能被刚来的请求插队，队尾永远
    超时。这里用「取号 + 有序唤醒」保证先到先得，顺带得到准确的 queue_len。

    用法：
        ok, waited = gate.acquire(timeout)   # 拿号排队
        if ok:
            try: ...
            finally: gate.release()
    """

    def __init__(self, slots: int):
        self._slots = max(1, slots)
        self._active = 0
        self._next_ticket = 0
        self._waiters: deque = deque()   # 排队中的 ticket（FIFO）
        self._cv = threading.Condition()

    def acquire(self, timeout: float):
        """返回 (是否拿到, 等待秒数)。拿到后必须 release()。"""
        t0 = time.time()
        with self._cv:
            # 快速路径：有空位且无人排队 → 直接进（保持空闲零开销；有人排队
            # 时即使有空位也要按号序唤醒，否则就是插队）
            if self._active < self._slots and not self._waiters:
                self._active += 1
                return True, 0.0
            if timeout <= 0:
                return False, 0.0
            ticket = self._next_ticket
            self._next_ticket += 1
            self._waiters.append(ticket)
            try:
                while True:
                    remaining = timeout - (time.time() - t0)
                    if remaining <= 0:
                        return False, time.time() - t0
                    if (self._waiters and self._waiters[0] == ticket
                            and self._active < self._slots):
                        self._waiters.popleft()
                        self._active += 1
                        return True, time.time() - t0
                    self._cv.wait(timeout=min(remaining, 0.5))
            finally:
                # 超时/异常离场：把自己从队列摘掉（还在队里的话）
                if ticket in self._waiters:
                    try:
                        self._waiters.remove(ticket)
                    except ValueError:
                        pass

    def release(self):
        with self._cv:
            self._active -= 1
            self._cv.notify_all()

    @property
    def queue_len(self) -> int:
        return len(self._waiters)

    @property
    def in_use(self) -> int:
        return self._active


_gate = _FairGate(MAX_CONCURRENCY)

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


# ── 热门车次空闲预热（2026-09-23）────────────────────────────────────────
# 动机：冷查询 16~34s 的主因是 zugfinder 逐日抓取。同一车次被查过一次后，
# ~/.cache/zugfinder_pro/<train>/<date>.json 就有了，第二次起毫秒命中。
# 但缓存只对"当天"有效——次日全部过期，每个人都要重新付一次冷启动的钱。
#
# 做法：worker 记录真实查询频次（/hot 可观测），空闲超过 WARMUP_IDLE_SEC 且
# 闸门空闲时，给 Top-N 车次把「昨天及更早」的缺失日期补进缓存。补过的天次日
# 依旧是热的，用户冷查询只剩"今天"一天要抓 + DB 实时补充。
#
# 三条纪律：
#   1. 绝不破坏「并发=1」：预热线程必须 non-blocking 抢闸门，抢不到就放弃本轮。
#      （否则用户请求来了要在预热后面排队，捡了芝麻丢了西瓜）
#   2. 不碰"今天"：今天的行无论如何会被 _today_snapshot_partial →
#      db_realtime_train 接管，补了也白补；且当日快照写进缓存会被 stale 判定
#      拒绝（train_insight.collect 的 is_stale 逻辑），反而制造 pending。
#   3. 遇限流立刻停：预热是锦上添花，绝不和用户抢账号配额。
_hot_lock = threading.Lock()
_hot_counter = {}          # norm_train -> 次数（进程生命周期内累积）
_last_request_ts = 0.0     # 最近一次 /predict 的时间（判断"空闲"用）
WARMUP_IDLE_SEC = max(60, int(os.environ.get("PREDICTOR_WARMUP_IDLE_SEC", "300")))
WARMUP_TOP_N = max(1, int(os.environ.get("PREDICTOR_WARMUP_TOP_N", "5")))


def _note_request(train: str):
    """每个 /predict 请求都会调用：更新频次与空闲时刻。"""
    global _last_request_ts
    with _hot_lock:
        _hot_counter[train] = _hot_counter.get(train, 0) + 1
        _last_request_ts = time.time()


def _hot_trains(n: int) -> list:
    with _hot_lock:
        pairs = sorted(_hot_counter.items(), key=lambda kv: -kv[1])
    return [t for t, _ in pairs[:n]]


def _idle_warmer():
    """空闲预热循环：低频检查，仅在 worker 真闲时工作。"""
    while True:
        time.sleep(60)
        try:
            if time.time() - _last_request_ts < WARMUP_IDLE_SEC:
                continue                       # 最近有真实流量 → 让路
            trains = _hot_trains(WARMUP_TOP_N)
            if not trains:
                continue
            # non-blocking 抢闸门：拿不到说明正在服务用户 → 直接放弃本轮
            ok, _ = _gate.acquire(0)
            if not ok:
                continue
            try:
                _prewarm_trains(trains)
            finally:
                _gate.release()
        except Exception as e:  # noqa: BLE001 —— 预热绝不影响服务
            _log("预热异常（忽略）: %s" % str(e)[:120])


def _prewarm_trains(trains: list):
    """给每个热门车次补「昨天及更早」的缺失日期缓存。"""
    import train_insight as ti
    from datetime import timedelta

    cred = os.environ.get("ZUGFINDER_CRED", ti.DEFAULT_CRED)
    try:
        cli = ti.ZugfinderPro(cred)
    except Exception as e:  # noqa: BLE001
        _log("预热登录失败: %s" % str(e)[:80])
        return
    today = ti.date.today()
    filled = 0
    for train in trains:
        for i in range(7, 0, -1):              # 7 天前 → 昨天，不含今天
            ds = (today - timedelta(days=i)).isoformat()
            p = os.path.join(ti.CACHE_DIR, train, ds + ".json")
            if os.path.exists(p):
                continue
            try:
                rows = cli.zuginfo(train, ds)
            except Exception as e:  # noqa: BLE001 —— 限流/网络问题即停，不挣扎
                _log("预热 %s %s 失败（停止本轮）: %s" % (train, ds, str(e)[:80]))
                return
            if not rows:
                continue
            if "Zu viele Abfragen" in str(rows[0].get("arr", "")) \
                    or "limitreaktivieren" in str(rows[0].get("arr", "")):
                _log("预热 %s 触发 zugfinder 限流（停止本轮）" % train)
                return
            ti._atomic_write_json(p, rows)
            filled += 1
            time.sleep(1.5)                     # 与 collect 并行路径的线程内间隔一致
    if filled:
        _log("空闲预热完成：补 %d 天（%s）"
             % (filled, ",".join(trains[:3]) + ("…" if len(trains) > 3 else "")))


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
                "in_use": _gate.in_use,
                "queue_len": _gate.queue_len,
                "max_queue": MAX_QUEUE,
                "max_wait_sec": MAX_WAIT_SEC,
                "served": served,
                "failed": failed,
                "avg_ms": round(total / served, 1) if served else 0,
            })
        if self.path.startswith("/hot"):
            # 热门车次频次（供人工观察预热效果；node 侧也可取去聚合）
            try:
                n = int(self.path.split("n=")[-1]) if "n=" in self.path else 20
            except ValueError:
                n = 20
            return self._send(200, {"hot": _hot_trains(min(max(1, n), 100))})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/predict":
            return self._send(404, {"error": "not found"})

        params = self._read_body()
        if not params.get("train"):
            return self._send(400, {"error": "缺少参数 train"})

        # 热门统计：车次按 CACHE_DIR 的归一格式记（预热直接用它拼缓存路径）
        try:
            import train_insight as _ti
            _note_request(_ti._norm_train(str(params["train"])))
        except Exception:  # noqa: BLE001 —— 统计失败绝不影响主流程
            pass

        t0 = time.time()
        # 内存自保护：排队**前**先查，内存真不够时毫秒级拒绝，不让请求白排 45s
        _reject = memory_guard()
        if _reject:
            return self._send(503, _reject)

        # FIFO 公平排队：满了就按先来后到等（最多 MAX_WAIT_SEC），等不到才 503。
        # 之前是 _sem.acquire(blocking=False) 秒拒 —— 高峰期用户看到的全是
        # 「繁忙」，其实等几秒就有槽位。
        #
        # 队列上限先查：超过 MAX_QUEUE 的立即毫秒级 503。不查的话，第 MAX_QUEUE+1
        # 个也会白等满 45s 才超时（2026-09-23 压测踩坑：7 并发里超限者同样
        # 45.02s 才拿到 503，纯粹浪费客户端等待窗口）。
        if _gate.queue_len >= MAX_QUEUE:
            return self._send(503, {
                "error": "worker_busy",
                "hint": "预测排队已满（%d），请稍后重试" % MAX_QUEUE,
                "max_concurrency": MAX_CONCURRENCY,
                "queue_len": _gate.queue_len,
                "waited_s": 0,
            })
        ok, waited_s = _gate.acquire(MAX_WAIT_SEC)
        if not ok:
            return self._send(503, {
                "error": "worker_busy",
                "hint": "预测排队超时（>%ds），请稍后重试" % int(MAX_WAIT_SEC),
                "max_concurrency": MAX_CONCURRENCY,
                "queue_len": _gate.queue_len,
                "waited_s": round(waited_s, 1),
            })
        try:
            data = run_prediction(params)
        finally:
            _gate.release()

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
    # 默认值 5：排队线程一多，内核会在 accept 前丢 SYN，客户端拿到的是
    # connection reset 而不是我们精心准备的 503。显式放大。
    request_queue_size = 128


def main():
    ap = argparse.ArgumentParser(description="常驻列车晚点预测 worker")
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("PREDICTOR_WORKER_PORT", "5099")))
    ap.add_argument("--no-warmup", action="store_true", help="跳过预热")
    args = ap.parse_args()

    _log("启动中… port=%d max_concurrency=%d" % (args.port, MAX_CONCURRENCY))

    if not args.no_warmup:
        threading.Thread(target=warmup, daemon=True).start()
        threading.Thread(target=_idle_warmer, daemon=True).start()

    srv = Server(("127.0.0.1", args.port), Handler)
    _log("已监听 http://127.0.0.1:%d" % args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        _log("收到中断，退出")


if __name__ == "__main__":
    main()
