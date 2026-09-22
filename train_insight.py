#!/usr/bin/env python3
"""train_insight.py —— 车次预测 + 逐站晚点汇总（供 traindelay webapp 调用）

数据源：zugfinder.net Pro 逐站接口（需账号，见 zugfinder_pro.py）。
逻辑：
  1. 登录 zugfinder Pro（凭据 account.txt）
  2. 拉取最近 N 天（含今天）该车逐站数据（zuginfo_json.php，每日期 1 请求）
  3. 计算明日预测：近 N 天终点延误窗口基线（点估计=中位数、P10/P90=分位数、
     P(>=15)/P(>=30)=历史频率、今日实际=最近一天终点延误）
  4. 输出 JSON 到 stdout 供 server.js 转发

用法：
  python train_insight.py ICE_847 [--days 10] [--cred K:/ZUGDATABASE/account.txt]
  python train_insight.py ICE_847 --json-pretty
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta

import numpy as np

# 引入 zugfinder_pro（与 webapp 的相对位置按需调整）
_HERE = os.path.dirname(os.path.abspath(__file__))
_DM = os.environ.get("DELAY_MODEL_DIR") or os.path.join(_HERE, "data", "delay_model")
if os.path.isdir(_DM):
    sys.path.insert(0, _DM)
else:
    sys.path.insert(0, _HERE)

try:
    from zugfinder_pro import ZugfinderPro, DEFAULT_CRED  # noqa: E402
except ImportError:
    # Keep the deployment self-contained when the optional client is supplied
    # through ZUGFINDER_PRO_DIR rather than copied into the webapp directory.
    _PRO_DIR = os.environ.get("ZUGFINDER_PRO_DIR")
    if _PRO_DIR and os.path.isdir(_PRO_DIR):
        sys.path.insert(0, _PRO_DIR)
    from zugfinder_pro import ZugfinderPro, DEFAULT_CRED  # noqa: E402

# zugfinder 限流窗口：单次连续请求 ≤ 8；超过触发人机验证（"Zu viele Abfragen"）
MAX_DAYS_PER_RUN = 8
# PieBro 本地历史库统计窗口（天）：本地 parquet 不受 zugfinder 限流，
# 用于把基线预测的样本窗口从 zugfinder 的 ≤8 天扩充到 60 天。
HIST_WINDOW_DAYS = 60
DEFAULT_DELAY = 2.0
CACHE_DIR = os.path.expanduser("~/.cache/zugfinder_pro")

# zugfinder z 键可用的商业车种前缀白名单。PieBro train_type 是运营商内部代码
# 大杂烩（NX/RSM/vlx/HLB/BRB... 同一条线路内混杂），白名单外的代码不能直接
# 拼成 z 键——退回用查询线路号的前缀（RE 11 的班次 26709 → RE_26709）。
_ZKEY_TRAIN_TYPES = {"RE", "RB", "ICE", "IC", "EC", "ECE", "FLX", "NJ", "EN",
                     "RJ", "RJX", "TGV", "ALX", "WB", "TL", "TLX", "IR",
                     "REX", "TER", "D"}


def _norm_train(train: str) -> str:
    """归一车次号（zugfinder 接口用）：空格/连字符→下划线。如 'RE 11' → 'RE_11'。

    zugfinder API 要求前缀与数字之间必须有下划线（RE7 返回空，RE_7 才有数据），
    因此在字母前缀后自动插入下划线。
    """
    import re
    t = str(train).strip().upper()
    t = t.replace(" ", "_").replace("-", "_")
    while "__" in t:
        t = t.replace("__", "_")
    # 确保字母前缀后有下划线：RE7 → RE_7, ICE847 → ICE_847
    t = re.sub(r"^([A-Z]+)(\d)", r"\1_\2", t)
    return t


def _norm_train_id(train: str) -> str:
    """归一车次号（内部/PieBro 用）：去所有分隔符。如 'RE 11' / 'RE-11' / 'RE_11' → 'RE11'。"""
    return _norm_train(train).replace("_", "")


def _end_delay(rows: list[dict]) -> float | None:
    """终点延误：最后一个有到站时刻的站点的 adelay。

    -1 哨兵（zugfinder：该站未到达，如 destination not reached）→ None。
    旧版返回 -1，被下游 max(v, 0) 钳成 0 —— 未到终点的超长晚点天
    （如 9/9 87min 中途折返）在历史图/分布里被显示成"准点 0 分钟"。
    """
    for x in reversed(rows):
        arr = str(x.get("arr", ""))
        if arr not in ("", "99:99"):
            try:
                v = float(x["adelay"])
            except (KeyError, TypeError, ValueError):
                return None
            return None if v == -1 else v
    return None


def _max_delay(rows: list[dict]) -> tuple[float | None, str]:
    best, st = None, ""
    for x in rows:
        try:
            v = float(x["adelay"])
        except (KeyError, TypeError, ValueError):
            v = None
        if v is not None and (best is None or v > best):
            best, st = v, x.get("bhf", "")
    return best, st


def collect(client: ZugfinderPro, train: str, days: int,
            gap: float = DEFAULT_DELAY, cred=None) -> list[dict]:
    """拉最近 days 天逐站，返回 [{date, rows, end_delay, max_delay, max_station, error}]。

    单次连续请求 ≤ MAX_DAYS_PER_RUN=8（zugfinder 限流阈值）；已拉过的日期优先从
    本地缓存 (~/.cache/zugfinder_pro/<train>/<date>.json) 读取，避免重复请求。

    并行（2026-09-23）：cred 给出且 ZF_FETCH_WORKERS>1 时走分片并行
    （_collect_parallel），每个线程用 cred 各自登录、独立 Session；仅本地
    未命中/需重拉的天发请求，输出与串行版逐字段一致。任何异常退回串行。
    """
    train = _norm_train(train)
    if cred is not None and ZF_FETCH_WORKERS > 1:
        try:
            return _collect_parallel(client, train, days, cred)
        except Exception as e:  # noqa: BLE001 —— 并行任何问题都退回串行
            print("WARNING: collect 并行路径失败（退回串行）: %s"
                  % str(e)[:120], file=sys.stderr, flush=True)
    return _collect_serial(client, train, days, gap)


def _collect_parallel(client: ZugfinderPro, train: str, days: int,
                      cred) -> list[dict]:
    """collect 的分片并行实现。假定 train 已归一；异常由调用方兜底退回串行。

    输出字段与 _collect_serial 完全一致（含 cached/pending_snapshot/error）。
    early_bail 语义按日期序复刻：跑完后顺序扫描，遇到连续 2 个限流/异常天，
    其后所有天（无论是否已抓到）一律改标 rate_limited 并丢弃数据——与串行版
    "剩余天不发请求"的输出一致，代价是最多多发 workers-1 个请求。
    """
    from concurrent.futures import ThreadPoolExecutor

    today = date.today()
    # ---- 阶段 1：本地计划（零网络）-------------------------------------
    # 与 _collect_serial 的 stale 判定完全一致（见其注释：当日快照次日过期，
    # 预算内重拉，最新优先）。
    stale_budget = 4
    stale_dates = []
    for i in range(days - 1, 0, -1):        # 不含今天（今天无"历史快照"概念）
        ds = (today - timedelta(days=i)).isoformat()
        cache_path = os.path.join(CACHE_DIR, train, ds + ".json")
        if os.path.exists(cache_path):
            try:
                mt = datetime.fromtimestamp(os.path.getmtime(cache_path)).date()
                if mt.isoformat() == ds:
                    stale_dates.append(ds)
            except Exception:  # noqa: BLE001
                pass
    stale_dates.sort(reverse=True)
    stale_allow = set(stale_dates[:stale_budget])

    results: dict[str, dict] = {}
    todo: list[str] = []                    # 需要网络的天（升序）
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        ds = d.isoformat()
        cache_path = os.path.join(CACHE_DIR, train, ds + ".json")
        handled = False
        if os.path.exists(cache_path):
            try:
                with open(cache_path, encoding="utf-8") as fh:
                    rows = json.load(fh)
                if isinstance(rows, list):
                    try:
                        mt = datetime.fromtimestamp(os.path.getmtime(cache_path)).date()
                        is_stale = (mt == d and ds != today.isoformat())
                    except Exception:  # noqa: BLE001
                        is_stale = False
                    if is_stale:
                        if ds in stale_allow:
                            todo.append(ds)          # 预算内 → 重拉
                        else:
                            # 超预算的历史快照：终点数据未定型 → 输出空行而非伪 0
                            results[ds] = {"date": ds, "rows": [], "end_delay": None,
                                           "max_delay": None, "max_station": "",
                                           "cached": True,
                                           "canceled": _is_day_canceled(rows),
                                           "pending_snapshot": True}
                    else:
                        results[ds] = {"date": ds, "rows": rows,
                                       "end_delay": _end_delay(rows),
                                       "max_delay": _max_delay(rows)[0],
                                       "max_station": _max_delay(rows)[1],
                                       "cached": True,
                                       "canceled": _is_day_canceled(rows)}
                    handled = True
            except Exception:  # noqa: BLE001
                pass                                  # 缓存损坏 → 当 miss
        if not handled:
            todo.append(ds)                          # miss → 实测拉取

    # 待抓天太少不值得并行：线程池 + N-1 次登录本身就是开销
    if len(todo) <= 2:
        raise RuntimeError("待抓天仅 %d，退回串行" % len(todo))

    # ---- 阶段 2：分片并行抓取 -------------------------------------------
    # 交错分片：todo[i::W] 让"最新的一天"分散在不同线程，用户最关心的数据
    # 不会挤在同一个队列里。
    workers = min(ZF_FETCH_WORKERS, len(todo))
    shards = [todo[k::workers] for k in range(workers)]

    def _one_shard(shard: list[str]) -> dict[str, dict]:
        cli = ZugfinderPro(cred)      # 每线程独立登录 → 独立 Session，互不共享
        local: dict[str, dict] = {}
        for j, ds in enumerate(shard):
            cache_path = os.path.join(CACHE_DIR, train, ds + ".json")
            is_refetch = os.path.exists(cache_path)
            d = date.fromisoformat(ds)
            if is_refetch:
                # stale 重拉：成功且不限流 → 更新缓存并采用；失败 → 沿用旧缓存
                try:
                    fresh = cli.zuginfo(train, ds)
                    _first = fresh[0] if fresh else {}
                    _arr = str(_first.get("arr", ""))
                    if fresh and "Zu viele Abfragen" not in _arr \
                            and "limitreaktivieren" not in _arr:
                        _atomic_write_json(cache_path, fresh)
                        local[ds] = {"date": ds, "rows": fresh,
                                     "end_delay": _end_delay(fresh),
                                     "max_delay": _max_delay(fresh)[0],
                                     "max_station": _max_delay(fresh)[1],
                                     "cached": True,
                                     "canceled": _is_day_canceled(fresh)}
                    else:
                        with open(cache_path, encoding="utf-8") as fh:
                            rows = json.load(fh)
                        local[ds] = {"date": ds, "rows": [], "end_delay": None,
                                     "max_delay": None, "max_station": "",
                                     "cached": True,
                                     "canceled": _is_day_canceled(rows),
                                     "pending_snapshot": True}
                except Exception:  # noqa: BLE001
                    try:
                        with open(cache_path, encoding="utf-8") as fh:
                            rows = json.load(fh)
                        local[ds] = {"date": ds, "rows": [], "end_delay": None,
                                     "max_delay": None, "max_station": "",
                                     "cached": True,
                                     "canceled": _is_day_canceled(rows),
                                     "pending_snapshot": True}
                    except Exception:  # noqa: BLE001
                        local[ds] = {"date": ds, "rows": [], "end_delay": None,
                                     "max_delay": None, "max_station": "",
                                     "error": "rate_limited"}
            else:
                # miss：实测拉取（限流标记/异常处理与串行版一致）
                try:
                    rows = cli.zuginfo(train, ds)
                    if not rows:
                        local[ds] = {"date": ds, "rows": [], "end_delay": None,
                                     "max_delay": None, "max_station": ""}
                    else:
                        first = rows[0] if rows else {}
                        arr = str(first.get("arr", ""))
                        if "Zu viele Abfragen" in arr or "limitreaktivieren" in arr:
                            local[ds] = {"date": ds, "rows": [], "end_delay": None,
                                         "max_delay": None, "max_station": "",
                                         "error": "rate_limited"}
                        else:
                            _atomic_write_json(cache_path, rows)
                            local[ds] = {"date": ds, "rows": rows,
                                         "end_delay": _end_delay(rows),
                                         "max_delay": _max_delay(rows)[0],
                                         "max_station": _max_delay(rows)[1],
                                         "canceled": _is_day_canceled(rows)}
                except Exception as e:  # noqa: BLE001
                    local[ds] = {"date": ds, "rows": [], "end_delay": None,
                                 "max_delay": None, "max_station": "",
                                 "error": str(e)[:80]}
            # 线程内串行间隔（分片最后一项后不再睡——原实现此处白睡 2s）
            if j < len(shard) - 1 and ZF_GAP_SEC > 0:
                time.sleep(ZF_GAP_SEC)
        return local

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for part in ex.map(_one_shard, shards):
            results.update(part)

    # ---- 阶段 3：按日期序复刻 early_bail 语义 ---------------------------
    out: list[dict] = []
    consec = 0
    dead = False
    for i in range(days - 1, -1, -1):
        ds = (today - timedelta(days=i)).isoformat()
        r = results.get(ds)
        if r is None:                       # 理论不可达：todo+缓存应全覆盖
            r = {"date": ds, "rows": [], "end_delay": None,
                 "max_delay": None, "max_station": "", "error": "rate_limited"}
        if dead:
            r = {"date": ds, "rows": [], "end_delay": None,
                 "max_delay": None, "max_station": "", "error": "rate_limited"}
        elif r.get("error"):
            consec += 1
            if consec >= 2:
                dead = True
        else:
            consec = 0
        out.append(r)
    return out


def _atomic_write_json(path: str, rows) -> None:
    """原子写 JSON（tmp + os.replace），避免并发/半写导致缓存损坏。永不抛异常。"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001
        pass


def _collect_serial(client: ZugfinderPro, train: str, days: int,
                    gap: float = DEFAULT_DELAY) -> list[dict]:
    """collect 的原始串行实现（2026-09-23 前的唯一路径），作并行兜底保留。"""
    # 归一车次号（确保前缀后有下划线：RE7 → RE_7）
    today = date.today()
    out: list[dict] = []
    last_limited = False
    consecutive_limited = 0  # 连续限流/异常天数；≥2 触发早停（节省死账号的请求）
    early_bail = False
    # 当日快照重拉预算（限流保护，2026-09-09 RE 8 缺柱 bug）：写入日 == 数据日的
    # 缓存 = 列车运行中/发车前时拉的快照（终点站 adelay 占位 0、尾部站 99:99），
    # 终到后 zugfinder 已补全（如 ICE 576 9/9：21:11 途中拉取全 0 占位，实际 84min
    # 晚点终到）。每次 collect 最多重拉 stale_budget 个。
    # 2026-09-12 修复：① 预算从 2 提到 4；② 重拉优先级从「从老到新」反转为
    # 「最新优先」——旧顺序会让最近的残缺快照（用户最关心）永远轮不到；
    # ③ 数据日当天写入的历史快照一律不信任：重拉失败时 end_delay/max_delay/rows
    # 置空输出（pending_snapshot），绝不把占位 0 当"准点"流出（伪 0 通病根除）。
    stale_budget = 4
    stale_dates = []
    for i in range(days - 1, -1, -1):
        ds = (today - timedelta(days=i)).isoformat()
        if ds == today.isoformat():
            continue
        cache_path = os.path.join(CACHE_DIR, train, ds + ".json")
        if os.path.exists(cache_path):
            try:
                mt = datetime.fromtimestamp(os.path.getmtime(cache_path)).date()
                if mt.isoformat() == ds:
                    stale_dates.append(ds)
            except Exception:
                pass
    stale_dates.sort(reverse=True)  # 最新优先：用户最关心 + zugfinder 已补全
    stale_allow = set(stale_dates[:stale_budget])
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        ds = d.isoformat()
        # 早停：已确认账号被限流 → 剩余天直接标 rate_limited，不发请求
        if early_bail:
            out.append({"date": ds, "rows": [], "end_delay": None,
                        "max_delay": None, "max_station": "",
                        "error": "rate_limited"})
            continue
        # 缓存
        cache_path = os.path.join(CACHE_DIR, train, ds + ".json")
        if os.path.exists(cache_path):
            try:
                with open(cache_path, encoding="utf-8") as fh:
                    rows = json.load(fh)
                if isinstance(rows, list):
                    # 缓存新鲜度：当日快照次日过期。预算内重拉；失败沿用旧缓存。
                    try:
                        mt = datetime.fromtimestamp(os.path.getmtime(cache_path)).date()
                        is_stale = (mt == d and ds != today.isoformat())
                    except Exception:
                        is_stale = False
                    if is_stale and ds in stale_allow:
                        try:
                            fresh_rows = client.zuginfo(train, ds)
                            _first = fresh_rows[0] if fresh_rows else {}
                            _arr = str(_first.get("arr", ""))
                            if fresh_rows and "Zu viele Abfragen" not in _arr \
                                    and "limitreaktivieren" not in _arr:
                                rows = fresh_rows
                                is_stale = False  # 重拉成功 → 数据已定型
                                _atomic_write_json(cache_path, rows)
                        except Exception:  # noqa: BLE001
                            pass  # 重拉失败 → 沿用旧缓存
                    if is_stale:
                        # 数据日当天写入、且重拉未成功的历史快照：终点数据未定型
                        # （占位 0 ≠ 实测准点）。输出空行而非伪 0，前端显示"无数据"，
                        # 下次查询继续尝试重拉补全。
                        out.append({"date": ds, "rows": [], "end_delay": None,
                                    "max_delay": None, "max_station": "",
                                    "cached": True,
                                    "canceled": _is_day_canceled(rows),
                                    "pending_snapshot": True})
                        continue
                    end = _end_delay(rows)
                    mx, st = _max_delay(rows)
                    out.append({"date": ds, "rows": rows, "end_delay": end,
                                "max_delay": mx, "max_station": st,
                                "cached": True,
                                "canceled": _is_day_canceled(rows)})
                    continue
            except Exception:  # noqa: BLE001
                pass
        # 实测拉取
        try:
            rows = client.zuginfo(train, ds)
            if not rows:
                out.append({"date": ds, "rows": [], "end_delay": None,
                            "max_delay": None, "max_station": ""})
                continue
            # 限流/验证码：返回行内夹 HTML 提示而非真实延误
            first = rows[0] if rows else {}
            arr = str(first.get("arr", ""))
            if "Zu viele Abfragen" in arr or "limitreaktivieren" in arr:
                out.append({"date": ds, "rows": [], "end_delay": None,
                            "max_delay": None, "max_station": "",
                            "error": "rate_limited"})
                consecutive_limited += 1
                if consecutive_limited >= 2:
                    early_bail = True
                continue
            end = _end_delay(rows)
            mx, st = _max_delay(rows)
            out.append({"date": ds, "rows": rows, "end_delay": end,
                        "max_delay": mx, "max_station": st,
                        "canceled": _is_day_canceled(rows)})
            last_limited = False
            consecutive_limited = 0
            # 写缓存（原子写：并行/多进程同写同一路径时防半文件）
            _atomic_write_json(cache_path, rows)
        except Exception as e:  # noqa: BLE001
            out.append({"date": ds, "rows": [], "end_delay": None,
                        "max_delay": None, "max_station": "",
                        "error": str(e)[:80]})
            last_limited = True
            consecutive_limited += 1
            if consecutive_limited >= 2:
                early_bail = True
        # 限流/异常后不 sleep，快速失败以便多账号轮换
        if not last_limited:
            time.sleep(gap)
    return out


