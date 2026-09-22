"""Keyless Deutsche Bahn realtime access via bahn.expert (oRPC transport).

为何重写（2026-09-10）
----------------------
bahn.expert 已从旧版 **tRPC + devalue** 迁移到 **oRPC**（TanStack Start / SSR）。
旧的 `/rpc/<proc>?batch=1&input=...` 现在一律 404；新版端点是：

    POST https://bahn.expert/api/orpc/<group>/<procedure>
    Content-Type: application/json
    body: {"json": <input>}          # oRPC 必须用 {"json": ...} 包裹实参

已实测可用的 procedure：
  * stopPlace/byTerm   {"searchTerm": str, "filterForIris": bool, "max": int}
                       -> [{evaNumber, name, ril100, position, ...}]
  * journey/find       {"journeyNumber": int, "category"?: str, "withOEV"?: bool,
                        "evaNumberAlongRoute"?: str, "administration"?: str,
                        "initialDepartureDate"?: ISO}
                       -> [{journeyId, train:{category,journeyNumber,line},
                            firstStop:{stopPlace:{name}}, lastStop:{...}}]
  * journey/detailsByJourneyId  "journeyId"（裸字符串实参）
                       -> {stops:[{stopPlace, arrival, departure,
                                   irisMessages?:[{text,timestamp,value}]}],
                           segmentStart, segmentDestination, train, currentStop, ...}
  * journey/journeyIdByJid      {"jid": ...}   （备用：由 IRIS jid 反查）

关键调用约束（实测）
--------------------
1. **完整浏览器请求头是必需的**：缺 Origin/Referer/sec-fetch-* 时，
   服务端可能返回 500（"Only HTML requests are supported here"）或 404。
2. **限流**：连续快速请求会返回 HTTP 206 且 body 为空。需 ~6s 间隔重试。
   本模块内置冷却 + 磁盘陈旧缓存回退，把「偶发空响应」变成「几乎总成功」。

设计目标：保持与原 tRPC 版**相同的公开函数签名**（search_station / find_journey /
journey_details），调用方（train_incidents.py 等）无需改动。
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone

_BE_BASE = "https://bahn.expert/api/orpc"
_BE_HOST = "bahn.expert"
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

# --------------------------------------------------------------------------- #
# 网络参数                                                                     #
# --------------------------------------------------------------------------- #
# bahn.expert 为免费公开服务，对频率敏感。保留三层保护，但把「预防性减速」调到
# 实测所需的最低值 —— 见下方 2026-09-23 降速根因分析。
#
# ── 为什么原来要用 3.5s 最小间隔（已废弃）────────────────────────────────
# 注释原本写着「连续快速请求会返回 HTTP 206 且 body 为空，需 ~6s 间隔重试」。
# 2026-09-23 实测（keep-alive 单连接，零间隔连打 8 次 journey/find）：
#     8/8 全部 200 OK，无一次空响应 / 206。
# 而 3.5s 的代价是实打实的：一次 db_realtime_train 要串行走 find_journey +
# journey_details 两次调用，第二次必然白等 3.5s；实测首次 0.46s、第二次 3.87s。
# 冷查询端到端 16~34s 里，这一项独占近三分之一。
#
# 现在的 0.4s 不是"取消保护"，只是从「预防性限速」退回「避免瞬时连击」，真正
# 的兜底交给下面两层：
#   - 瞬时错误（206 空 body / 500 / 超时）→ 指数退避重试
#   - 连续失败 → 请求级冷却 30s + 陈旧磁盘缓存回退
# 若将来对端策略变化，用 BAHN_EXPERT_GAP_SEC 环境变量调回去即可，无需改代码。
_REQ_GAP_SEC = float(os.environ.get("BAHN_EXPERT_GAP_SEC", "0.4"))
_RPC_RETRIES = int(os.environ.get("BAHN_EXPERT_RETRIES", "3"))
_RPC_BACKOFF = 0.6
_RPC_TIMEOUT_SEC = float(os.environ.get("BAHN_EXPERT_TIMEOUT_SEC", "12"))
_RPC_COOLDOWN_SEC = float(os.environ.get("BAHN_EXPERT_COOLDOWN_SEC", "30"))

# ── keep-alive 常驻连接（2026-09-23 新增）────────────────────────────────
# 原实现每次 _rpc 都 urllib.request.urlopen() → 每次新建 TCP + TLS 握手。
# cProfile 实测：单次 TLS do_handshake 稳定 1.2s，5 次握手累计 6.05s，
# 而**真正的业务往返只要 0.16s** —— 握手比干活还贵一个数量级。
# 实测收益（同一连接）：首次 0.44s（含握手），后续每次 0.157s。
#
# 单连接 + 顺序复用：本模块的调用都来自 train_insight 的单请求路径，天然串行；
# 多线程场景（collect 并行化后）由 _conn_lock 保证互斥，不会并发写同一连接。
_CONN_KEEPALIVE_SEC = float(os.environ.get("BAHN_EXPERT_KEEPALIVE_SEC", "60"))
_conn = None            # http.client.HTTPSConnection | None
_conn_born = 0.0
_conn_lock = threading.Lock()

_rpc_failures: dict[str, float] = {}
_last_call_ts = 0.0
# collect 并行化后同进程会有多线程读写 _last_call_ts，无锁会节流失效/重复睡眠
_throttle_lock = threading.Lock()
_last_call_ts = 0.0

# 磁盘缓存：成功响应落盘；实时失败时用近期缓存回退（同时减少对端压力）。
_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          ".cache", "bahn_expert")
_CACHE_TTL_SEC = float(os.environ.get("BAHN_EXPERT_CACHE_TTL_SEC", "600"))


def _cache_key(procedure: str, input_obj) -> str:
    try:
        payload = json.dumps(input_obj, sort_keys=True, default=str,
                             ensure_ascii=False)
    except TypeError:
        payload = repr(input_obj)
    return "%s|%s" % (procedure, payload)


def _cache_path(key: str) -> str:
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return os.path.join(_CACHE_DIR, h + ".json")


def _cache_put(key: str, data) -> None:
    """原子落盘成功响应。永不抛异常。"""
    try:
        if not os.path.isdir(_CACHE_DIR):
            os.makedirs(_CACHE_DIR, exist_ok=True)
        path = _cache_path(key)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "data": data}, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def _cache_get(key: str, ttl: float | None = None):
    """返回 (data, age_sec) 或 (None, 0)。永不抛异常。"""
    try:
        path = _cache_path(key)
        if not os.path.isfile(path):
            return None, 0
        with open(path, "r", encoding="utf-8") as f:
            rec = json.load(f)
        age = time.time() - float(rec.get("ts", 0))
        if ttl is not None and age > ttl:
            return None, age
        return rec.get("data"), age
    except (OSError, ValueError):
        return None, 0


def _throttle() -> None:
    """保证两次真实网络请求之间 >= _REQ_GAP_SEC，规避瞬时连击被判异常。

    线程安全：collect 并行化后同一进程内会有多个请求线程，全局时间戳必须加锁，
    否则会出现「同时判定无需等待」的连击，或「各自睡眠」的重复等待。
    """
    global _last_call_ts
    with _throttle_lock:
        wait = _REQ_GAP_SEC - (time.time() - _last_call_ts)
        if wait > 0:
            time.sleep(wait)
        _last_call_ts = time.time()


def _conn_get():
    """取一条可用的 keep-alive 连接；没有或已过期就新建。调用方须持 _conn_lock。"""
    global _conn, _conn_born
    now = time.time()
    if _conn is not None and (now - _conn_born) > _CONN_KEEPALIVE_SEC:
        try:
            _conn.close()
        except Exception:  # noqa: BLE001
            pass
        _conn = None
    if _conn is None:
        _conn = http.client.HTTPSConnection(
            _BE_HOST, 443, context=_CTX, timeout=_RPC_TIMEOUT_SEC)
        _conn_born = now
    return _conn


def _conn_drop():
    """丢弃当前连接（出错/被服务端关闭时），下次请求会重建。"""
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:  # noqa: BLE001
            pass
        _conn = None


def _post_json(path: str, body: bytes, referer_path: str) -> tuple[int, str]:
    """走 keep-alive 连接发一次 POST，返回 (status, body_text)。

    失败一律抛异常，由 _rpc 的退避重试接管；连接状态由 _conn_drop 复位。
    """
    with _conn_lock:
        conn = _conn_get()
        headers = _headers(referer_path)
        headers["Connection"] = "keep-alive"
        try:
            conn.request("POST", path, body=body, headers=headers)
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8", "ignore")
            status = resp.status
        except Exception:
            # 连接出问题（服务端断连/超时/SSL 错误）→ 丢弃，下次重建。
            # 不在锁内重试，交给调用方的退避逻辑，避免锁持有时间过长。
            _conn_drop()
            raise
    return status, raw


def _headers(referer_path: str = "/") -> dict:
    """完整同源浏览器请求头——缺头会被服务端判为非法请求。"""
    return {
        "User-Agent": _UA,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "Origin": "https://bahn.expert",
        "Referer": "https://bahn.expert" + referer_path,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
    }


def _rpc(procedure: str, input_obj, referer_path: str = "/"):
    """调用 bahn.expert oRPC procedure，返回已解析的 JSON 结果。

    procedure 形如 "journey/find"、"stopPlace/byTerm"。
    input_obj 为实参（字符串 / dict）。
    返回 None 表示合法无结果。
    """
    key = _cache_key(procedure, input_obj)

    # 新鲜缓存短路：命中且在 TTL 内直接返回，避免 _throttle 等待 + 真实网络往返。
    # 说明：本模块为每次请求 spawn 的独立进程，读缓存必须先于 _throttle()，
    # 否则即便磁盘命中也要白等 _REQ_GAP_SEC（3.5s）。None（合法无结果）不落盘，
    # 因此这里不会用缓存掩盖「无结果」。
    cached, age = _cache_get(key, ttl=_CACHE_TTL_SEC)
    if cached is not None:
        sys.stderr.write("[bahn] %s 命中缓存（%.0fs 前），跳过网络\n" % (procedure, age))
        return cached

    # 请求级冷却：该 procedure 近期连续失败，直接走缓存/报错
    if _rpc_failures.get(procedure, 0) > time.time():
        cached, age = _cache_get(key)
        if cached is not None:
            sys.stderr.write("[bahn] %s 冷却中，使用 %.0fs 前缓存\n" % (procedure, age))
            return cached
        raise RuntimeError("bahn.expert %s 暂时不可用（冷却中）" % procedure)

    url = "%s/%s" % (_BE_BASE, procedure)
    path = "/api/orpc/%s" % procedure
    body = json.dumps({"json": input_obj}, ensure_ascii=False).encode("utf-8")
    last_err = None

    for attempt in range(_RPC_RETRIES):
        try:
            _throttle()
            status, raw = _post_json(path, body, referer_path)
            if status >= 400:
                raise urllib.error.HTTPError(url, status, "HTTP %d" % status,
                                             None, None)
            # 206 + 空 body = 限流；视为可重试错误
            if not raw.strip():
                last_err = RuntimeError("空响应（疑似限流 206）")
                if attempt < _RPC_RETRIES - 1:
                    time.sleep(_RPC_BACKOFF * (2 ** attempt) + 1.0)
                    continue
                break
            env = json.loads(raw)
            if isinstance(env, dict) and "error" in env:
                # 应用层错误（如参数校验失败）：不重试
                last_err = RuntimeError("oRPC error: %r" % (env["error"],))
                break
            data = env.get("json") if isinstance(env, dict) else env
            if data is None:
                _rpc_failures.pop(procedure, None)
                return None  # 合法无结果，不缓存
            _cache_put(key, data)
            _rpc_failures.pop(procedure, None)
            return data
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
                ssl.SSLError, ConnectionError, json.JSONDecodeError, OSError,
                http.client.HTTPException) as e:
            last_err = e
            # keep-alive 的典型失效：连接在服务端空闲后被回收，客户端却以为
            # 还能用 → 复用时抛 SSLZeroReturnError / BrokenPipe / ConnectionReset
            # （均为 OSError/HTTPException 子类）。这类错误与内容无关，重试即可，
            # 且下次会拿到刚重建的新连接。丢弃坏连接必须在重试之前。
            _conn_drop()
            if attempt < _RPC_RETRIES - 1:
                time.sleep(_RPC_BACKOFF * (2 ** attempt))
                continue
            break

    # 实时请求全失败 → 陈旧缓存回退（限流空响应时最有用）
    cached, age = _cache_get(key)
    if cached is not None:
        sys.stderr.write("[bahn] %s 实时失败，使用 %.0fs 前缓存回退\n" % (procedure, age))
        return cached

    _rpc_failures[procedure] = time.time() + _RPC_COOLDOWN_SEC
    raise RuntimeError("bahn.expert %s failed after %d attempts: %s"
                       % (procedure, _RPC_RETRIES, last_err))


# --------------------------------------------------------------------------- #
# 公开 helper（保持与旧版同名同签名）                                          #
# --------------------------------------------------------------------------- #
def search_station(name: str, max_results: int = 1) -> list[dict]:
    """站点名 -> EVA 元数据。返回 [{evaNumber, name, ril100}]。"""
    res = _rpc("stopPlace/byTerm", {
        "searchTerm": name,
        "filterForIris": True,
        "max": max_results,
    }, referer_path="/")
    if not res:
        return []
    out = []
    for s in res:
        out.append({
            "evaNumber": s.get("evaNumber"),
            "name": s.get("name"),
            "ril100": s.get("ril100"),
        })
    return out


def find_journey(journey_number: int, category: str,
                 initial_departure_date: date | None = None,
                 eva_along_route: str | None = None,
                 administration: str | None = None) -> list[dict]:
    """按车次号 + 类别找班次实例。

    category 若给出，会传给服务端做精确过滤（避免 RE 8 / RB 8 / ICE 8 混淆）。
    eva_along_route（某沿途站 EVA）可把结果收敛到目标地区（实测 229 条 -> 1 条）。
    """
    inp: dict = {"journeyNumber": int(journey_number), "withOEV": True}
    if category:
        inp["category"] = category
    if eva_along_route:
        inp["evaNumberAlongRoute"] = str(eva_along_route)
    if administration:
        inp["administration"] = str(administration)
    if initial_departure_date is not None:
        d = datetime(initial_departure_date.year, initial_departure_date.month,
                     initial_departure_date.day, tzinfo=timezone.utc)
        inp["initialDepartureDate"] = d.isoformat().replace("+00:00", ".000Z")
    res = _rpc("journey/find", inp, referer_path="/")
    if not res:
        return []
    return res


def journey_details(journey_id: str) -> dict:
    """完整行程 + 每站实时到发延迟 + irisMessages（即 zugfinder 的 Bemerkungen）。"""
    ref = "/details/%s" % str(journey_id)
    return _rpc("journey/detailsByJourneyId", str(journey_id), referer_path=ref)


def journey_id_by_jid(jid: str, administration: str = "",
                      relevant_eva: str = "", relevant_time: str = "") -> dict:
    """由 IRIS jid 反查 journeyId（备用路径）。"""
    inp = {"jid": jid}
    if administration:
        inp["administration"] = administration
    if relevant_eva:
        inp["relevantEva"] = relevant_eva
    if relevant_time:
        inp["relevantTime"] = relevant_time
    return _rpc("journey/journeyIdByJid", inp, referer_path="/")


if __name__ == "__main__":
    print("== search_station('Berlin Hbf') ==")
    print(search_station("Berlin Hbf"))
    print("== find_journey(8, 'ECE') ==")
    fj = find_journey(8, "ECE")
    print("found:", len(fj) if isinstance(fj, list) else fj)
    if isinstance(fj, list) and fj:
        jid = fj[0].get("journeyId")
        print("journeyId:", jid)
        det = journey_details(jid)
        print(json.dumps(det, ensure_ascii=False, indent=1)[:2500] if det else det)