# ---- 线路联邦州指纹：同名车次多线路识别（如 RE 11 在 NRW 与 Sachsen 各有一条）----
# 德国铁路车次号在全国范围内复用：同一个 "RE 11" 可能指 NRW 的
# Duisburg→Kassel 线，也可能是 Sachsen 的 Hoyerswerda→Leipzig 线。
# 若把两条线的历史混在一趟车里统计，预测与逐站展示会完全失真。
# 解法：用车站所属联邦州当作线路指纹，只合并同线的历史数据。
STATE_MAP_CSV = os.path.join(_HERE, "data", "reference", "anchor_bundesland.csv")
STATE_OVERRIDE_CSV = os.path.join(_HERE, "data", "reference",
                                  "station_state_overrides.csv")
STATION_ANCHOR_PQ = os.path.join(_HERE, "data", "db_database", "weather",
                                 "station_anchor_map.parquet")
_STATE_MAP = None
_STATE_OVERRIDES = None


def _load_state_overrides() -> dict:
    """已知 anchor 错配站的修正表：站名(小写) → 州。优先于 anchor 继承。"""
    global _STATE_OVERRIDES
    if _STATE_OVERRIDES is not None:
        return _STATE_OVERRIDES
    out: dict = {}
    try:
        with open(STATE_OVERRIDE_CSV, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                out[row["station_name"].strip().lower()] = row["bundesland_short"]
    except Exception:
        pass
    _STATE_OVERRIDES = out
    return out


def _load_state_map() -> dict:
    """站名(小写) → 联邦州简称。经 station_anchor_map 的 anchor 继承，惰性加载。"""
    global _STATE_MAP
    if _STATE_MAP is not None:
        return _STATE_MAP
    out: dict = {}
    try:
        import pandas as pd
        m = pd.read_parquet(STATION_ANCHOR_PQ, columns=["station_name", "anchor"])
    except Exception:
        _STATE_MAP = out
        return out
    bl = {}
    try:
        with open(STATE_MAP_CSV, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                bl[row["anchor"]] = row["bundesland_short"]
    except Exception:
        _STATE_MAP = out
        return out
    for name, anchor in zip(m["station_name"], m["anchor"]):
        b = bl.get(anchor)
        if isinstance(b, str):
            out[str(name).strip().lower()] = b
    _STATE_MAP = out
    return out


# DB 站名后缀 → 联邦州（优先于 anchor 继承，能纠正同名站误判：
# 如 Kamen 落在 NRW，却因 Sachsen 有同名站被 anchor 映射成 SN）
_SUFFIX_STATE = (
    ("(westf)", "NRW"), ("(ruhr)", "NRW"), ("(rhld)", "NRW"), ("(berg)", "NRW"),
    ("(niederrhein)", "NRW"), ("(sachs)", "SN"), ("(oberlausitz)", "SN"),
    ("(bay)", "BY"), ("(allgäu)", "BY"), ("(oberbay)", "BY"), ("(niederbay)", "BY"),
    ("(thür)", "TH"), ("(thuer)", "TH"), ("(oldb)", "NI"), ("(nieders)", "NI"),
    ("(holst)", "SH"), ("(meckl)", "MV"), ("(mark)", "BB"),
    ("(niederlausitz)", "BB"), ("(saale)", "ST"), ("(anhalt)", "ST"),
    ("(harz)", "ST"), ("(lahn)", "HE"), ("(hess)", "HE"), ("(odenw)", "HE"),
    ("(breisgau)", "BW"), ("(württ)", "BW"), ("(baden)", "BW"),
    ("(pfalz)", "RP"), ("(saar)", "SL"),
)


def station_state(name: str) -> str:
    """单个车站 → 联邦州简称；未知返回 ""。

    判定顺序：站名后缀（最可靠）→ station_anchor_map 的 anchor 继承。
    """
    if not name:
        return ""
    n = str(name).strip().lower()
    ov = _load_state_overrides().get(n)
    if ov:
        return ov
    for suf, st in _SUFFIX_STATE:
        if suf in n:
            return st
    return _load_state_map().get(n, "")


def _smooth_states(stations) -> list:
    """站序邻居众数平滑：修正孤立误判站。

    station_anchor_map 里存在 anchor 错配（如 NRW 的 Kamen 被挂到 Sachsen 的
    Görlitz，连 region 也跟着错）。这类站的特点是：线路上前后邻居都在同一个
    州，只有它自己"跳"到别的州。用 ±2 邻居的州众数（≥2 票）把它拉回来。
    """
    raw = [station_state(s) for s in stations or []]
    if len(raw) < 3:
        return raw
    out = list(raw)
    for i, st in enumerate(raw):
        if not st:
            continue
        left = [x for x in raw[max(0, i - 2):i] if x]
        right = [x for x in raw[i + 1:i + 3] if x]
        # 只修正"被两侧同州包围"的孤立站；末端站（如终点 Kassel 在 Hessen，
        # 前一站还在 NRW）不修正，否则会把真实跨州终点抹掉
        if not left or not right:
            continue
        tl, nl = Counter(left).most_common(1)[0]
        tr, nr = Counter(right).most_common(1)[0]
        if tl == tr and tl != st and (nl + nr) >= 3:
            out[i] = tl
    return out


def line_states(stations, top_k: int = 4, min_share: float = 0.05) -> set:
    """车站列表 → 主体联邦州集合。

    先做邻居平滑消除同名站误判，再按票数取 top_k 且 ≥ 最高票 min_share 的州，
    只保留线路真正经过的联邦州。
    """
    c = Counter(b for b in _smooth_states(stations) if b)
    if not c:
        return set()
    # 阈值相对最高票州：主线州票数远高于跨线噪声（后者通常只有 1~2 个站）
    top = c.most_common(1)[0][1]
    return {st for st, n in c.most_common(top_k) if n >= top * min_share}


# ---- PieBro 历史降级（zugfinder 限流时使用）----
PIEBRO_DIR = os.environ.get("PIEBRO_DIR", os.path.join(_HERE, "data", "piebro"))


def _piebro_dates(days: int) -> list[str]:
    today = date.today()
    out = []
    for i in range(days - 1, -1, -1):
        out.append((today - timedelta(days=i)).isoformat())
    return out


def _parse_piebro_datetime(s) -> "datetime | None":
    s = str(s or "")
    if not s or s == "NaT": return None
    try:
        return datetime.fromisoformat(s.replace("T", " ").split("+")[0].split(".")[0])
    except Exception:  # noqa: BLE001
        return None


# ---- PieBro 结果磁盘缓存（2026-09-23）--------------------------------------
# 起因：冷查询端到端 16~34s 的剖析显示 collect_piebro_fallback 被调用多次
# （含 main 里 60 天历史窗口那次），单次 2.3~4.7s，且 parquet 常驻读取是纯浪费。
#
# 为什么用磁盘而不是进程内 dict：常驻 worker 已占 3.25GB RssAnon / 8GB cgroup，
# 结果集（8~60 天的逐站行）驻留内存会持续累积。磁盘缓存让内存零增长，
# 且 spawn 式降级进程也能共享。这与 _load_line_trip_templates 的思路一致。
#
# 失效条件（任一即失效）：
#   - parquet 文件指纹变化（数据更新）
#   - 超过 24h TTL（兜底：防止同名文件原地重写导致指纹不变）
_PIEBRO_CACHE_DIR = os.path.expanduser("~/.cache/train_insight_piebro")
_PIEBRO_CACHE_TTL = 24 * 3600


def _piebro_cache_key(train: str, days: int) -> str:
    return "%s__%d" % (_norm_train_id(train) or "invalid", days)


def _piebro_cache_fp() -> str:
    return "|".join(_piebro_recent_files())


def _piebro_cache_get(name: str):
    """命中返回缓存值（list 或 dict），未命中/损坏返回 None。永不抛异常。"""
    fp = os.path.join(_PIEBRO_CACHE_DIR, name + ".json")
    try:
        with open(fp, encoding="utf-8") as f:
            rec = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(rec, dict):
        return None
    if rec.get("key") != _piebro_cache_fp():
        return None   # parquet 已更新 → 重算
    if time.time() - rec.get("ts", 0) > _PIEBRO_CACHE_TTL:
        return None
    data = rec.get("data")
    return data if isinstance(data, (list, dict)) else None


def _piebro_cache_put(name: str, data: list) -> None:
    """原子落盘（tmp + os.replace），避免并发写坏。永不抛异常。"""
    try:
        os.makedirs(_PIEBRO_CACHE_DIR, exist_ok=True)
        fp = os.path.join(_PIEBRO_CACHE_DIR, name + ".json")
        tmp = fp + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"key": _piebro_cache_fp(), "ts": time.time(), "data": data},
                      f, ensure_ascii=False)
        os.replace(tmp, fp)
    except Exception:  # noqa: BLE001
        pass


def collect_piebro_fallback(train: str, days: int = 30) -> list[dict]:
    """限流降级：从 PieBro 历史聚合该车次的**完整逐站延误**（无需登录/外部依赖）。

    匹配策略（读取时谓词下推，避免一次性加载全量 Parquet 触发 OOM）：
      1. train_number 完全匹配（ICE/IC/FLX 的 line_number 字段在 PieBro 全空）
      2. line_number 完全匹配（RB/RE，PieBro 中以 "RE11"/"RB33" 形式无空格存储）

    返回 recs 与 collect() 同结构（rows 字段含真实站序 + 计划时刻 + 延误），
    让 /api/train 输出能直接渲染逐站曲线与今日时刻表。

    性能（2026-09-23）：本函数一次请求内会被调用多次（含 60 天历史窗口），
    实测单次 2.3~4.7s，叠起来是除去网络抓取之外最大的热点。故加磁盘结果缓存，
    键为 (车次, 天数) + parquet 文件指纹；详见 _piebro_cache_get/_put。
    """
    _ck = _piebro_cache_key(train, days)
    _hit = _piebro_cache_get(_ck)
    if _hit is not None:
        return _hit
    _res = _collect_piebro_uncached(train, days)
    # 只有真正取到数据才落盘：空结果可能只是 parquet 尚未更新，缓存它会让
    # 「下次就有的数据」被 24h 挡住。
    if _res:
        _piebro_cache_put(_ck, _res)
    return _res


def _collect_piebro_uncached(train: str, days: int = 30) -> list[dict]:
    """collect_piebro_fallback 的实际计算部分（无缓存，纯读 parquet）。"""
    target_ln = _norm_train_id(train)
    if not target_ln:
        return []
    if not os.path.isdir(PIEBRO_DIR):
        return []
    try:
        import pyarrow.parquet as pq
        import pyarrow.compute as pc
        import pandas as pd
    except ImportError:
        return []
    tp_prefix = None
    num = target_ln
    for pre in ("ICE", "FLX", "RE", "RB", "IC"):
        if target_ln.startswith(pre):
            tp_prefix = pre
            num = target_ln[len(pre):]
            break
    files = sorted(f for f in os.listdir(PIEBRO_DIR)
                   if f.startswith("data-") and f.endswith(".parquet"))
    files = files[-2:] if len(files) > 2 else files
    if not files:
        return []
    cols_needed = ["line_number", "train_number", "train_type", "train_line_ride_id",
                   "train_line_station_num", "station_name", "time", "delay_in_min",
                   "arrival_planned_time", "departure_planned_time"]
    # 谓词下推 + 类型限定（pyarrow 读取阶段过滤，避免 1400 万行全量载入）
    #   BUG FIX：train_number 是线路内唯一的吗？不是——S3 S-Bahn 也有 train_number=3743，
    #   与 RE 3743 同号。此前 `train_number == num` 会把 S3 的 ride 混进来，
    #   `sample=max(rides,key=len)` 又总是选 S3 的 19 站 → 页面显示成柏林市区 S-Bahn。
    #   修复：train_number 匹配必须同时满足 train_type == tp_prefix（RE/RB/IC/ICE/FLX）。
    #   line_number 匹配保留但同样校验 train_type（若该行有 train_type 字段）。
    exprs = []
    if num and tp_prefix:
        # 只有同类型才匹配车号（排除 S3 3743 等撞号列车）
        exprs.append((pc.field("train_number") == num) & (pc.field("train_type") == tp_prefix))
    elif num:
        exprs.append(pc.field("train_number") == num)
    if target_ln:
        exprs.append(pc.field("line_number") == target_ln)
    filt = exprs[0] if len(exprs) == 1 else (exprs[0] | exprs[1])
    by_day: dict[str, list] = {}
    for fp in files:
        full = os.path.join(PIEBRO_DIR, fp)
        try:
            tbl = pq.read_table(full, columns=cols_needed, filters=filt)
        except Exception:
            tbl = None
        if tbl is None or tbl.num_rows == 0:
            continue
        df = tbl.to_pandas()
        # 二次防线：type 过滤（防御 pyarrow filter 未生效/数据缺 type 的场景）
        if tp_prefix and "train_type" in df.columns and df["train_type"].notna().any():
            df = df[df["train_type"].astype(str).str.strip().str.upper() == tp_prefix]
        df["delay"] = pd.to_numeric(df["delay_in_min"], errors="coerce")
        df = df[df["delay"].notna()]
        df["date"] = df["time"].astype(str).str[:10]
        df = df.sort_values(["date", "train_line_ride_id", "train_line_station_num"])
        for (ds, rid), g in df.groupby(["date", "train_line_ride_id"]):
            g = g.sort_values("train_line_station_num")
            stops = []
            end_delay = None
            max_delay = None
            max_st = ""
            last_sn = -1
            for _, srow in g.iterrows():
                sn = int(srow["train_line_station_num"]) if pd.notna(srow["train_line_station_num"]) else 0
                if sn <= last_sn:
                    continue
                last_sn = sn
                sname = str(srow["station_name"] or "")
                dly = float(srow["delay"])
                arr_hhmm = _fmt_hhmm(srow.get("arrival_planned_time"))
                dep_hhmm = _fmt_hhmm(srow.get("departure_planned_time"))
                adelay = int(round(dly))
                stops.append({"bhf": sname, "arr": arr_hhmm, "adelay": str(adelay),
                              "dep": dep_hhmm, "ddelay": str(adelay), "zeit": ""})
                end_delay = dly
                if max_delay is None or dly > max_delay:
                    max_delay = dly
                    max_st = sname
            if stops:
                by_day.setdefault(ds, []).append({
                    "ride": str(rid), "stops": stops,
                    "end_delay": end_delay, "max_delay": max_delay,
                    "max_station": max_st,
                })
    available_dates = sorted(by_day.keys())
    recent_dates = available_dates[-days:]
    out = []
    for ds in recent_dates:
        rides = by_day.get(ds)
        if not rides:
            out.append({"date": ds, "rows": [], "end_delay": None,
                        "max_delay": None, "max_station": "", "source": "piebro"})
            continue
        ends = [r["end_delay"] for r in rides if r["end_delay"] is not None]
        end_val = float(round(sum(ends) / max(1, len(ends)), 1)) if ends else None
        max_val = max((r["max_delay"] for r in rides if r["max_delay"] is not None),
                      default=None)
        max_st = next((r["max_station"] for r in rides
                       if r["max_delay"] is not None and r["max_delay"] == max_val), "")
        sample = max(rides, key=lambda r: len(r["stops"]))
        # all_stops：当天所有 ride 的站名→延误 合并（供 destination 匹配，避免只查 sample 漏掉目标站）
        all_stops = {}
        day_canceled = any(r.get("canceled") for r in rides)
        for r in rides:
            for s in r["stops"]:
                key = s["bhf"].strip().lower()
                if key and key not in all_stops:
                    try:
                        all_stops[key] = float(s["adelay"])
                    except (TypeError, ValueError):
                        pass
        out.append({"date": ds, "rows": sample["stops"], "end_delay": end_val,
                    "max_delay": max_val, "max_station": max_st, "source": "piebro",
                    "all_stops": all_stops, "canceled": day_canceled})
    return out


# ---- 多班次日 rows 整理：复用线路号的 zugfinder 聚合页拆分 ----
# zugfinder 的 z=<线路名>（如 RE_13）返回**当天全部班次**交错的停靠行
# （NRW 段 06:02 的车与东段 12:06 的车混在同一份 rows，甚至同一行
# arr=13:00/dep=06:02 自相矛盾）。直接用会污染：站序基准横跨走向、
# 逐站时刻表时刻穿插、指纹跨线剔除失效。这里用 PieBro 的单班次站序
# 作模板对齐整理（保留 zugfinder 实测延误）；单班次线路天然单调，
# 检测不触发、零开销。

def _hhmm_to_min(v) -> "int | None":
    import re as _re_mod
    s = str(v or "").strip()
    m = _re_mod.match(r"^(\d{1,2}):(\d{2})$", s)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h >= 24 or mi > 59:   # 99:99 哨兵
        return None
    return h * 60 + mi


def _norm_station_for_align(s) -> str:
    import re as _re_mod
    return _re_mod.sub(r"[^a-zäöüß0-9]", "", str(s or "").lower())


def _rows_look_mixed(rows: list) -> bool:
    """dep 时刻出现 >15 分钟回跳 → 多班次混合（单班次站序时间单调）。"""
    prev = None
    for x in rows:
        t = _hhmm_to_min(x.get("dep"))
        if t is None:
            t = _hhmm_to_min(x.get("arr"))
        if t is None:
            continue
        if prev is not None and t < prev - 15:
            return True
        prev = t
    return False


def _piebro_recent_files() -> list:
    """PieBro 数据目录最近的 2 个 data-*.parquet 文件名（缓存指纹用）。"""
    if not os.path.isdir(PIEBRO_DIR):
        return []
    return sorted(f for f in os.listdir(PIEBRO_DIR)
                  if f.startswith("data-") and f.endswith(".parquet"))[-2:]


_TEMPLATE_CACHE_DIR = os.path.expanduser("~/.cache/train_insight_templates")
_TEMPLATE_CACHE_TTL = 24 * 3600  # 兜底 TTL：防止 parquet 同名原地重写导致指纹不变


def _load_line_trip_templates(train: str, top_n: int = 10) -> list:
    """`_compute_line_trip_templates` 的文件缓存包装。

    parquet 全量重算实测 2.7~10.8s/次（RE 1 最重），而模板只随 PieBro
    数据文件更新（按文件名指纹失效，另加 24h TTL 兜底）。spawn 式进程
    每次请求都要重读 parquet，缓存把这部分降到毫秒级。
    """
    if top_n != 10:  # 非默认参数走直算，不进缓存
        return _compute_line_trip_templates(train, top_n)
    cache_fp = os.path.join(_TEMPLATE_CACHE_DIR,
                            (_norm_train_id(train) or "invalid") + ".json")
    key = "|".join(_piebro_recent_files())
    cached = None
    try:
        with open(cache_fp, encoding="utf-8") as f:
            cached = json.load(f)
    except Exception:
        cached = None
    if (cached and cached.get("key") == key
            and isinstance(cached.get("templates"), list)
            and time.time() - cached.get("ts", 0) < _TEMPLATE_CACHE_TTL):
        return cached["templates"]
    tmpls = _compute_line_trip_templates(train, top_n)
    try:
        os.makedirs(_TEMPLATE_CACHE_DIR, exist_ok=True)
        tmp_fp = cache_fp + ".tmp"
        with open(tmp_fp, "w", encoding="utf-8") as f:
            json.dump({"key": key, "ts": time.time(), "templates": tmpls}, f)
        os.replace(tmp_fp, cache_fp)  # 原子替换，防并发 spawn 写坏
    except Exception:
        pass  # 缓存写失败不影响主流程
    return tmpls


def _compute_line_trip_templates(train: str, top_n: int = 10) -> list:
    """PieBro 该线路的班次站序模板（按站序去重，覆盖各走向）。

    返回 [{"norms": [归一化站名], "deps": [计划发车分钟], "count": 出现天数}]，
    按出现天数降序。复用号线路每天多条 ride（走向×班次），相同站序跨天
    重复出现 → count 即该走向的开行频率。
    """
    target_ln = _norm_train_id(train)
    if not target_ln or not os.path.isdir(PIEBRO_DIR):
        return []
    try:
        import pyarrow.parquet as pq
        import pyarrow.compute as pc
        import pandas as pd
    except ImportError:
        return []
    files = sorted(f for f in os.listdir(PIEBRO_DIR)
                   if f.startswith("data-") and f.endswith(".parquet"))[-2:]
    if not files:
        return []
    try:
        frames = []
        for fp in files:
            tbl = pq.read_table(
                os.path.join(PIEBRO_DIR, fp),
                columns=["line_number", "train_number", "train_type",
                         "train_line_ride_id", "train_line_station_num",
                         "station_name", "departure_planned_time"],
                filters=pc.field("line_number") == target_ln)
            if tbl.num_rows:
                frames.append(tbl.to_pandas())
        if not frames:
            return []
        df = pd.concat(frames, ignore_index=True)
    except Exception:
        return []
    if df.empty:
        return []
    seq_count: dict = {}
    seq_deps: dict = {}
    for _, g in df.groupby("train_line_ride_id"):
        g = g.sort_values("train_line_station_num")
        bhfs, tmins, seen = [], [], set()
        for _, srow in g.iterrows():
            sn = srow["train_line_station_num"]
            if pd.isna(sn) or int(sn) in seen:
                continue
            seen.add(int(sn))
            nm = _norm_station_for_align(srow["station_name"])
            if not nm:
                continue
            bhfs.append(nm)
            dep = pd.to_datetime(srow["departure_planned_time"], errors="coerce")
            tmins.append((dep.hour * 60 + dep.minute) if pd.notna(dep) else -1)
        if len(bhfs) >= 5:
            key = tuple(bhfs)
            seq_count[key] = seq_count.get(key, 0) + 1
            seq_deps.setdefault(key, tmins)
    ranked = sorted(seq_count.items(), key=lambda kv: -kv[1])[:top_n]
    return [{"norms": list(k), "deps": seq_deps[k], "count": c}
            for k, c in ranked if c >= 3]


def _align_rows_to_template(rows: list, tmpl: dict) -> list:
    """把混合 rows 对齐到模板站序：同站多班次行按时刻最近选位，
    按模板序输出；沿模板序做时刻最长非递减子序列（LIS）筛选，剔除
    属于其他班次/反向走向的杂散行。返回整理后的行子集。

    严格单调（零容差）是关键：错误方向模板会把反向班次的行排成持续
    回跳序列（如东向班次对齐到西向模板），对齐结果被 LIS 大幅削减，
    干净模板以覆盖行数自然胜出，避免两个班次的行被缝合成"伪单班次"；
    3 分钟内的取整毛刺由 LIS 自动绕开（丢 1 行换全链单调）。"""
    norms, deps = tmpl["norms"], tmpl["deps"]
    n = len(norms)
    by_pos: dict = {}
    for x in rows:
        xn = _norm_station_for_align(x.get("bhf"))
        if not xn:
            continue
        t = _hhmm_to_min(x.get("dep"))
        if t is None:
            t = _hhmm_to_min(x.get("arr"))
        best = None  # ((name_cost, dt), pos)
        for pi in range(n):
            tn = norms[pi]
            if xn == tn:
                cost = 0
            elif len(xn) >= 4 and (tn.startswith(xn) or xn.startswith(tn)):
                cost = 1
            else:
                continue
            # 无有效时刻的行（99:99 哨兵）给最大时刻惩罚但保留位置匹配
            dt = abs((t if t is not None else 1440 + deps[pi]) - deps[pi])
            key = (cost, dt)
            if best is None or key < best[0]:
                best = (key, pi)
        if best is None:
            continue
        pos = best[1]
        dt = best[0][1]
        if pos not in by_pos or dt < by_pos[pos][0]:
            by_pos[pos] = (dt, t, x)
    # 沿模板序做时刻最长非递减子序列（LIS）筛选——单行歧义数据（如
    # Bitterfeld dep 拼接错班次）会毒化贪心剔除的后续链，LIS 可绕开毒点
    # 保留其后真正的同班次行。无有效时刻的行（99:99 哨兵）不参与链，
    # 且名称/位置已匹配，一律保留以不丢失延误数据。
    items = [(pos, by_pos[pos][1], by_pos[pos][2]) for pos in sorted(by_pos)]
    timed = [i for i, it in enumerate(items) if it[1] is not None]
    keep = set(timed)
    if timed:
        ts = [items[i][1] for i in timed]
        m = len(ts)
        dp = [1] * m
        par = [-1] * m
        for a in range(m):
            for b in range(a):
                if ts[b] <= ts[a] and dp[b] + 1 > dp[a]:
                    dp[a] = dp[b] + 1
                    par[a] = b
        end = max(range(m), key=lambda i: dp[i])
        chain = set()
        while end != -1:
            chain.add(end)
            end = par[end]
        keep = {timed[i] for i in chain}
    aligned = [items[i][2] for i in range(len(items)) if i in keep]
    return aligned


def _fallback_longest_time_segment(rows: list) -> "list | None":
    """无模板可用时的回退：按时刻排序切段，取最长连续段（保原行序）。"""
    def _t(i):
        return (_hhmm_to_min(rows[i].get("dep"))
                or _hhmm_to_min(rows[i].get("arr")))
    idx = sorted(range(len(rows)),
                 key=lambda i: (_t(i) if _t(i) is not None else 10 ** 6, i))
    segs, cur, prev = [], [], None
    for i in idx:
        t = _t(i)
        if t is not None and prev is not None and t < prev - 15:
            segs.append(cur)
            cur = []
        cur.append(i)
        if t is not None:
            prev = t
    if cur:
        segs.append(cur)
    if not segs:
        return None
    main_seg = max(segs, key=len)
    return [rows[i] for i in sorted(main_seg)]


def _normalize_daily_trip_rows(recs: list, train: str) -> list:
    """整理每天的 rows：复用线路号（RE 13 等）的 zugfinder 线路级查询返回
    当天全部班次的交错行，污染站序/时刻表/指纹——对齐到单班次再往下走。

    回跳检测（>15 分钟）只能抓"站序错乱"的混合天；当天多个班次按时间
    有序拼接（如 RE 13 某日 05:41 Senftenberg → 14:25 Hamm → 20:06
    Magdeburg 顺序连排）或并发班次小回跳交错时检测不出。故有模板时对
    每天统一做模板对齐探测，按数据状态分派：

      - 混合天（回跳命中）：最佳对齐 ≥4 行且覆盖 ≥25% 即采用；
        覆盖不足说明班次走向不在模板集中 → 时刻切段回退；
      - 时间有序/小回跳天（回跳漏检）：对齐显著瘦身（最佳覆盖 < 原行数
        70%）且 ≥5 行才采用——干净单班次天对齐覆盖≈全量，不会误伤；
      - 无模板（非复用号线路）：仅对回跳命中的天做时刻切段回退。
    """
    if not recs:
        return recs
    templates = _load_line_trip_templates(train)
    for r in recs:
        rows = r.get("rows") or []
        if len(rows) < 6:
            continue
        mixed_flag = _rows_look_mixed(rows)
        fixed = None
        if templates:
            best_rows, best_cov = None, 0
            for tmpl in templates:
                aligned = _align_rows_to_template(rows, tmpl)
                if len(aligned) > best_cov:
                    best_rows, best_cov = aligned, len(aligned)
            if mixed_flag:
                if best_cov >= 4 and best_cov >= len(rows) * 0.2:
                    fixed = best_rows
            elif best_cov >= 5 and best_cov < len(rows) * 0.7:
                fixed = best_rows
        if fixed is None and mixed_flag:
            fixed = _fallback_longest_time_segment(rows)
        if fixed and len(fixed) >= 4 and fixed != rows:
            r["rows"] = fixed
            r["rows_normalized"] = True
            r["end_delay"] = _end_delay(fixed)
            mx, st = _max_delay(fixed)
            r["max_delay"], r["max_station"] = mx, st
    return recs


def _today_snapshot_partial(today_row: dict | None,
                            hist_rows_counts: list[int]) -> bool:
    """判断「今日行」是否为**不可信/未终到**的部分快照，需要走 DB 实时补正。

    背景（2026-09-18 实测 ICE 847）：zugfinder 对"今日"返回的快照可能在列车
    运行早期生成，**只包含已开行的前若干站**（当天 7 站止于 Hamm，adelay=3；
    完整行程 13 站至 Berlin Südkreuz）。而 `_end_delay()` 会把这条截断快照的
    末站延误当成"终点延误"，使今日行 `end_delay` 非 None —— 旧判据
    `end_delay is None` 因此为假，整段实时补正被跳过，页面长期停留在早上的错值。

    判据（任一命中即视为 partial）：
      - 今日行不存在，或 end_delay 为 None；
      - 已由本函数的调用方向 db_realtime 补正过且已终到 → 不再重复抓取；
      - 今日 rows 站数**少于历史满站数**（截断特征）。

    历史满站数由调用方传入（`hist_rows_counts`），**不依赖 `stations`**：
    `stations` 在 main() 中算出（约 2280 行）晚于本判定，存在时序倒挂。
    """
    if not today_row:
        return True
    if today_row.get("end_delay") is None:
        return True
    # 已用 DB 实时数据填充且已终到（end_delay 非空）→ 无需再抓
    if (today_row.get("source") or "") == "db_realtime" \
            and not today_row.get("_db_running"):
        return False
    full = max(hist_rows_counts) if hist_rows_counts else 0
    if full >= 3:
        n_today = len(today_row.get("rows") or [])
        if n_today < full:
            return True
    return False


def _is_day_canceled(rows: list[dict]) -> bool:
    """检测某日是否整班取消。

    zugfinder Pro 对取消车次的约定：所有站的 adelay 返回字符串 "-1"（哨兵值，
    非"提前 1 分钟"）。判定唯一依赖该哨兵占比：

      - 有数据行（非空 rows）
      - 超过半数站的 adelay == "-1"

    重要：绝不可把"全 0"（adelay 全为 "0"，即准点 / 无实时数据的占位行）误判为
    取消——首站 arr=="99:99" 且其余全 0 在正常运行车次上极常见（始发站无到站、
    当日准点），此前曾因把 "0" 纳入取消签名而误杀正常车次（见举一反三审计）。
    真正的取消必有显著数量的 "-1" 哨兵，故以 -1 占比为唯一判据即可稳健区分。

    PieBro 数据用 is_canceled 布尔字段，在 collect_piebro_fallback 里单独处理。
    """
    if not rows:
        return False
    n = len(rows)
    neg1 = sum(1 for r in rows if str(r.get("adelay", "")).strip() == "-1")
    # 取消 = 多数站携带 -1 哨兵；全 0 / 混合 0 一律不算取消
    return neg1 > 0 and neg1 > n * 0.5


def _fmt_hhmm(v) -> str:
    """datetime/str → 'HH:MM'；空/NaT 返回 '—'."""
    if v is None:
        return "—"
    if hasattr(v, "__class__") and v.__class__.__name__ == "NaTType":
        return "—"
    s = str(v)
    if len(s) >= 16 and (s[10] == "T" or s[10] == " "):
        return s[11:16]
    return s if s else "—"

def _parse_dt(v) -> "datetime | None":
    """ISO 字符串/ datetime → 带时区的 datetime（若有 Z/offset 则保留 tzinfo）。

    用于「按完整时刻（含日期）判定列车是否已收车」——只取 HH:MM 会在跨天时误判。
    解析失败返回 None（调用方据此跳过判定，不做激进假设）。
    """
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    s = str(v).strip()
    if not s or s == "—":
        return None
    try:
        # 处理结尾 Z（fromisoformat 在 3.11 支持，但兜底替换以兼容更早版本）
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        try:
            return datetime.fromisoformat(s.replace("T", " ").split("+")[0].split(".")[0])
        except Exception:  # noqa: BLE001
            return None

def _age_seconds(dt) -> "float | None":
    """dt 距今多少秒（正数=已过去，负数=尚未发生）。

    关键点：tz-aware 与 naive 不能相减（会抛 TypeError）。这里把 now 取到与 dt
    **相同**的时区再比，两类输入都能安全处理（2026-09-23 踩坑记录）。
    """
    if dt is None:
        return None
    now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now()
    return (now - dt).total_seconds()

def collect_with_fallback(client, train, days, gap):
    """collect 限流时自动从 PieBro 历史降级"""
    recs = collect(client, train, days, gap)
    n_valid = sum(1 for r in recs if r.get("end_delay") is not None)
    n_limited = sum(1 for r in recs if r.get("error") == "rate_limited")
    n_empty = sum(1 for r in recs if r.get("rows") and r.get("end_delay") is None)
    # 触发降级条件：限流 >= 一半 或 所有天都 end_delay=None（API 返回空数据但无明确错误）
    if n_limited >= max(1, days // 2) or n_valid == 0:
        piebro = collect_piebro_fallback(train, days)
        if piebro and any(r.get("end_delay") is not None for r in piebro):
            extra = [r for r in recs if r.get("end_delay") is not None]
            recs = piebro + extra
    return recs


# ---- 备用账号池：主账号限流解不掉时轮换 ----
# 路径解析优先级：环境变量 ZUGFINDER_ACCOUNT_POOL（os.pathsep 分隔，可多账号）
# → 部署目录 secrets/（存在才启用）→ 旧版 Windows K 盘位置（向后兼容，保留）。
_ACCOUNT_POOL_ENV = tuple(
    p.strip() for p in os.environ.get("ZUGFINDER_ACCOUNT_POOL", "").split(os.pathsep)
    if p.strip()
)
_ACCOUNT_POOL_LOCAL = tuple(
    p for p in (os.path.join(_HERE, "secrets", f) for f in ("ac2.txt", "ac(2).txt"))
    if os.path.exists(p)
)
ACCOUNT_POOL_FILES = (
    _ACCOUNT_POOL_ENV
    or _ACCOUNT_POOL_LOCAL
    or (r"K:/ZUGDATABASE/ac2.txt", r"K:/ZUGDATABASE/ac(2).txt")
)

# 主凭据默认路径：环境变量 ZUGFINDER_CRED → 部署目录 secrets/account.txt → 旧 K 盘
_local_cred = os.path.join(_HERE, "secrets", "account.txt")
CRED_DEFAULT = (os.environ.get("ZUGFINDER_CRED")
                or (_local_cred if os.path.exists(_local_cred) else None)
                or DEFAULT_CRED)


def _looks_like_metadata(s: str) -> bool:
    """账号文件里的「非密码」行特征（到期日 / 订阅状态等）。"""
    t = s.lower()
    return ("bis " in t) or ("dein status" in t) or ("zugfinder" in t)


def _load_account_pool(verbose: bool = False) -> list[tuple[str, str]]:
    """读取备用账号池（email / password）。

    兼容两种实际格式：
      - 两行一组：email / password
      - 三行一组：email / password / 到期日（如 "bis 26.08"）

    以「含 @ 的行」为账号起点，取下一行为密码，然后跳到下一个含 @ 的行，
    中间的元信息行自动跳过。解析后做自检：密码位不得是邮箱或元信息。
    """
    out: list[tuple[str, str]] = []
    for path in ACCOUNT_POOL_FILES:
        if not os.path.exists(path):
            continue
        lines = [l.strip() for l in
                 open(path, encoding="utf-8", errors="replace") if l.strip()]
        n = len(lines)
        i = 0
        while i < n:
            if "@" not in lines[i] or i + 1 >= n:
                i += 1
                continue
            email, pw = lines[i], lines[i + 1]
            # 自检：密码位不该是邮箱，也不该是「bis 26.08」这类元信息。
            # 命中说明文件排版变了（例如 email 后面多了备注行），此时不再
            # 猜，直接告警并停止解析该文件，避免把错位凭据用于线上抓取。
            if "@" in pw or _looks_like_metadata(pw):
                print("WARNING: 账号文件 %s 格式异常，第 %d 行起的凭据疑似错位，"
                      "已跳过该文件。请检查排版。" % (path, i + 1),
                      file=sys.stderr, flush=True)
                break
            out.append((email, pw))
            i += 2
            while i < n and "@" not in lines[i]:
                i += 1  # 跳过到期日 / 状态等元信息行
        if verbose:
            print("  [账号池] %s -> 本轮累计 %d 个" % (path, len(out)))
    return out


def _env_int(name: str, default: int) -> int:
    """读整型环境变量，非法值静默回落默认。"""
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


# ---- collect 并行抓取（2026-09-23）------------------------------------------
# 起因：冷查询剖析显示 collect 的 8 天串行循环独占 ~16s，其中大头是
# 「每天拉完无条件 time.sleep(gap=2.0)」——8 天全 miss 就是 16s 纯睡眠。
# 改为分片并行：把待抓日期交错分给 N 个线程，每个线程持**独立的 ZugfinderPro
# 会话**（requests.Session 非线程安全，绝不能共享；且同账号并发 unfreeze 有竞态
# ——vendor/zugfinder_pro.py:122 的解封是 GET→POST 两段式），线程内部串行+
# 间隔，线程之间并行。墙钟时间 ≈ ceil(todo/workers) × (gap+请求)。
#
# 为什么是「每线程一个会话、同账号多次登录」而不是「多账号」：
#   - 账号轮换是 collect_multi_account 的职责，语义是"账号挂了换号"，
#     与"加速单账号抓取"是两回事，混在一起会让限流归因变糊涂。
#   - zugfinder 的会话是 cookie 级，同账号多会话 ≈ 同一账号开多个浏览器；
#     服务端按账号计数限流，总请求数不变，只是时间压缩。
#
# 安全阀：
#   - workers 可用 ZUGFINDER_FETCH_WORKERS 调回 1（= 完全串行）
#   - 待抓天 ≤2 时直接串行，省掉线程池与 N-1 次登录的开销
#   - 并行路径任何异常 → 静默退回原串行实现（_collect_serial 原样保留）
#   - 限流频率若上升（日志盯 zu viele abfragen / unfreeze），先把 workers 调 2
ZF_FETCH_WORKERS = max(1, min(4, _env_int("ZUGFINDER_FETCH_WORKERS", 3)))
try:
    ZF_GAP_SEC = max(0.0, float(os.environ.get("ZUGFINDER_GAP_SEC", "1.5")))
except ValueError:
    ZF_GAP_SEC = 1.5


# 多账号轮换上限：账号池有 29 个备用，但每账号冷跑要 8 天 × gap≈16s，
# 无脑放大到 29 会让最坏耗时冲到 460s+（前端 160s 就超时了）。
# 因此用「数量上限 + 时间预算」双闸门兜底：先到者生效。
MAX_ACCOUNTS = _env_int("ZUGFINDER_MAX_ACCOUNTS", 16)
MAX_ACCOUNT_SECONDS = _env_int("ZUGFINDER_MAX_ACCOUNT_SECONDS", 140)

# 无覆盖车次快速失败（2026-09-17）：连续 N 个账号「登录成功、未被限流、
# 但一个有效延误数据都取不到」→ 判定该车次不被 zugfinder 覆盖，提前终止轮换。
#
# 背景：境外车次（如 IC 56 Villach→Praha，实测 zugfinder 无数据）或不存在的
# 车次，旧逻辑会一路轮换到 16 账号上限 / 140s 预算耗尽才返回「无数据」，
# 实测 45~60s —— 用户干等一分钟只换来一句「没数据」。
# 实际上 2~3 个不同账号都取不到，基本就能确认「不是账号问题，是这趟车没数据」。
#
# 关键：被限流的账号**不计入**（error == "rate_limited"）。限流换账号可能有效，
# 若一并计入会把「账号被限流」误判成「车次不覆盖」，反而丢失本可取到的数据。
EMPTY_ACCOUNT_LIMIT = _env_int("ZUGFINDER_EMPTY_ACCOUNT_LIMIT", 3)


def collect_multi_account(train: str, days: int, gap: float = DEFAULT_DELAY,
                          primary_cred: str = DEFAULT_CRED,
                          max_accounts: int = None) -> list[dict]:
    """实时采集（多账号轮换）：主账号 → 备用账号池 → 全部失败才降级 PieBro。

    每个账号先跑 collect()；只要有 ≥1 天有效数据即采用。
    限流解不掉（含自动填 8 失败）的账号会快速失败跳过，控制总耗时。

    轮换深度由三道闸门共同决定，先到者生效：
      - max_accounts / ZUGFINDER_MAX_ACCOUNTS（默认 16）——尝试账号数上限
      - MAX_ACCOUNT_SECONDS / ZUGFINDER_MAX_ACCOUNT_SECONDS（默认 140s）——耗时预算，
        给前端 160s 超时留 20s 余量，避免"轮换还没跑完，浏览器先断了"。
      - EMPTY_ACCOUNT_LIMIT / ZUGFINDER_EMPTY_ACCOUNT_LIMIT（默认 3）——连续这么多个
        账号「登录成功且未限流却零数据」即判定车次不被覆盖，提前收工（2026-09-17
        新增：境外/不存在车次原本要空转到 16 账号或 140s 才说"没数据"）。
    """
    if max_accounts is None:
        max_accounts = MAX_ACCOUNTS
    creds = [primary_cred] + _load_account_pool()
    last_recs: list[dict] = []
    tried = 0
    login_fail = 0
    empty_clean = 0   # 连续「登录成功 + 未限流 + 零数据」的账号数（快速失败用）
    _t0 = time.time()
    for idx, cred in enumerate(creds):
        if tried >= max_accounts:
            print("INFO: 已达账号尝试上限 %d，剩余 %d 个账号跳过"
                  % (max_accounts, len(creds) - tried),
                  file=sys.stderr, flush=True)
            break
        if tried and (time.time() - _t0) > MAX_ACCOUNT_SECONDS:
            print("INFO: 账号轮换耗时预算 %.0fs 已用尽（已试 %d 个），停止轮换"
                  % (MAX_ACCOUNT_SECONDS, tried), file=sys.stderr, flush=True)
            break
        tried += 1
        try:
            client = ZugfinderPro(cred)
        except Exception as e:  # noqa: BLE001
            login_fail += 1
            if idx == 0:
                print("WARNING: 主账号登录失败: %s" % e,
                      file=sys.stderr, flush=True)
            else:
                print("WARNING: 备用账号登录失败（第 %d 个）: %s"
                      % (idx, str(e)[:60]), file=sys.stderr, flush=True)
            continue
        recs = collect(client, train, days, gap, cred=cred)
        if any(r.get("end_delay") is not None for r in recs):
            if idx > 0:
                print("INFO: 主账号限流，已切换到第 %d 个备用账号"
                      "（共 %d 个，用时 %.0fs）"
                      % (idx, len(creds) - 1, time.time() - _t0),
                      file=sys.stderr, flush=True)
            return recs
        # 快速失败：登录成功、全程未被限流，却一个有效数据都没取到 →
        # 基本可确认「不是账号问题，是这趟车 zugfinder 没数据」。
        # 被限流的账号不计入（换账号可能有效，不能误判成车次不覆盖）。
        if not any(r.get("error") == "rate_limited" for r in recs):
            empty_clean += 1
            if empty_clean >= EMPTY_ACCOUNT_LIMIT:
                print("INFO: 连续 %d 个账号登录成功但未取到任何数据（且无限流），"
                      "判定车次 %s 不被 zugfinder 覆盖，提前终止轮换"
                      "（已试 %d 个，用时 %.0fs）"
                      % (empty_clean, train, tried, time.time() - _t0),
                      file=sys.stderr, flush=True)
                break
        last_recs = recs
    # 账号池健康度：登录失败占比过高时告警（密码过期 / 改密 / 文件损坏）
    if login_fail and login_fail >= max(3, tried // 3):
        print("WARNING: 账号池健康度异常——%d/%d 个已试账号登录失败，"
              "建议检查 secrets/ 下账号文件是否有过期或改密。"
              % (login_fail, tried), file=sys.stderr, flush=True)
    # 全部账号失败 → PieBro 历史降级（最后手段）
    piebro = collect_piebro_fallback(train, days)
    if piebro and any(r.get("end_delay") is not None for r in piebro):
        extra = [r for r in last_recs if r.get("end_delay") is not None]
        return piebro + extra
    return last_recs


# ---- 唯一列车号解析 / 取消概率 / 德铁次日开行校验 ----

def _hhmm_min(s: str) -> int:
    """'HH:MM' → 分钟（用于时间接近度匹配）。"""
    try:
        h, m = s.strip().split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return 0


def resolve_ride(line: str, from_st: str, time_hhmm: str = "",
                 day: str | None = None, to_st: str = "") -> dict:
    """线路 + 始发站 + 发车时间 → 唯一列车号（train_number / ride_id）。

    PieBro 中同线路每天有多班（不同发车时刻各有独立 train_number，如 RE7 → 17034），
    按 line_number + 日期 + 始发站停靠时刻最接近定位具体班次（作用①）。
    day 缺省取 PieBro 最近有数据的一天。
    to_st（2026-09-10）：终点站方向约束——同线同刻常有反方向班次
    （如 Karlsruhe↔Neustadt (Weinstr) 16:00 双向都停），旧版只比时刻差会选中
    反向车，预测走向整个反了。给出 to_st 时仅接受「起点→终点」正向覆盖的班次；
    且时刻差 >90 分钟视为不匹配（PieBro 大概率没收录这趟车，宁可放弃具体班次，
    也不要错认成同名异线的班次——RE 1 Dresden 段曾错配到 Saarlouis 同名线）。
    """
    target_ln = _norm_train_id(line)
    if not target_ln or not from_st:
        return {}
    if not os.path.isdir(PIEBRO_DIR):
        return {}
    try:
        import pyarrow.parquet as pq
        import pyarrow.compute as pc
        import pandas as pd
    except ImportError:
        return {}
    files = sorted(f for f in os.listdir(PIEBRO_DIR)
                   if f.startswith("data-") and f.endswith(".parquet"))
    files = files[-2:] if len(files) > 2 else files
    files = list(reversed(files))  # 最新文件优先
    if not files:
        return {}
    cols = ["line_number", "train_number", "train_type", "train_line_ride_id",
            "train_line_station_num", "station_name", "time", "is_canceled"]
    tgt = from_st.strip().lower()
    best = None
    for fp in files:
        full = os.path.join(PIEBRO_DIR, fp)
        try:
            tbl = pq.read_table(full, columns=cols,
                                filters=pc.field("line_number") == target_ln)
        except Exception:
            continue
        df = tbl.to_pandas()
        if df.empty:
            continue
        df["date"] = df["time"].astype(str).str[:10]
        if day:
            df = df[df["date"] == day]
            if df.empty:
                continue
        else:
            day_use = df["date"].max()
            df = df[df["date"] == day_use]
        for rid, g in df.groupby("train_line_ride_id"):
            g = g.sort_values("train_line_station_num")
            recs_l = list(g.to_dict("records"))
            names_l = [str(r["station_name"]).strip().lower() for r in recs_l]
            fi = names_l.index(tgt) if tgt in names_l else -1
            if fi < 0:
                continue
            # 方向约束：终点必须在该班次停靠序列中且位于起点之后
            if to_st:
                tgt_to = to_st.strip().lower()
                ti = names_l.index(tgt_to) if tgt_to in names_l else -1
                if ti < 0 or ti <= fi:
                    continue
            stop_t = str(recs_l[fi]["time"])[11:16]
            diff = abs(_hhmm_min(stop_t) - _hhmm_min(time_hhmm)) if time_hhmm else 0
            cand = {
                "train_number": (str(g["train_number"].dropna().iloc[0])
                                 if g["train_number"].notna().any() else ""),
                # train_type（RE/RB/...）：zugfinder z 键必须带类型前缀（RE_26709），
                # 纯数字 z=26709 恒返回空——见 main() 的 z 键构造修复。
                "train_type": (str(g["train_type"].dropna().iloc[0]).strip().upper()
                               if "train_type" in g.columns
                               and g["train_type"].notna().any() else ""),
                "ride_id": str(rid),
                "date": str(g["date"].iloc[0]),
                "dep_time": stop_t,
                "from_station": from_st,
                "stations": [str(r["station_name"]) for r in recs_l],
                "canceled": bool(g["is_canceled"].any()),
                "_diff": diff,
            }
            if best is None or diff < best["_diff"]:
                best = cand
        if best is not None:
            break  # 已找到，用最近文件的结果
    # 时刻差上限：diff 过大 = PieBro 大概率没收录这趟车（或只收录了同名线的
    # 另一个州变体），宁可放弃具体班次走显式降级，也不要错认（RE 1 Dresden 段
    # 曾因此错配 Saarlouis 同名线，预测报告整个落在错误的走向上）。
    if best and best["_diff"] > 90:
        return {}
    if best:
        best.pop("_diff", None)
    return best or {}


def list_rides(line: str) -> list:
    """线路全部班次号映射（查车次列表页卡片展示用，2026-09-10 用户需求：
    列表里显示 RE 62037 这样的具体班次号）。

    扫 PieBro 最近 parquet，按 line_number 过滤，按 train_line_ride_id 聚合：
    每个班次输出 {from: 首站, dep: 首站发车 HH:MM, num: train_number, days: 出现天数}。
    与 timetable（webapp 本地时刻表）是两个数据源，站名写法/时刻可能差一点，
    所以 server 端匹配用「归一站名 + 时刻差 ≤10 分钟取最近」，匹配不上留空。
    """
    target_ln = _norm_train_id(line)
    if not target_ln or not os.path.isdir(PIEBRO_DIR):
        return []
    try:
        import pyarrow.parquet as pq
        import pyarrow.compute as pc
    except ImportError:
        return []
    files = sorted(f for f in os.listdir(PIEBRO_DIR)
                   if f.startswith("data-") and f.endswith(".parquet"))[-2:]
    if not files:
        return []
    cols = ["line_number", "train_number", "train_line_ride_id",
            "train_line_station_num", "station_name", "time"]
    agg: dict = {}  # ride_id → {from, dep, num, dates:set}
    for fp in files:
        full = os.path.join(PIEBRO_DIR, fp)
        try:
            tbl = pq.read_table(full, columns=cols,
                                filters=pc.field("line_number") == target_ln)
        except Exception:
            continue
        df = tbl.to_pandas()
        if df.empty:
            continue
        df["date"] = df["time"].astype(str).str[:10]
        for rid, g in df.groupby("train_line_ride_id"):
            g = g.sort_values("train_line_station_num")
            r0 = g.iloc[0]
            num = (str(g["train_number"].dropna().iloc[0])
                   if g["train_number"].notna().any() else "")
            if not num or num.lower() == "nan":
                continue
            dep = str(r0["time"])[11:16]
            if not _hhmm_to_min(dep):  # NaT / 99:99 哨兵 / 非 HH:MM（00:00 视为有效）
                if dep != "00:00":
                    continue
            frm = str(r0["station_name"]).strip()
            key = str(rid)
            cur = agg.get(key)
            if cur is None:
                agg[key] = {"from": frm, "dep": dep, "num": num,
                            "dates": {str(r0["date"])}}
            else:
                cur["dates"].add(str(r0["date"]))
    out = [{"from": v["from"], "dep": v["dep"], "num": v["num"],
            "days": len(v["dates"])} for v in agg.values()]
    out.sort(key=lambda x: x["dep"])
    return out


def cancel_prob_piebro(train: str, days: int = 30,
                       main_states: set | None = None,
                       train_number: str | None = None) -> dict:
    """取消概率：PieBro is_canceled 统计（最近 N 天该 line/车次的取消比例）。

    口径（统一）:
      * 观测单位 = 一个「班次」(date, train_line_ride_id)，不是「天」。
        旧版把班次误标成 n_days（RE 11 曾显示 7308「天」），此处拆成
        n_rides / n_dates 两个字段，UI 只展示 n_rides。
      * 起始站（最小 station_num）is_canceled=True 视为该班取消。
      * 同名车次跨线剔除：若给出 main_states（线路联邦州指纹），只保留
        站点所属州与主线重合度 ≥60% 的班次，避免把另一条同名线（如 RE 11
        的 Hoyerswerda↔Leipzig 线）的取消率混进来。
    注：完全取消且数据未收录的班次无法识别，结果为「有记录班次」中的取消率。

    性能（2026-09-23）：与 collect_piebro_fallback 一样每次都重扫 parquet，
    实测 1.5s/次。套用同款磁盘结果缓存（指纹 + 24h TTL）。
    """
    _ck = _piebro_cache_key(train, days) + "__cancel"
    # main_states 参与计算结果（跨线剔除），必须进 key —— 否则不同指纹的调用
    # 会互串缓存，返回错误取消率。
    if main_states:
        _ck += "__st" + hashlib.sha1(
            ",".join(sorted(str(s) for s in main_states)).encode()).hexdigest()[:10]
    _hit = _piebro_cache_get(_ck)
    if _hit is not None:
        return _hit
    _res = _cancel_prob_uncached(train, days, main_states)
    if _res.get("n_rides"):
        _piebro_cache_put(_ck, _res)
    return _res


def _cancel_prob_uncached(train: str, days: int = 30,
                          main_states: set | None = None) -> dict:
    """cancel_prob_piebro 的实际计算部分（无缓存）。"""
    target_ln = _norm_train_id(train)
    if not target_ln or not os.path.isdir(PIEBRO_DIR):
        return _empty_cancel_prob()
    try:
        import pyarrow.parquet as pq
        import pyarrow.compute as pc
        import pandas as pd
    except ImportError:
        return _empty_cancel_prob()
    # PieBro 匹配候选：ICE/IC/FLX 无 line_number → train_number；
    # RE/RB 既可能是线路号(RE 11)也可能是单班次车号(RE 62037) → 两种都试，
    # 取第一个有数据的候选，否则单班次查询会永远匹配不到（旧版只试 line_number）。
    tp = None
    for pre in ("ICE", "FLX", "IC", "RE", "RB"):
        if target_ln.startswith(pre):
            tp = pre
            break
    dig = target_ln[len(tp):] if tp else target_ln
    if tp in ("ICE", "IC", "FLX"):
        cands = [("train_number", dig)]
    elif tp in ("RE", "RB"):
        cands = [("line_number", target_ln) if dig.isdigit() and len(dig) <= 2
                 else ("train_number", dig)]
        cands.append(("train_number", dig) if cands[0][0] == "line_number"
                     else ("line_number", target_ln))
    else:
        cands = [("train_number", target_ln)]
    files = sorted(f for f in os.listdir(PIEBRO_DIR)
                   if f.startswith("data-") and f.endswith(".parquet"))
    files = files[-2:] if len(files) > 2 else files
    best = None
    for col, val in cands:
        res = _piebro_cancel_stats(files, col, val, days, main_states)
        if res["n_rides"]:
            best = res
            break
        if best is None:
            best = res
    src = ("piebro_same_line" if main_states else "piebro_line")
    if (not best or not best["n_rides"]) and main_states:
        # 兜底：联邦州判定不全可能把整条线误杀（宁可放宽也不要显示「无数据」）
        for col, val in cands:
            res = _piebro_cancel_stats(files, col, val, days, None)
            if res["n_rides"]:
                best, src = res, "piebro_line_fallback"
                break
    if not best or not best["n_rides"]:
        return _empty_cancel_prob()
    return {"prob": round(best["n_canceled"] / best["n_rides"], 4),
            "n_rides": best["n_rides"],
            "n_dates": len(best["dates"]),
            "n_days": len(best["dates"]),
            "n_canceled": best["n_canceled"],
            "cross_line_rides_dropped": best["dropped"],
            "matched_on": best["col"],
            "source": src}


def _piebro_cancel_stats(files, col, val, days, main_states) -> dict:
    """按 (col=val) 扫描 PieBro 分片, 统计同线班次的取消数"""
    import pyarrow.parquet as pq
    import pyarrow.compute as pc
    import pandas as pd
    total = 0            # 纳入统计的班次数
    canceled = 0
    all_dates: set[str] = set()
    dropped_cross_line = 0
    for fp in files:
        full = os.path.join(PIEBRO_DIR, fp)
        try:
            tbl = pq.read_table(full, columns=[col, "train_line_ride_id",
                                               "train_line_station_num", "time",
                                               "is_canceled", "station_name"],
                                filters=pc.field(col) == val)
        except Exception:
            continue
        df = tbl.to_pandas()
        if df.empty:
            continue
        df["date"] = df["time"].astype(str).str[:10]
        dates = sorted(df["date"].unique())[-days:]
        df = df[df["date"].isin(dates)]
        if df.empty:
            continue
        df["sn"] = pd.to_numeric(df["train_line_station_num"], errors="coerce")
        # 每个班次的州覆盖（用于跨线剔除）
        if main_states:
            uniq = df["station_name"].dropna().unique()
            smap = {s: station_state(s) for s in uniq}
            df["_st"] = df["station_name"].map(smap)
            cov = df.groupby(["date", "train_line_ride_id"])["_st"].apply(
                lambda s: (_cov_share(s, main_states)))
            df = df.merge(cov.rename("_cov"), left_on=["date", "train_line_ride_id"],
                          right_index=True, how="left")
            bad = df["_cov"] < 0.6
            dropped_cross_line += int(df.loc[bad, ["date", "train_line_ride_id"]]
                                      .drop_duplicates().shape[0])
            df = df[~bad]
            if df.empty:
                continue
        first = (df.sort_values(["date", "train_line_ride_id", "sn"])
                   .groupby(["date", "train_line_ride_id"], as_index=False)
                   .first())
        total += len(first)
        canceled += int(first["is_canceled"].sum())
        all_dates |= set(first["date"].unique())
    return {"n_rides": total, "n_canceled": canceled, "dates": all_dates,
            "dropped": dropped_cross_line, "col": col}


def _cov_share(states: "pd.Series", main_states: set) -> float:
    """班次内已知联邦州的站点中, 落在主线州内的比例"""
    known = [s for s in states if s]
    if not known:
        return 0.0
    return sum(1 for s in known if s in main_states) / len(known)


def _empty_cancel_prob(source: str = "none") -> dict:
    return {"prob": None, "n_rides": 0, "n_dates": 0, "n_days": 0,
            "n_canceled": 0, "cross_line_rides_dropped": 0, "source": source}


def db_next_day_check(line: str, from_st: str, to_st: str,
                      date_iso: str, time_hhmm: str) -> dict:
    """德铁官方次日开行校验（实验）：查目标日期该车次是否运行/被取消。

    走 bahn.de 行程查询 API（HAFAS v3 /reiseauskunft/v3/journeys）。
    任何失败/网络不可达 → status=unknown（不阻塞预测）。
    """
    if not (line and from_st and to_st and date_iso):
        return {"status": "unknown", "note": "参数不足"}
    try:
        import requests
    except ImportError:
        return {"status": "unknown", "note": "requests 不可用"}
    DB_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": DB_UA,
                          "Accept": "application/json,text/plain,*/*",
                          "Accept-Language": "de-DE,de;q=0.9,en;q=0.6"})
        s.get("https://www.bahn.de", timeout=20)  # 拿会话 cookie

        def extid(name: str) -> str:
            r = s.get("https://www.bahn.de/web/api/reiseloesung/orte",
                      params={"suchbegriff": name}, timeout=20)
            r.raise_for_status()
            locs = r.json() if isinstance(r.json(), list) else []
            if not locs:
                raise ValueError("DB 站解析失败: %r" % name)
            return str(locs[0].get("extId") or "")

        frm = extid(from_st)
        to = extid(to_st)
        body = {
            "from": {"extId": frm, "name": from_st},
            "to": {"extId": to, "name": to_st},
            "departure": {"time": time_hhmm or "00:00", "date": date_iso,
                          "dateTime": date_iso + "T" + (time_hhmm or "00:00"),
                          "timeType": "DEPARTURE"},
            "passengers": [{"type": "E"}],
            "searchMode": "ACCESSIBLE",
            "tripSearchMode": "COMFORT",
            "onlyDirectTrains": True,
            "national": True,
            "regional": True,
            "bike": False,
            "scheduledDays": "Y",
        }
        r = s.post("https://www.bahn.de/web/api/reiseauskunft/v3/journeys",
                   json=body, timeout=25)
        if r.status_code != 200:
            return {"status": "unknown", "note": "DB HTTP %d" % r.status_code}
        data = r.json()
        want = line.upper().replace(" ", "")
        journeys = data.get("journeys", []) or []
        if not journeys:
            return {"status": "unknown", "note": "德铁计划中暂无该时段直达"}
        for j in journeys:
            for leg in (j.get("legs") or []):
                nm = (leg.get("name") or "").upper().replace(" ", "")
                if nm == want and not leg.get("alternative"):
                    canceled = bool(leg.get("canceled"))
                    note = ("⚠️ 德铁已取消该班次日运行，预测无意义"
                            if canceled else "德铁次日计划正常")
                    return {"status": "canceled" if canceled else "confirmed",
                            "note": note}
        return {"status": "unknown", "note": "未匹配到该车次（可能当日不运行）"}
    except Exception as e:  # noqa: BLE001
        return {"status": "unknown", "note": "DB 查询失败: %s" % str(e)[:80]}


def db_realtime_train(train: str, date_iso: str = "",
                      stations: list[str] | None = None,
                      from_st: str = "", to_st: str = "") -> dict:
    """德铁官方实时数据（运行中列车）。

    改用 bahn.expert tRPC（IRIS 实时后端，免密钥、免登录）作为可靠实时源，
    替代此前不稳定/已被拦截的 bahn.de 网页 API。流程：
      1) 解析车次类别+编号（RE_3743 -> ('RE', 3743)）
      2) journey.find 定位今日该车次实例 -> journeyId
      3) journey.detailsByJourneyId 取全程逐站计划/实际到发 + 实时延误
      4) 映射为与 zugfinder 一致的 row 结构（bhf/arr/adelay/dep/ddelay/zeit）
    仅在「目标日期 == 今天」时查询（历史日期无实时意义）。
    若 bahn.expert 不可达或该车今日不运行，返回空 rows（交由上游保留 PieBro 降级）。
    """
    from datetime import date as _date

    today_str = _date.today().isoformat()
    target_date = date_iso or today_str
    if target_date < today_str:
        return {"rows": [], "end_delay": None, "max_delay": None,
                "error": "非当日，无需实时数据", "source": "db_realtime"}

    # 解析类别 + 编号
    cat, num = _split_train(train)

    try:
        from db_bahn_expert import find_journey, journey_details  # noqa: E402
    except Exception as e:  # noqa: BLE001
        return {"rows": [], "end_delay": None, "max_delay": None,
                "error": "bahn.expert 模块加载失败: %s" % str(e)[:60],
                "source": "db_realtime"}

    try:
        journeys = find_journey(num, cat)
        if not journeys:
            return {"rows": [], "end_delay": None, "max_delay": None,
                    "error": "bahn.expert 未找到今日该车次（可能已收车/不运行）",
                    "source": "db_realtime"}
        jid = journeys[0].get("journeyId")
        if not jid:
            return {"rows": [], "end_delay": None, "max_delay": None,
                    "error": "bahn.expert 返回 journeyId 为空", "source": "db_realtime"}

        det = journey_details(jid)
        stops = det.get("stops") or []
        if not stops:
            return {"rows": [], "end_delay": None, "max_delay": None,
                    "error": "bahn.expert 未返回停站数据", "source": "db_realtime"}

        # "列车当前位置"的权威来源 = 最后一个 isRealTime=True 的站（最近已通过/已出发的站）。
        # 注意 currentStop 的语义陷阱（2026-09-18 livelist 真值验证）：
        #   currentStop 指向**下一个未来到站**（其 arrival.time 恒 > now），并非物理当前位置；
        #   若直接拿它的 delay 当"当前延误"，实为前方站的计划/预测值，会系统性失真。
        #   真实当前位置 = 最后一个 isRealTime=True 的站；currentStop 仅作"全程尚无实时站"时的兜底。
        # 备选位置字段：lastKnownPosition（无 currentStop 时使用）。
        cur = det.get("currentStop") or {}
        cur_name = ((cur.get("stopPlace") or {}).get("name") or "").strip()
        if not cur_name:
            lkp = det.get("lastKnownPosition") or {}
            cur_name = ((lkp.get("stopPlace") or {}).get("name") or "").strip()

        rows = []
        realtime_seen = False
        terminal_realtime = False  # 终点站是否已有实时数据（列车已终到/正在终点）
        # 终点站计划到达的**原始带日期值**（跨天判定必需）——见下方 journey_finished。
        _dest_raw = None
        # 运行中补正：跟踪"最后一个有实时延误的站" = 列车当前位置 + 当前延误
        last_rt_delay: int | None = None
        last_rt_station = ""
        # 收车判定辅助：最近一次实时事件时刻 / 是否存在"未来的实时事件"
        _last_rt_dt = None
        _any_future_rt = False
        # 站名 → (adelay, ddelay)，供兜底（currentStop/lastKnownPosition）命中时取延误
        stop_delay_map: dict[str, tuple[int | None, int | None]] = {}
        for i, s in enumerate(stops):
            sp = s.get("stopPlace") or {}
            name = sp.get("name") or ""
            arr = s.get("arrival") or {}
            dep = s.get("departure") or {}
            adelay = arr.get("delay")
            ddelay = dep.get("delay")
            if adelay is not None or ddelay is not None:
                realtime_seen = True
            stop_delay_map[name.strip()] = (
                int(adelay) if adelay is not None else None,
                int(ddelay) if ddelay is not None else None,
            )
            # 记录"最近一次实时事件"→ 判定列车是否仍在推进（见 journey_finished）
            for _ev in (arr, dep):
                if not (_ev.get("isRealTime") and (_ev.get("time") or _ev.get("scheduledTime"))):
                    continue
                _ev_dt = _parse_dt(_ev.get("time"))
                _ev_age = _age_seconds(_ev_dt)
                if _ev_age is None:
                    continue
                if _ev_age < 0:
                    _any_future_rt = True   # 仍有"未来"的实时事件 → 列车还在跑
                elif _last_rt_dt is None or (_age_seconds(_last_rt_dt) or 0) > _ev_age:
                    _last_rt_dt = _ev_dt
            if i == len(stops) - 1:
                # 终点站计划到达时刻（优先 arrival，回退 departure）。必须保留**原始带日期值**：
                # 只取 HH:MM 会丢日期，跨天时误判（昨晚 12:20 到站的车，今天看 HH:MM 会当成
                # "今天 12:20 尚未到"）——见下方 journey_finished。
                _dest_raw = (arr.get("time") or arr.get("scheduledTime")
                             or dep.get("time") or dep.get("scheduledTime"))
            if arr.get("isRealTime") or dep.get("isRealTime"):
                v = None
                if adelay is not None:
                    v = int(adelay)
                elif ddelay is not None:
                    v = int(ddelay)
                if v is not None:
                    last_rt_delay = v
                    last_rt_station = name
                if i == len(stops) - 1:
                    terminal_realtime = True
            rows.append({
                "bhf": name,
                "arr": _fmt_hhmm(arr.get("time") or arr.get("scheduledTime")) if (arr.get("time") or arr.get("scheduledTime")) else "—",
                "adelay": str(int(adelay)) if adelay is not None else "0",
                "dep": _fmt_hhmm(dep.get("time") or dep.get("scheduledTime")) if (dep.get("time") or dep.get("scheduledTime")) else "—",
                "ddelay": str(int(ddelay)) if ddelay is not None else "0",
                "zeit": "",
                "_is_real_time": bool(arr.get("isRealTime") or dep.get("isRealTime")),
                "_cancelled": bool(arr.get("cancelled") or dep.get("cancelled")),
            })

        # 终点延误：仅当终点站已有实时数据（列车已到终点/正在终点）时有效。
        # 未终到（终点站 isRealTime=False，adelay 为占位 "0"）→ end_delay=None，
        # 避免把"占位 0/当前站延误"误当终点延误污染历史统计。
        end_delay = None
        if terminal_realtime:
            for r in reversed(rows):
                try:
                    v = int(r["adelay"])
                except ValueError:
                    v = None
                if v is not None:
                    end_delay = v
                    break
            if end_delay is None:
                for r in reversed(rows):
                    try:
                        v = int(r["ddelay"])
                    except ValueError:
                        v = None
                    if v is not None:
                        end_delay = v
                        break

        mx, mx_st = _max_delay(rows)

        # 清理内部字段
        for r in rows:
            r.pop("_is_real_time", None)
            r.pop("_cancelled", None)

        # 位置/延误：优先"最后一个 isRealTime 站"（真实当前位置），
        # 回退 currentStop/lastKnownPosition（仅当全程尚无实时站，取计划延误占位）。
        # 已终到时不设 current_*（列车不在"运行中"状态）。
        #
        # 终止判定（2026-09-21 修复「已开完还显示 当前 N 分」）：
        #   terminal_realtime 只反映"终点站是否带 isRealTime 标记"，而列车终到后
        #   上游常**不再刷新终点站**的实时标记 → 该值为 False，导致仍输出 current_delay，
        #   前端就一直显示"当前 N 分"。
        #   实测样例（ICE 847）：末站 Berlin Südkreuz 的到达是**前一天** 12:20 且无实时，
        #   而前一个站 Berlin Hbf 仍是 isRealTime=True/delay=47，于是 last_rt 命中它，
        #   次日凌晨查询仍输出「当前 47 分」。仅比 HH:MM 会因跨天误判（"12:20 尚未到"）。
        #   故用**原始带日期时刻** + 20 分钟宽限做硬判定：终点计划到达（含日期）已过 → 已收车。
        journey_finished = terminal_realtime
        if not journey_finished:
            try:
                # 注意：不能用 datetime.utcnow()——它返回**朴素** datetime，与带 tzinfo 的
                # _dest_dt 相减会抛 TypeError 并被 except 吞掉，判定静默失效
                # （2026-09-23 踩坑：ICE 847 一直显示"当前 47 分"）。_age_seconds 已处理时区。
                _grace = 20 * 60
                _dest_age = _age_seconds(_parse_dt(_dest_raw))
                # 双条件：① 终点计划到达（含日期）已过 20 分钟以上
                #        ② 近期不再有实时推进（最近一次实时事件也超过 20 分钟前，且无未来事件）
                #   只靠①会把"终点晚点但仍在跑"误判为收车；只靠②会把"中途长停"误判为收车。
                if _dest_age is not None and _dest_age >= _grace and not _any_future_rt:
                    _last_age = _age_seconds(_last_rt_dt)
                    if _last_age is None or _last_age >= _grace:
                        journey_finished = True
            except Exception:  # noqa: BLE001
                pass
        cur_delay: int | None = None
        cur_station = ""
        position_source = ""
        if not journey_finished and last_rt_delay is not None:
            cur_delay = last_rt_delay
            cur_station = last_rt_station
            position_source = "last_realtime_stop"
        if cur_delay is None and not journey_finished and cur_name:
            ad, dd = stop_delay_map.get(cur_name, (None, None))
            v = ad if ad is not None else dd
            if v is not None:
                cur_delay = v
                cur_station = cur_name
                position_source = "currentStop_planned"

        if not realtime_seen:
            # 计划数据但无实时延误（列车尚未发车 / 数据延迟）→ 仍返回，但标注
            return {"rows": rows, "end_delay": end_delay, "max_delay": mx,
                    "max_station": mx_st, "source": "db_realtime",
                    "current_delay": None, "current_station": "",
                    "note": "计划数据（实时延误尚未推送）"}

        return {"rows": rows, "end_delay": end_delay, "max_delay": mx,
                "max_station": mx_st, "source": "db_realtime",
                # 运行中补正字段：列车当前位置 + 当前延误
                # position_source: last_realtime_stop（权威）/ currentStop_planned（兜底，计划值）
                "current_delay": cur_delay, "current_station": cur_station,
                "position_source": position_source}

    except Exception as e:  # noqa: BLE001
        return {"rows": [], "end_delay": None, "max_delay": None,
                "error": "DB 实时查询异常: %s" % str(e)[:80],
                "source": "db_realtime"}


def _split_train(train: str) -> tuple[str, int]:
    """'RE_3743' / 'RE 3743' / 'ICE847' -> ('RE', 3743) / ('ICE', 847)."""
    import re as _re
    t = _re.sub(r"[ _\-]", " ", str(train)).strip().upper()
    m = _re.match(r"^([A-Z]+)\s*0*([0-9]+)$", t)
    if m:
        return m.group(1), int(m.group(2))
    # 退化：尝试首字母段 + 数字段
    m2 = _re.match(r"^([A-Z]+)[^0-9]*([0-9]+)", t)
    if m2:
        return m2.group(1), int(m2.group(2))
    return "", 0

def _source_label(recs: list[dict]) -> str:
    """按 recs 真实日期范围与数据源生成标签，禁止冒充'最近'。"""
    if not recs:
        return "无数据"
    sources = {r.get("source", "") for r in recs if r.get("end_delay") is not None}
    if not sources:
        return "无可用数据（实时拉取被限流 + 历史数据缺失）"
    if sources == {"piebro"}:
        dates = sorted({r["date"] for r in recs if r.get("end_delay") is not None})
        if dates:
            return (f"⚠️ 实时拉取被限流（人机验证），降级到 PieBro 历史 "
                    f"（非实时，{dates[0]} ~ {dates[-1]}）")
        return "PieBro 历史（非实时）"
    if "db_realtime" in sources and sources == {"db_realtime"}:
        dates = sorted({r["date"] for r in recs if r.get("end_delay") is not None})
        tag = f"（{dates[0]}）" if len(dates) == 1 else ""
        note = next((r.get("_note", "") for r in recs
                     if r.get("_note") and "计划" in r["_note"]), "")
        if note:
            return f"🔴 德铁官方实时（{dates[0] if dates else ''}：计划数据，实时延误待推送）"
        return f"🔴 德铁官方实时数据（bahn.expert/IRIS，运行中列车）{tag}"
    if "db_realtime" in sources:
        other = sources - {"db_realtime"}
        base = ("zugfinder.net Pro 实时逐站" if not other & {"piebro"}
                else "混合：多源")
        return f"{base} + DB 实时补充今日"
    if "piebro" in sources:
        return "混合：实时 + PieBro 历史"
    return "zugfinder.net Pro 实时逐站"


def _data_date_range(recs: list[dict]) -> str:
    """返回 recs 中实际有数据的天日期范围。"""
    valid = sorted({r["date"] for r in recs if r.get("end_delay") is not None})
    if not valid:
        return ""
    if len(valid) == 1:
        return valid[0]
    return f"{valid[0]} ~ {valid[-1]}"


def _train_not_found_warning(train: str, recs: list[dict],
                              n_valid: int, n_limited: int) -> str | None:
    """当所有天数均无有效数据且非限流时，给出友好提示。"""
    if n_valid > 0 or n_limited > 0:
        return None
    # 检查是否所有 recs 都是空 rows（API 返回空 → 车次不存在/不运行）
    all_empty = all(len(r.get("rows", [])) == 0 for r in recs)
    if all_empty:
        return (f"未找到车次「{train}」的数据。"
                "可能原因：①该车次在查询日期范围内未开行（如周末/季节性列车）；"
                "②车次号有误；③该线路为新开行，尚无历史数据。"
                "请确认车次号后重试。")
    # 有 rows 但 end_delay 全为 None（数据异常）
    return (f"车次「{train}」拉取到站序信息但无法计算延误。"
            "可能是数据源临时异常，请稍后重试。")


def predict(recs: list[dict], destination: str = "") -> dict:
    """近 N 天窗口基线预测（严格只用过去数据，不含未来）。

    destination: 用户指定的到达站名（用于站对站预测）。
                 为空时使用终点延误；非空时按该站 adelay 统计。
                 兜底：如果 destination 0 命中但 line 有数据，回退到终点延误。
    """
    if destination:
        # 按指定目的站的历史到站延误（排除取消日）
        ds = destination.strip()
        ends = []
        for r in recs:
            if r.get("canceled"):
                continue
            # 优先从 all_stops（当天所有 ride 合并）匹配，兜底 sample rows
            v = _station_delay_from_map(r, ds)
            if v is not None and v >= 0:
                ends.append(max(v, 0.0))
        mode = "destination"
        # 兜底：destination 0 命中 → 用 line 整体 end_delay 预测 + 标记 fallback
        fallback = False
        if len(ends) == 0:
            ends = []
            for r in recs:
                if r.get("canceled"):
                    continue
                v = r.get("end_delay")
                # v < 0 = 未到终点哨兵（旧缓存）→ 排除，绝不钳成 0 混入"准点"
                if v is not None and v >= 0:
                    ends.append(float(v))
            if ends:
                mode = "destination_fallback_end"
                fallback = True
    else:
        ends = []
        for r in recs:
            if r.get("canceled"):
                continue
            v = r.get("end_delay")
            if v is not None and v >= 0:
                ends.append(float(v))
        mode = "end"
        fallback = False
    ends_arr = np.array(ends, dtype=float)
    if len(ends_arr) == 0:
        # 无历史可统计。但今日若为运行中列车，仍应给出"当前延误"作为 today_actual
        # （2026-09-18：否则历史窗口为空时运行中列车的实时值也被丢弃）。
        _rt = next((r for r in recs if r.get("_db_current_delay") is not None), None)
        _rt_today = _rt["_db_current_delay"] if _rt else None
        _rt_from = _rt.get("date") if _rt else None
        return {"point_estimate": None, "p10": None, "p90": None,
                "prob_ge15": None, "prob_ge30": None, "on_time_prob": None,
                "today_actual": _rt_today,
                "today_actual_from": _rt_from,
                "today_actual_is_today": bool(
                    _rt_from and _rt_from == date.today().isoformat()),
                "n_days": 0, "mode": mode,
                "destination": destination or None,
                "destination_matched_days": 0,
                "fallback_to_end": False}
    point = float(np.median(ends_arr))
    p10 = float(np.percentile(ends_arr, 10))
    p90 = float(np.percentile(ends_arr, 90))
    prob15 = float(np.mean(ends_arr >= 15))
    prob30 = float(np.mean(ends_arr >= 30))
    # 准点概率：延误 < 15 分钟（德铁"准点"口径阈值）的比例；与 1-prob_ge15 等价
    on_time = float(np.mean(ends_arr < 15))
    # "今日实际"取最近一个有数据且未取消的天（过了 0 点当天未开行时回退到上一有数据日）。
    # 运行中列车（未终到，DB 实时补充了当前延误）：优先取"当前站延误"作为今日实际，
    # 它同时会作为 current_delay 传给模型做终点预测补正（v5hr 的 delay_in_min 特征）。
    #
    # 显式防护（2026-09-18）：运行中的今日行 `_db_running=True` 且 end_delay 已置 None，
    # 它不应进入 ends 统计。上面的 `v is not None` 已隐含排除，但为防其他路径残留
    # 占位值（如截断快照的末站延误），这里显式再挡一道。
    today = None
    today_from = None
    for r in recs:  # recs 顺序 = [今天, 历史升序...]，今天行在最前
        if r.get("_db_current_delay") is not None:
            today = r["_db_current_delay"]
            today_from = r.get("date")
            break
    if today is None:
        for r in reversed(recs):  # 从最近历史日开始回退（历史部分升序）
            if r.get("canceled"):
                continue
            # 运行中行不作为"今日实际"的数据源（其 end_delay 已置 None；
            # 若未来有路径残留占位值，这里仍显式跳过）
            if r.get("_db_running"):
                continue
            v = (_station_delay_from_map(r, destination)
                 if (destination and not fallback) else r.get("end_delay"))
            # v < 0（未到终点哨兵）→ 继续回退上一有数据日，不显示"准点 0"
            if v is not None and v >= 0:
                today = v
                today_from = r.get("date")
                break
    today = max(today, 0.0) if today is not None else None
    # 回退来源标记：当 today 来自历史日（非今日）时，前端应显示为"最近一次（日期）"
    # 而非"今日实际"，避免把昨天的值冒充今天（2026-09-18 bug 的边界防护）。
    _today_str = date.today().isoformat()
    today_is_today = bool(today_from and today_from == _today_str)
    n_canceled = sum(1 for r in recs if r.get("canceled"))
    return {"point_estimate": round(point, 1), "p10": round(p10, 1),
            "p90": round(p90, 1), "prob_ge15": round(prob15, 4),
            "prob_ge30": round(prob30, 4), "on_time_prob": round(on_time, 4),
            "today_actual": today,
            "today_actual_from": today_from,
            "today_actual_is_today": today_is_today,
            "n_days": len(ends_arr), "n_canceled_days": n_canceled,
            "mode": mode,
            "destination": destination or None,
            "destination_matched_days": len(ends_arr),
            "fallback_to_end": fallback}


def _station_delay(rows: list[dict], station: str) -> float | None:
    """从 rows（[{bhf, adelay, ...}, ...]）中取指定站的到站延误。

    adelay == -1 是 zugfinder「该站未到达」哨兵 → None（不是 0）。
    """
    if not station or not rows:
        return None
    target = station.strip().lower()
    for x in rows:
        if str(x.get("bhf", "")).strip().lower() == target:
            try:
                v = float(x["adelay"])
            except (KeyError, TypeError, ValueError):
                return None
            return None if v == -1 else v
    return None


def _station_delay_from_map(rec: dict, station: str) -> float | None:
    """从 rec 的 all_stops（当天所有 ride 合并）优先取延误，兜底 sample rows。"""
    if not station:
        return None
    target = station.strip().lower()
    m = rec.get("all_stops")
    if isinstance(m, dict) and target in m:
        try:
            v = float(m[target])
            # -1 = 未到达哨兵（同 _station_delay 口径）
            return None if v == -1 else v
        except (TypeError, ValueError):
            pass
    return _station_delay(rec.get("rows") or [], station)


def _station_days(recs: list[dict], limit: int = 10) -> list[dict]:
    """近 N 天逐站延误映射（station→delay，供 10 天柱状图选站展示）。

    提前到达（负值）按 0 计入，保证柱状图/选站图无空缺、线连续。
    -1 哨兵（该站未到达）→ 不写入映射：画图时该站空缺，而非"准点 0"。
    """
    out = []
    for r in recs[-limit:]:
        delays = {}
        for x in (r.get("rows") or []):
            try:
                v = float(x["adelay"])
            except (KeyError, TypeError, ValueError):
                continue
            if v == -1:
                continue
            delays[x["bhf"]] = max(v, 0)
        out.append({"date": r["date"], "delays": delays})
    return out


# ---- 已训练 LightGBM 生产模型（v5hr）接入 ----
# 说明：webapp 默认用的是「近 N 天中位数」经验基线（predict()）。
# 这里把 delay_model 项目中已训练好的 LightGBM v5hr 模型接入，作为主预测；
# 任何缺失（lightgbm/cache/模型文件）或异常都静默降级回基线。
_STATION_EVA_MAP = None
_DELAY_MODEL_DIR = os.environ.get("DELAY_MODEL_DIR") or os.path.join(_HERE, "data", "delay_model")
_CACHE_MAX_DATE = None  # 缓存表最后一个有数据的日期（用于把 when 锚定进覆盖区间）


def _cache_max_date():
    """读取 r7 缓存表的最大日期（缓存一次），把模型 when 锚定到覆盖区间内，

    否则 when=now 超出缓存（通常只到上月）→ r7/station_hist 特征全 NaN，
    模型退化成仅 train_type+时间 的弱先验，不如用了真实历史的中位数基线。
    """
    global _CACHE_MAX_DATE
    if _CACHE_MAX_DATE is not None:
        return _CACHE_MAX_DATE
    try:
        import pandas as pd
        rp = os.path.abspath(os.path.join(
            os.environ.get("DELAY_MODEL_DIR") or os.path.join(_HERE, "data", "delay_model"),
            "..", "db_database", "weather", "recent7_by_date.parquet"))
        if os.path.exists(rp):
            df = pd.read_parquet(rp, columns=["date"])
            mx = df["date"].max()
            if mx is not None and not pd.isna(mx):
                _CACHE_MAX_DATE = pd.to_datetime(mx).to_pydatetime()
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("CACHE_MAX_DATE_SKIP: %s\n" % e)
    return _CACHE_MAX_DATE


def _load_station_eva_map() -> dict:
    """站名→8位EVA 本地映射（离线激活 r7 / station_hist 特征）。

    数据：K:/ZUGVORHERSAGEN/db_database/weather/station_anchor_map.parquet
    （3268 行 station_name→eva）。大小写/空白归一后建索引，首次调用惰性加载并缓存。
    """
    global _STATION_EVA_MAP
    if _STATION_EVA_MAP is not None:
        return _STATION_EVA_MAP
    _STATION_EVA_MAP = {}
    try:
        import pandas as pd
        mp = os.path.join(
            os.environ.get("DELAY_MODEL_DIR") or os.path.join(_HERE, "data", "delay_model"),
            "..", "db_database", "weather", "station_anchor_map.parquet")
        mp = os.path.abspath(mp)
        if os.path.exists(mp):
            df = pd.read_parquet(mp)
            for _, row in df.iterrows():
                eva = str(row.get("eva") or "").strip()
                if not eva:
                    continue
                name = str(row.get("station_name") or "").strip().lower()
                if name and name not in _STATION_EVA_MAP:
                    _STATION_EVA_MAP[name] = eva
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("EVA_MAP_LOAD_SKIP: %s\n" % e)
    return _STATION_EVA_MAP


def _resolve_eva(station: str) -> str:
    """站名→EVA：本地映射优先；失败再走模型自带在线解析（board API）。

    无网络时在线解析静默失败 → 返回空（eva_hist / r7 特征变 NaN，模型仍可预测）。
    """
    if not station:
        return ""
    key = station.strip().lower()
    m = _load_station_eva_map()
    if key in m:
        return m[key]
    try:
        if _DELAY_MODEL_DIR not in sys.path:
            sys.path.insert(0, _DELAY_MODEL_DIR)
        from production_predictor import DBBoardClient
        return DBBoardClient().resolve_station(station) or ""
    except Exception:  # noqa: BLE001
        return ""


def _model_skip(reason: str, train: str, detail=None) -> None:
    """模型预测降级告警（Task #51）。

    过去 predict_with_model 在所有失败分支静默 return None，「模型没跑」与
    「模型跑了但不适用」在上游无法区分。这里统一输出机器可读的告警行：

        MODEL_PREDICT_SKIP: reason=<code> train=<车次> detail=<补充>

    server.js 对 'MODEL_PREDICT_SKIP' 前缀已有识别，可据此做日志聚合与告警。
    reason 取值：
      no_model_dir / no_target_station / out_of_scope / empty_result / exception
    """
    d = "" if detail in (None, "") else " detail=%s" % detail
    sys.stderr.write("MODEL_PREDICT_SKIP: reason=%s train=%s%s\n"
                     % (reason, train, d))


# ── 生产预测器单例（2026-09-14 压测：冷启动 82s 里 72s 都花在这）────────────
# 实测：ProductionPredictor() 构造 = joblib.load(21MB 模型) + FeatureCache()
#      = read_parquet(recent7 + station_hist + line_hist + 131MB train_hist)
#      → 约 72.4s、占用约 3.29GB RSS，而真正的推理只要 0.91s。
# 原架构 spawn-per-request：每个 HTTP 请求都 new 一次 → 88% 的时间在重复加载
#   同一份静态数据，且并发 N 就等于 N 份 3.3GB 常驻 → CPU/内存双重打满。
# 单例后：CLI 模式行为完全不变（一个进程仍只调一次 predict）；常驻 worker 模式
#   下多请求共用同一实例，重复加载彻底消除。
# 线程安全：FastAPI worker 用线程池处理并发，此处加锁避免多请求同时触发构造。
_PREDICTOR_SINGLETON = None
_PREDICTOR_LOCK = threading.Lock()


def _get_shared_predictor(cls):
    """惰性构造并复用 ProductionPredictor 单例。"""
    global _PREDICTOR_SINGLETON
    if _PREDICTOR_SINGLETON is not None:
        return _PREDICTOR_SINGLETON
    with _PREDICTOR_LOCK:
        if _PREDICTOR_SINGLETON is None:
            import os
            _PREDICTOR_SINGLETON = cls()
            sys.stderr.write("[predictor] 单例已建立 pid=%s\n" % os.getpid())
    return _PREDICTOR_SINGLETON


def predict_with_model(train: str, destination: str, final_station: str,
                       current_delay, line_number=None,
                       when=None) -> dict | None:
    """调用已训练的 LightGBM v5hr 生产模型，返回标准化 dict 或 None。

    返回 None 的几种情况（均降级到基线 predict()）：
      - delay_model 目录不存在 / lightgbm 未安装 / 模型文件损坏
      - 目标站为空（无终点也无目的站）
      - 车次类型不在模型范围内（train_type_out_of_scope，如 S/U/BUS/NJ 等）
      - 任何运行时异常

    2026-09-13（Task #51）：以上分支过去全部静默 return None，导致「模型没跑」
    与「模型跑了但不适用」在上游完全无法区分 —— 实测曾出现模型长时间未生效
    却无人察觉。现统一通过 _model_skip() 打 stderr 告警（带机器可读原因码），
    server.js 侧对 MODEL_PREDICT_SKIP 已有识别，便于日志聚合与告警。

    注意：train 必须空格格式（'ICE 847'）。网站内部用下划线 'ICE_847'，
    会被 _assemble 的正则误判为 UNKNOWN，这里统一把下划线转空格。
    """
    try:
        if not os.path.isdir(_DELAY_MODEL_DIR):
            _model_skip("no_model_dir", train, _DELAY_MODEL_DIR)
            return None
        if _DELAY_MODEL_DIR not in sys.path:
            sys.path.insert(0, _DELAY_MODEL_DIR)
        # scipy>=1.13 移除了 scipy.sparse.spmatrix；lightgbm 4.x import 时仍引用。
        # 此处先打兼容补丁再导入生产预测器（否则模型加载直接崩）。
        import scipy.sparse as _sp
        if not hasattr(_sp, "spmatrix"):
            _sp.spmatrix = object
        from production_predictor import ProductionPredictor
        target = (destination or final_station or "").strip()
        if not target:
            _model_skip("no_target_station", train)
            return None
        model_train = train.replace("_", " ").strip()
        eva = _resolve_eva(target)
        pp = _get_shared_predictor(ProductionPredictor)
        # when 锚定到缓存覆盖区间内（默认 now 会超出缓存 → 历史特征 NaN）
        eff_when = when or _cache_max_date()
        r = pp.predict(
            train_name=model_train, station_name=target, when=eff_when,
            current_delay=current_delay,
            final_destination=(destination or final_station or None),
            line_number=(str(line_number)
                         if line_number not in (None, "", "nan") else None),
            # 本地 station_anchor_map 解析出的 EVA 直传：沙箱/数据中心
            # 环境 bahn.de 403，在线解析不可靠；EVA 是 r7/hist 特征的钥匙
            eva=(eva or None))
        if not r or r.get("train_type_out_of_scope"):
            _model_skip("out_of_scope" if r else "empty_result", train,
                        (r or {}).get("train_type"))
            return None
        return {
            "available": True,
            "model": ("lightgbm_"
                      + (r.get("pkg_name") or "v6wxhr")
                      ).replace("lgb_term_package_", "").replace(".joblib", ""),
            "train_type": r.get("train_type"),
            "point_estimate": r.get("point_estimate"),
            "q05": r.get("q05"), "q10": r.get("q10"), "q50": r.get("q50"),
            "q90": r.get("q90"), "q95": r.get("q95"),
            "interval_p10_p90": r.get("interval_p10_p90"),
            "interval_p05_p95": r.get("interval_p05_p95"),
            "prob_ge15": r.get("prob_ge15"),
            # 长尾上沿修正状态（Task #55）：
            #   longtail_enabled  —— 功能是否开启（环境变量 TRAINDELAY_ENABLE_LONGTAIL=1）
            #   longtail_adjusted —— 本次预测是否真的放宽了 q90
            "longtail_enabled": bool(r.get("longtail_enabled")),
            "longtail_adjusted": bool(r.get("longtail_adjusted")),
            # 取消分类器未做概率校准（实测 ICE_847 输出 75.8%，而同线经验取消率仅
            # 4.6%），不能当概率用 —— 改名为 _raw 并标注，页面统一展示经验口径的
            # cancellation_prob，避免出现两个互斥的「取消概率」。
            "prob_cancel_raw": r.get("prob_cancel"),
            "prob_cancel_calibrated": False,
            "risk_level": r.get("risk_level"),
            "eva": eva or (r.get("sources") or {}).get("eva"),
            "sources": r.get("sources") or {},
        }
    except Exception as e:  # noqa: BLE001
        _model_skip("exception", train, "%s: %s" % (type(e).__name__, e))
        return None


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="车次预测+逐站汇总（供 webapp）")
    ap.add_argument("train", help="车次，如 ICE_847 / ICE 847")
    ap.add_argument("--days", type=int, default=8,
                    help=f"回顾天数（默认 8，上限 {MAX_DAYS_PER_RUN}，zugfinder 单次限流）")
    ap.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                    help="请求间隔秒（默认 2.0）")
    ap.add_argument("--no-cache", action="store_true", help="忽略本地缓存")
    ap.add_argument("--clear-cache", action="store_true",
                    help="清除该车次缓存后退出")
    ap.add_argument("--cred", default=CRED_DEFAULT, help="凭据文件")
    ap.add_argument("--destination", default="",
                    help="目的站名（站对站预测，到达该站的延误而非终点延误）")
    ap.add_argument("--date", default="",
                    help="预测日期 YYYY-MM-DD（默认明天），用于 prediction_date 字段")
    # ride_* 原先只能走环境变量（server.js 当年为绕开 Windows spawn 引号问题）。
    # 常驻 worker 是多线程的，os.environ 会被并发请求互相串改 → 必须可走 argv。
    # 优先级：argv > 环境变量（CLI/旧调用方不受影响，不传即为空 → 沿用环境变量）。
    ap.add_argument("--ride-from", default="", dest="ride_from",
                    help="乘车起点站（等价 TRAIN_RIDE_FROM）")
    ap.add_argument("--ride-to", default="", dest="ride_to",
                    help="乘车终点站（等价 TRAIN_RIDE_TO）")
    ap.add_argument("--ride-time", default="", dest="ride_time",
                    help="发车时刻 HH:MM（等价 TRAIN_RIDE_TIME）")
    ap.add_argument("--json-pretty", action="store_true", help="美化输出")
    # argv=None 时仍读 sys.argv（CLI 行为不变）；常驻 worker 传显式列表复用本函数
    args = ap.parse_args(argv)

    train = _norm_train(args.train)
    # 限制单次连续请求 ≤ MAX_DAYS_PER_RUN
    if args.days > MAX_DAYS_PER_RUN:
        print(json.dumps({"error": f"单次 --days 上限 {MAX_DAYS_PER_RUN}（zugfinder 限流），"
                        f"建议分段或使用 --no-cache 时减小"}, ensure_ascii=False))
        return 1

    if args.clear_cache:
        import shutil
        d = os.path.join(CACHE_DIR, train)
        if os.path.isdir(d):
            shutil.rmtree(d)
        print(json.dumps({"cleared": d}, ensure_ascii=False))
        return 0

    # 班次号列表模式（/api/ride-numbers 用）：只扫 PieBro，不登录 zugfinder
    if os.environ.get("TRAIN_LIST_RIDES"):
        print(json.dumps({"line": args.train,
                          "numbers": list_rides(args.train)},
                         ensure_ascii=False))
        return 0

    if args.no_cache and os.path.isdir(os.path.join(CACHE_DIR, train)):
        import shutil
        shutil.rmtree(os.path.join(CACHE_DIR, train))

    # destination：优先环境变量（server.js 传参避免 Windows 引号问题）
    if not args.destination:
        args.destination = os.environ.get("TRAIN_DESTINATION", "")
    # 作用①：线路 + 始发站 + 发车时间 → 唯一列车号（RE/RB 用 train_number 定位具体班次）
    # 优先 argv（常驻 worker 多线程安全），回落环境变量（兼容旧调用方）
    ride_from = (getattr(args, "ride_from", "") or os.environ.get("TRAIN_RIDE_FROM", "")).strip()
    ride_time = (getattr(args, "ride_time", "") or os.environ.get("TRAIN_RIDE_TIME", "")).strip()
    ride_to = (getattr(args, "ride_to", "") or os.environ.get("TRAIN_RIDE_TO", "")).strip()
    ride = (resolve_ride(train, ride_from, ride_time, to_st=ride_to)
            if ride_from else {})
    collect_train = ride.get("train_number") or train
    # BUG FIX (2026-09-09)：PieBro 的 train_number 是纯数字（"26709"），而 zugfinder
    # 的 z 键必须带类型前缀（实测 z=26709 恒返回空，z=RE_26709 才有 16 站数据）。
    # 旧行为：具体班次查询近 10 天全部返回空 → collect_multi_account 降级 PieBro
    # 补位（自带 end_delay，被当成「有效数据」）→ 下方线路级回退永不触发 →
    # 前端把「0 天 zugfinder」误报成「近 10 天 zugfinder 全部准点」。
    # 前缀来源：PieBro train_type 是运营商内部代码大杂烩（NX/RSM/vlx/HLB... 同线
    # 混杂），仅白名单内商业车种可直接用作前缀；其余退回用查询线路号的前缀
    # （RE 11 的班次在 zugfinder 即 RE_26709）。
    if ride.get("train_number"):
        tn = str(ride["train_number"]).strip()
        tt = str(ride.get("train_type") or "").strip().upper()
        if tt not in _ZKEY_TRAIN_TYPES:
            m_ln = re.match(r"^([A-Z]+)_", _norm_train(train))
            tt = m_ln.group(1) if m_ln else ""
        if tn.isdigit() and tt and not tn.upper().startswith(tt):
            collect_train = tt + "_" + tn
            ride["train_number"] = collect_train  # 前端页脚/zugfinder 链接用完整车次号
    # 实时采集：主账号 → 备用账号池（ac2.txt/ac(2).txt）→ 全部失败才降级 PieBro
    recs = collect_multi_account(collect_train, args.days, args.delay, args.cred)
    # 具体车号未查到 zugfinder 实测数据（z 键无此车/限流/无历史）→ 回退整条线路。
    # 注意：只认 zugfinder 来源天——PieBro 降级天（source="piebro"）自带 end_delay，
    # 不能算「查到数据」，否则此回退永不触发（上一行 z 键 bug 的帮凶）。
    if ride and not any(r.get("end_delay") is not None and r.get("source") != "piebro"
                        for r in recs):
        recs = collect_multi_account(train, args.days, args.delay, args.cred)
        ride["train_number"] = ""  # 未命中具体班次，前端不显示车号

    # 多班次日 rows 整理：复用线路号（RE 13 等）的 zugfinder 线路级查询返回
    # 当天全部班次交错行，污染站序/时刻表/指纹——对齐到单班次再往下走。
    # BUG FIX (2026-09-09)：具体班次查询（ride 命中且 z 键生效，如 RE_26709）的
    # rows 本来就是单班次干净站序，无需整理；若仍按线路号 RE_11 取模板对齐，
    # 站数/区段差异（zugfinder 收录 16 站 vs PieBro 全程 20 站）会模板错配，
    # LIS 把 16 行剪成 0 行 → 逐站表/曲线全空。此类天必须跳过整理。
    ride_query_ok = bool(ride and ride.get("train_number")
                         and collect_train != train)
    if not ride_query_ok:
        recs = _normalize_daily_trip_rows(recs, train)

    # ── 实时数据补充：zugfinder 今日无数据（列车运行中）→ 尝试 DB 官方 API ──
    today_str = date.today().isoformat()
    today_idx = None
    for i, r in enumerate(recs):
        if r.get("date") == today_str:
            today_idx = i
            break

    # 今日不在 recs 中（zugfinder 仅返回历史日、列车尚未终到）→ 插入占位行，
    # 让下方的 DB 实时补充逻辑能填充今日运行中列车的实际延误。
    if today_idx is None:
        recs.insert(0, {"date": today_str, "rows": [], "end_delay": None,
                        "max_delay": None, "max_station": "", "source": "pending"})
        today_idx = 0

    # 条件：今日行不可信/未终到（见 _today_snapshot_partial 文档）。
    # 注意旧判据「end_delay is None」会被截断快照的末站延误骗过（2026-09-18 bug）。
    _hist_counts = [len(r.get("rows") or []) for i, r in enumerate(recs)
                    if i != today_idx and (r.get("rows") or [])]
    if _today_snapshot_partial(recs[today_idx], _hist_counts):
        # 先从已有数据中提取已知站点列表（供 DB 发车板定位用）
        known_stations = []
        for r in recs:
            if r.get("rows"):
                known_stations = [x["bhf"] for x in r["rows"]]
                break
        rt = db_realtime_train(collect_train, today_str, known_stations,
                               from_st=ride_from, to_st=args.destination)
        if rt.get("rows") and rt.get("end_delay") is not None:
            # 用 DB 实时数据填充今天的空数据（bahn.expert / IRIS）
            note = rt.get("note") or ""
            recs[today_idx] = {
                "date": today_str,
                "rows": rt["rows"],
                "end_delay": rt["end_delay"],
                "max_delay": rt["max_delay"],
                "max_station": rt.get("max_station", ""),
                "source": "db_realtime",
                "_note": ("🔴 德铁官方实时（bahn.expert/IRIS，运行中列车）"
                          if not note else f"🔴 德铁官方实时（{note}）"),
            }
        elif rt.get("current_delay") is not None:
            # 运行中且未终到：不填 end_delay（避免把"当前站延误"混入终点历史统计），
            # 记录当前延误/位置 → 供 predict 的 today_actual 与模型补正使用。
            # 必须**显式清掉**旧的 end_delay：截断快照会写入末站延误（如 3 分），
            # 若残留会污染基线统计的中位数/分位数/概率（p10/p90/prob_ge15）。
            note = rt.get("note") or ""
            recs[today_idx].update({
                "_db_running": True,
                "_db_current_delay": rt["current_delay"],
                "_db_current_station": rt.get("current_station", ""),
                "rows": rt.get("rows") or [],
                "end_delay": None,
                "source": "db_realtime",
                "_note": ("🔴 德铁官方实时（运行中，补正当前延误）"
                          if not note else f"🔴 德铁官方实时（{note}）"),
            })

    # 今日行归一化到 recs[0]（2026-09-18 bug）：下游多处（`head = recs[0]`、
    # `recs[0] 始终是今天`、predict 的 reversed(recs) 回退）都**假设 recs[0] 是今天**，
    # 但 collect()/collect_multi_account() 返回的是**日期升序**（最新日在末尾）。
    # 过去今日行 end_delay 非空、补正被跳过时，这个错位被"reversed 取最后一天"掩盖；
    # 修复触发补正后暴露：recs[today_idx]=recs[7] 拿到实时值，但 recs[0] 仍是历史最旧日，
    # 导致 2295 行 `head=recs[0]` 把今日行甩进 hist，recent/today_actual 全部错位。
    if today_idx is not None and today_idx != 0 and 0 <= today_idx < len(recs):
        _today_row = recs.pop(today_idx)
        recs.insert(0, _today_row)
        today_idx = 0

    # ── PieBro 本地历史库扩充统计窗口（核心：26 个月 parquet 免限流）──
    # zugfinder 受限流约束单次最多 8 天；基线 predict() 的中位数/分位数/概率
    # 在 8 天样本上方差大。本地 PieBro parquet 有 26 个月历史，这里把统计
    # 窗口扩充到 HIST_WINDOW_DAYS 天：按日期去重合并，zugfinder/DB 实时行
    # 优先（实时准），今天行不动（recs[0] 始终是今天）。
    # 主线联邦州：只取实测行（zugfinder / DB 官方实时）的逐站数据，
    # 用它当线路指纹——同名车次（RE 11 等）跨联邦州的另一条线不应混入。
    _live_stations = []
    _live_station_set = set()
    _live_days = []  # (rec, 该天联邦州集合)
    for r in recs:
        if (r.get("source") or "") == "piebro":
            continue
        rows = r.get("rows") or []
        if not rows:
            continue
        _live_days.append((r, line_states([x.get("bhf") for x in rows])))
        for x in rows:
            b = x.get("bhf")
            _live_stations.append(b)
            if b:
                _live_station_set.add(b)
    # 同名车次可能一次返回多条线路的天（如 RE 11 既有 NRW→Magdeburg 线，
    # 也有 Hoyerswerda→Leipzig 线）。按「州出现在多少天里」投票选出主线州，
    # 再取包含主线州的天，避免把两条线混进同一个统计窗口。
    _state_days = Counter()
    for _, st in _live_days:
        for s in st:
            _state_days[s] += 1
    main_states = set()
    if _state_days:
        seed = _state_days.most_common(1)[0][0]  # 出现天数最多的州 = 主线种子
        main_days = [st for _, st in _live_days if seed in st]
        if main_days:
            c = Counter()
            for st in main_days:
                for s in st:
                    c[s] += 1
            # 主线天里覆盖过半的州才算线路真正经过的州
            main_states = {s for s, n in c.items() if n >= len(main_days) * 0.5}
    if not main_states:
        main_states = line_states(_live_stations)
    line_filtered_days = 0  # 因跨线被剔除的历史天数

    piebro_hist_added = 0
    try:
        pie_hist = collect_piebro_fallback(collect_train, HIST_WINDOW_DAYS)
    except Exception as _e:  # noqa: BLE001 — 历史库缺失/损坏不阻塞在线预测
        sys.stderr.write("PIEBRO_HIST_SKIP: %s\n" % _e)
        pie_hist = []
    if pie_hist:
        taken = {r.get("date") for r in recs}
        added = []
        for r in pie_hist:
            d = r.get("date")
            if not d or d >= today_str:
                continue  # 今天/未来由 zugfinder / DB 实时负责，历史库只补过去
            if d in taken:
                continue
            # 跨线剔除：历史库里的同名车次可能跑在别的州（如 RE 11 的
            # Thüringen/Sachsen 线），其 max_station 州不在主线州内 → 丢弃
            if main_states:
                st = station_state(r.get("max_station") or "")
                if st and st not in main_states:
                    line_filtered_days += 1
                    continue
            r["source"] = r.get("source") or "piebro"
            r["_note"] = "📊 PieBro 本地历史库（统计窗口扩充）"
            added.append(r)
            taken.add(d)
        if added:
            added.sort(key=lambda r: r["date"])
            head, hist = recs[0], sorted(recs[1:] + added,
                                         key=lambda r: r.get("date") or "")
            recs = [head] + hist
            piebro_hist_added = len(added)

    n_valid = sum(1 for r in recs if r.get("end_delay") is not None)
    n_limited = sum(1 for r in recs if r.get("error") == "rate_limited")

    # 预测日期：默认明天，用户可指定
    if args.date:
        try:
            prediction_date = args.date
        except Exception:
            prediction_date = (date.today() + timedelta(days=1)).isoformat()
    else:
        prediction_date = (date.today() + timedelta(days=1)).isoformat()

    # 取消概率（统一口径）：PieBro 同线班次统计为主；zugfinder 实测天作为补充观测
    #   观测单位统一为「班次」，zugfinder 每个有数据的自然日 = 1 个班次。
    #   注：模型侧的 prob_cancel 未做概率校准（实测 ICE_847 给 75.8% 而经验值仅 4.6%），
    #   故不参与展示，避免出现 6% vs 28% 的两个互斥数字。
    cancellation_prob = cancel_prob_piebro(
        ride.get("train_number") or train, 60,
        main_states=main_states or None,
        train_number=ride.get("train_number") or None)
    # zugfinder 实测窗口的取消观测（同线过滤后的历史天），仅作透明度元数据：
    # 这些天的班次已包含在 PieBro 统计里（同一批车），合并会重复计数，故不并入分子分母。
    z_days = [r for r in recs if r.get("date") and r.get("date") != recs[0].get("date")]
    z_days = [r for r in z_days if r.get("end_delay") is not None or r.get("canceled")]
    cancellation_prob["zugfinder_days"] = len(z_days)
    cancellation_prob["zugfinder_canceled_days"] = sum(
        1 for r in z_days if r.get("canceled"))
    # 无任何观测 → 明确返回空, 而不是 0%
    if not cancellation_prob.get("n_rides"):
        cancellation_prob = _empty_cancel_prob("none")
    else:
        cancellation_prob["unit"] = "ride"
    # 德铁官方次日开行校验（实验；失败/无参数 → unknown，不阻塞预测）
    db_status = (db_next_day_check(train, ride_from, args.destination,
                                   prediction_date, ride_time)
                 if (ride_from and args.destination) else
                 {"status": "unknown", "note": "缺少起终点参数"})

    # 站序：取「最近一天中停靠站最完整」的实际站序为基准。
    #   注意：PieBro 数据里部分天只有开头几站（如 7-31 仅 Borkheide→Wiesenburg），
    #   取最近一天会截断线路（如 RE 3743 完整应到 Dessau Hbf）。
    #   折中：按站数降序挑一条最完整的（同时尽量新），保证线路完整又不被历史污染。
    stations: list[str] = []
    if recs:
        data_days_for_stations = [r for r in recs if r.get("rows")]
        # 跨线剔除：同名车次不同线的天（联邦州与主线无交集）不参与站序选取，
        # 否则 stations 可能来自另一条线，导致逐站表与目的站自相矛盾。
        if main_states:
            same_line = []
            for r in data_days_for_stations:
                st = line_states([x.get("bhf") for x in (r.get("rows") or [])])
                if not st:
                    continue
                # 重合度阈值：跨线天通常只在个别州上偶然撞车（如两条线都经过
                # Sachsen-Anhalt），用 ≥60% 重合避免误收
                if len(st & main_states) / len(st) >= 0.6:
                    same_line.append(r)
            if same_line:
                data_days_for_stations = same_line
        if data_days_for_stations:
            # 候选：按 (站数, 日期) 排序 —— 站数优先（完整线路），同站数取最近
            def _rows_key(r):
                return (len(r.get("rows") or []), r.get("date") or "")
            best = max(data_days_for_stations, key=_rows_key)
            stations = [x["bhf"] for x in (best.get("rows") or [])]
            # 若最近一天也有站且比 best 更长，理论上 max 已选；这里不再覆盖
        # 指纹兜底：live 数据没有站序（当前无在线车次 / zugfinder 未返回 rows）时
        # 前面两条指纹路径都会落空。历史行要等统计窗口合并后才进 recs，所以
        # 这里用最终站序再算一次——否则这类线路的跨线剔除与州指纹整体失效。
        if not main_states and stations:
            main_states = line_states(stations)

    # 目的站跨线纠正：时刻表/用户给的目的站若不属于主线联邦州（例如查询
    # RE 11 却给出 Sachsen 的 Leipzig Hbf，而实测线在 NRW/Hessen），
    # 自动改用实测末站众数，避免拿一条不存在的组合去做终点预测。
    line_conflict = False
    line_destination_auto = ""
    line_queried_destination = ""
    if main_states and args.destination:
        dst_state = station_state(args.destination)
        # 冲突判据（满足其一即跨线）：
        #   ① 目的站所属联邦州不在主线州内（如查 RE 11 却给 Sachsen 的 Leipzig Hbf）
        #   ② 目的站从未在任何实测逐站数据里出现过（该线根本不经过）
        dst_unseen = bool(_live_station_set) and args.destination not in _live_station_set
        if (dst_state and dst_state not in main_states) or dst_unseen:
            end_cnt = Counter()
            for r in recs:
                if (r.get("source") or "") == "piebro":
                    continue
                rows = r.get("rows") or []
                if rows:
                    b = rows[-1].get("bhf")
                    if b and station_state(b) in main_states:
                        end_cnt[b] += 1
            if end_cnt:
                auto = end_cnt.most_common(1)[0][0]
                if auto and auto != args.destination:
                    line_conflict = True
                    line_queried_destination = args.destination  # 用户原本查的站
                    line_destination_auto = auto
                    args.destination = auto

    # 有数据的天（过了 0 点当天尚未开行 → 空天剔除，避免"近三日"变两日/曲线悬空）
    data_recs = [r for r in recs if r.get("rows")]

    def _build_curve_entry(r, stations, day_canceled=None):
        """把某天的逐站 adelay 组装成与 stations 对齐的 series/skipped。"""
        rows = r.get("rows") or []
        day_canceled = r.get("canceled", False) if day_canceled is None else day_canceled
        # 当天 station→adelay 映射（保留 Köln 等起发站：arr 可能是 99:99 但 adelay 有值）
        day_map = {}
        for x in rows:
            try:
                v = float(x["adelay"])
            except (KeyError, TypeError, ValueError):
                continue
            # 取消日：adelay="-1" 是哨兵值，不当作延误
            if day_canceled:
                v = None
            elif v == -1:
                # -1 哨兵 = 该站未到达（如终点 destination not reached）→ 断线，
                # 旧版钳成 0 会把折线尾端画成"准点"
                v = None
            elif v < 0:
                v = 0  # 其余负值 = 提前到达，按 0 计入
            day_map[x["bhf"]] = v
        present = {x["bhf"] for x in rows}
        has_data = bool(rows)  # 该日是否拿到数据（限流/缺失 → False）
        series = []
        skipped = []  # True = 确定不停靠（该日有数据但站不在）；False = 正常/数据缺失
        for s in stations:
            v = day_map.get(s)
            if v is not None:
                series.append(v)
                skipped.append(False)
            else:
                series.append(None)
                # 有数据但站不在 → 确定该日不停靠；无数据 → 数据缺失（保持断线）
                skipped.append(has_data and s not in present)
        return {
            "date": r["date"],
            "end_delay": r["end_delay"],
            "canceled": day_canceled,
            "max_delay": r["max_delay"],
            "max_station": r["max_station"],
            "series": series,
            "skipped": skipped,
            "historical": False,
        }

    # 近 3 天逐站曲线（按 stations 顺序索引填值，缺失填 None —— 保证长度一致）
    curve_dates = [r["date"] for r in data_recs[-3:]]
    curve = [_build_curve_entry(r, stations) for r in data_recs[-3:]]
    # 若近 3 天全部准点（end_delay 恒为 0），逐站折线图会一片空白、看似"没加载"。
    # 此时向后回溯最近有实际延误的若干天作为「历史参考曲线」，确保图表有内容可看；
    # historical=True 供前端标注"历史参考"，与近 3 天实况区分。
    if curve and all((c.get("end_delay") or 0) == 0 for c in curve):
        hist_pool = [r for r in data_recs[:-3] if r.get("rows") and (r.get("end_delay") or 0) > 0]
        for r in hist_pool[-3:]:
            entry = _build_curve_entry(r, stations)
            # 仅保留确实带回逐站 adelay 的历史日；否则该日序列全 null，折线反而误导
            if any(v is not None for v in entry["series"]):
                entry["historical"] = True
                curve.append(entry)

    prediction = predict(recs, args.destination)
    # 运行中补正标记（列车未终到、DB 实时给出当前延误 → 预测已用当前延误修正）
    running = None
    today_row = recs[today_idx] if (today_idx is not None and today_idx >= 0
                                    and today_idx < len(recs)) else None
    if today_row and today_row.get("_db_running"):
        running = {
            "current_delay": today_row.get("_db_current_delay"),
            "current_station": today_row.get("_db_current_station", ""),
        }
    # 接入已训练 LightGBM v5hr 模型（主预测）；失败/越界类型 → None，保留基线
    model_pred = predict_with_model(
        train=train,
        destination=args.destination,
        final_station=(stations[-1] if stations else ""),
        current_delay=prediction.get("today_actual"),
        line_number=(ride.get("line_number")
                     if isinstance(ride, dict) else None),
    )
    out = {
        "train": train,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "query_date": date.today().isoformat(),
        "prediction_date": prediction_date,
        "prediction": prediction,
        "model": model_pred,  # None = 未使用模型（降级基线）
        "running": running,   # 运行中列车：{current_delay, current_station}，预测已补正
        "on_time_prob": (round(max(0.0, 1.0 - model_pred["prob_ge15"]), 4)
                         if (model_pred and model_pred.get("prob_ge15") is not None)
                         else prediction.get("on_time_prob")),
        "recent": [{
            "date": r["date"], "end_delay": r["end_delay"],
            "max_delay": r["max_delay"], "max_station": r["max_station"],
            # 数据源标记：""/cached=zugfinder；piebro=本地历史；db_realtime=DB官方实时
            "source": r.get("source", "") or ("cached" if r.get("cached") else ""),
        } for r in recs],
        # 10 天逐站延误：仅用 zugfinder 数据（图表区域不混入 PieBro 本地/DB 实时）
        "station_days": _station_days(
            [r for r in recs if (r.get("source") or "") not in ("piebro", "db_realtime")], 10),
        "ride": ride,                  # 作用①：定位到的唯一列车号（可能为空 dict）
        "cancellation_prob": cancellation_prob,  # 实验性取消概率
        "db_status": db_status,        # 德铁次日开行校验（实验）
        "stations": stations,
        "curve": curve,          # 近 3 天逐站（series 对齐 stations）
        "today_stations": (data_recs[-1].get("rows") if data_recs else []),
        "days_stations": [{"date": r["date"], "stations": r.get("rows") or []}
                          for r in data_recs[-3:]],
        "n_valid_days": n_valid,        "n_rate_limited_days": n_limited,
        "hist_extension": {"window_days": HIST_WINDOW_DAYS,
                           "piebro_hist_days": piebro_hist_added},
        # 线路联邦州指纹（同名车次多线路识别）
        "line": {
            "main_states": sorted(main_states),
            "cross_line_filtered_days": line_filtered_days,
            "conflict": line_conflict,
            "destination_auto": line_destination_auto or None,
            "queried_destination": line_queried_destination or None,
        },
        "canceled_days": [r["date"] for r in recs if r.get("canceled")],
        "source": _source_label(recs),
        "data_date_range": _data_date_range(recs),
        # 友好提示：0 有效天且无限流 → 车次可能不存在
        "warning": (_train_not_found_warning(train, recs, n_valid, n_limited)
                     if n_valid == 0 else None),
    }

    print(json.dumps(out, ensure_ascii=False,
                     indent=2 if args.json_pretty else None))
    return 0


if __name__ == "__main__":
    # Windows 默认控制台编码可能是 GBK；stdout 是给 Node 读取的 JSON 通道。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
