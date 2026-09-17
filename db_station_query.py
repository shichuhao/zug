#!/usr/bin/env python3
"""db_station_query.py —— 站对站实时班次查询（接入 bahn.expert / IRIS）

用法：
  python db_station_query.py --from "Berlin-Charlottenburg" --to "Dessau Hbf" --time "23:00"
  python db_station_query.py --from Charlottenburg --to Dessau --time 22:00 --types RE,RB

输出 JSON 到 stdout，供 server.js /api/routes-live 调用。

数据源：
  1. 本地时刻表 timetable_re_rb.json（候选线路索引：哪些 line 走 A→B）
  2. bahn.expert tRPC（IRIS/HAFAS 官方后端）：
     - stopPlace.byTerm              → 站名 → EVA
     - journey.find                  → 列车号 → 今日实例
     - journey.detailsByJourneyId    → 完整路线 + 逐站实时延误

时间窗口：用户输入时间 ±90 分钟（宽容手滑）。
时区：bahn.expert 返回 UTC，自动转换为 CEST/CET（UTC+2/+1）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone, tzinfo

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

# ── 常量 ──────────────────────────────────────────────────────────
TIME_WINDOW_MIN = 90          # 时间窗口 ±N 分钟
ENRICH_DEADLINE_SEC = 12      # 每条 enrichment 整体硬上限（防止个别 find_journey 卡死）
PHASE3_DEADLINE_SEC = 22      # Phase 3 兜底扫描硬上限（涵盖并发 ~200 任务）
ENRICH_MAX_WORKERS = 3        # enrichment 并发（降并发避免触发 bahn.expert 限流）
PHASE3_MAX_WORKERS = 3        # Phase 3 并发（降并发 + 礼貌间隔，提升稳定性）
PHASE3_SCAN_CAP = 200         # Phase 3 单段最多扫 200 个号（足够覆盖任何一段）
PHASE3_POLITE_SLEEP = 0.04    # 每个探测前的微小间隔，摊平请求突发
FIVE_TYPES = ["RE", "RB", "IC", "ICE", "FLX"]
TIMETABLE_PATH = os.path.join(_HERE, "data", "timetable_re_rb.json")
PIEBRO_DIR = os.environ.get("PIEBRO_DIR", os.path.join(_HERE, "data", "piebro"))
_piebro_number_cache: dict[tuple[str, str, str, str], str] = {}
_piebro_rides_cache: dict[str, list[list[dict]]] = {}

# 德国时区：CEST (夏令 UTC+2) / CET (冬令 UTC+1)
class GermanyTZ(tzinfo):
    def utcoffset(self, dt):
        if dt and dt.month in (4,5,6,7,8,9) or (dt.month==3 and dt.day>=25) or (dt.month==10 and dt.day<=28):
            return timedelta(hours=2)
        return timedelta(hours=1)
    def dst(self, dt): return timedelta(0)
    def tzname(self, dt): return "CET/CEST"

_GER_TZ = GermanyTZ()


# ── 加载本地时刻表 ────────────────────────────────────────────────
def load_timetable() -> list[dict]:
    if not os.path.isfile(TIMETABLE_PATH):
        return []
    with open(TIMETABLE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def build_station_index(timetable):
    station_set = set()
    station_by_letter = {}
    for t in timetable:
        for s in t.get("stations", []):
            if not s or s in station_set:
                continue
            station_set.add(s)
            letter = s.strip()[:1].upper()
            if letter.isalpha():
                station_by_letter.setdefault(letter, []).append(s)
            else:
                station_by_letter.setdefault("#", []).append(s)
    return sorted(station_set), station_by_letter


def _norm_key(s):
    """站名归一化：'Hamm (Westf) Hbf' / 'Hamm(Westf)Hbf' → 'hammwestfhbf'"""
    return "".join(ch for ch in (s or "").strip().lower() if ch.isalnum())


def match_station(query, station_names):
    q = _norm_key(query)
    if not q:
        return []
    return [s for s in station_names if q in _norm_key(s)][:20]


# ── 时间工具 ──────────────────────────────────────────────────────
def to_min(hhmm):
    """'HH:MM' → 当天分钟数；无效返回 -1。"""
    m = re.match(r"^(\d{1,2}):(\d{2})$", (hhmm or "").strip())
    if not m:
        return -1
    return int(m.group(1)) * 60 + int(m.group(2))


def utc_to_local(iso_str):
    """将 ISO UTC 字符串转为本地 HH:MM（德国时间）。"""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        local = dt.astimezone(_GER_TZ)
        return local.strftime("%H:%M")
    except Exception:
        return None


def utc_delay_minutes(iso_str):
    """从 ISO 时间提取相对于计划时间的延误分钟数（取 departure.delay 或 arrival.delay）。"""
    # 这个函数不直接用 ISO 字符串，delay 字段在调用处直接读
    pass


def parse_line_number(line):
    """拆分线路号 → (type, number_str)。"""
    n = (line or "").strip().upper().replace(" ", "").replace("-", "")
    for prefix in ["ICE", "FLX", "RE", "RB", "IC"]:
        if n.startswith(prefix):
            return prefix, n[len(prefix):]
    return "", n if n.isdigit() else None


def _piebro_train_number(candidate):
    """Resolve a missing ICE/IC/FLX number from recent local stop history.

    PieBro stores these long-distance services by train_number rather than
    line_number.  Match the route direction and scheduled departure so the
    returned number can be sent directly to /api/train.
    """
    category = candidate.get("train_type", "")
    from_st = candidate.get("from_station", "")
    to_st = candidate.get("to_station", "")
    dep_time = candidate.get("dep_time", "")
    key = (category, from_st, to_st, dep_time)
    if key in _piebro_number_cache:
        return _piebro_number_cache[key]
    if category not in ("ICE", "IC", "FLX") or not os.path.isdir(PIEBRO_DIR):
        _piebro_number_cache[key] = ""
        return ""
    try:
        import pyarrow.compute as pc
        import pyarrow.parquet as pq
    except ImportError:
        _piebro_number_cache[key] = ""
        return ""
    columns = ["train_number", "train_line_ride_id", "train_line_station_num",
               "station_name", "time"]

    if category not in _piebro_rides_cache:
        files = sorted(
            f for f in os.listdir(PIEBRO_DIR)
            if f.startswith("data-") and f.endswith(".parquet")
        )
        rides = {}
        # The newest month is enough to identify a recurring service and keeps
        # the station-to-station request from scanning the archive repeatedly.
        for filename in reversed(files[-1:]):
            try:
                table = pq.read_table(
                    os.path.join(PIEBRO_DIR, filename), columns=columns,
                    filters=pc.field("train_type") == category,
                )
                for row in table.to_pylist():
                    number = str(row.get("train_number") or "").strip()
                    ride_id = row.get("train_line_ride_id")
                    if number and ride_id is not None:
                        rides.setdefault(str(ride_id), []).append(row)
            except Exception:
                continue
        _piebro_rides_cache[category] = list(rides.values())
    from_key, to_key = _norm_key(from_st), _norm_key(to_st)
    target_min = to_min(dep_time)
    best_number, best_diff = "", 9999
    for stops in _piebro_rides_cache[category]:
        stops.sort(key=lambda row: row.get("train_line_station_num") or 0)
        from_i = next((i for i, row in enumerate(stops)
                       if _norm_key(row.get("station_name", "")) == from_key), -1)
        if from_i < 0:
            continue
        to_i = next((i for i, row in enumerate(stops[from_i + 1:], start=from_i + 1)
                     if _norm_key(row.get("station_name", "")) == to_key), -1)
        if to_i < 0:
            continue
        stamp = str(stops[from_i].get("time") or "")
        actual_min = to_min(stamp[11:16]) if len(stamp) >= 16 else -1
        diff = abs(actual_min - target_min) if actual_min >= 0 and target_min >= 0 else 0
        if diff < best_diff:
            best_diff = diff
            best_number = str(stops[from_i].get("train_number") or "").strip()
    _piebro_number_cache[key] = best_number
    return best_number


# ── bahn.expert 实时数据 ─────────────────────────────────────────
try:
    from db_bahn_expert import search_station, find_journey, journey_details
    _HAS_BAHN_EXPERT = True
except Exception:
    _HAS_BAHN_EXPERT = False


def resolve_eva(name, max_results=3):
    """站名 → EVA 列表。"""
    if not _HAS_BAHN_EXPERT:
        return []
    try:
        return search_station(name, max_results=max_results)
    except Exception:
        return []


def _extract_stop_time(stop, kind="departure"):
    """从 stop 字典中提取 arrival 或 departure 的实时信息。

    Returns dict with keys: scheduled, actual, delay, platform, is_realtime.
    """
    info = stop.get(kind) or {}
    scheduled_raw = info.get("scheduledTime") or info.get("time") or ""
    actual_raw = info.get("time") or ""
    delay = info.get("delay")          # 分钟数或 None
    platform = info.get("platform") or info.get("scheduledPlatform") or ""
    is_realtime = info.get("isRealtime")

    scheduled_local = utc_to_local(scheduled_raw) if scheduled_raw else None
    actual_local = utc_to_local(actual_raw) if actual_raw else None

    return {
        "scheduled": scheduled_local,
        "actual": actual_local,
        "delay": delay,
        "platform": str(platform),
        "is_realtime": bool(is_realtime),
        "cancelled": info.get("cancelled"),
    }


def _find_stop_indices(stops, from_eva, to_eva, from_name="", to_name=""):
    """在 stops 列表中找 from/to 站的索引。返回 (fi, ti)，找不到为 -1。"""
    from_key = _norm_key(from_name)
    to_key = _norm_key(to_name)
    fi = ti = -1
    for i, s in enumerate(stops):
        sp = s.get("stopPlace") or {}
        eva = sp.get("evaNumber", "")
        name = sp.get("name", "")
        if fi < 0 and (eva == from_eva or (from_key and from_key in _norm_key(name))):
            fi = i
        if ti < 0 and (eva == to_eva or (to_key and to_key in _norm_key(name))):
            ti = i
    return fi, ti


def enrich_with_live(candidate, from_eva, to_eva, from_name, to_name,
                     target_time_min=-1, deadline_ts=0):
    """用 bahn.expert 补充一条候选线路的今日实时数据。
    关键：find_journey + detailsByJourneyId 串行执行，遇阻即退。
    增加 deadline_ts 兜底：超过此时间戳直接返回原候选（防止个别卡死阻塞整体）。
    """
    if not _HAS_BAHN_EXPERT:
        return candidate

    line = candidate.get("line_number", "")
    ttype, num = parse_line_number(line)
    if not num:
        return candidate

    try:
        jnum = int(num)
    except (ValueError, TypeError):
        return candidate

    # 按优先级尝试 category
    cats = [ttype] if ttype else ["RE", "RB"] + [c for c in FIVE_TYPES if c not in ("RE", "RB")]

    best_result = None
    best_diff = 9999

    for cat in cats:
        if time.time() > deadline_ts:
            break  # 全局超时：放弃后续尝试
        try:
            instances = find_journey(jnum, cat)
        except Exception:
            continue
        if not instances or not isinstance(instances, list):
            continue

        for inst in instances:
            if time.time() > deadline_ts:
                break
            jid = inst.get("journeyId")
            if not jid:
                continue
            try:
                det = journey_details(jid)
            except Exception:
                continue
            if not det:
                continue

            stops = det.get("stops") or []
            fi, ti = _find_stop_indices(stops, from_eva, to_eva, from_name, to_name)
            if fi < 0 or ti < 0:
                continue  # 这趟实例不走 A→B

            dep_info = _extract_stop_time(stops[fi], "departure")
            arr_info = _extract_stop_time(stops[ti], "arrival")

            # 计算实际发车时间（分钟数），用于时间窗口过滤
            dep_actual = dep_info["actual"] or dep_info["scheduled"]
            dep_min = to_min(dep_actual) if dep_actual else -1

            # 时间窗口检查
            if target_time_min >= 0 and dep_min >= 0:
                diff = abs(dep_min - target_time_min)
                if diff > TIME_WINDOW_MIN:
                    continue  # 超出窗口，跳过
                # 取最接近目标时间的实例
                if diff > best_diff:
                    continue
                best_diff = diff

            # 构建增强结果
            result = dict(candidate)
            result["source"] = "db_realtime"
            result["journey_id"] = jid
            result["journey_number"] = jnum
            result["category"] = cat
            result["display_name"] = det.get("train", {}).get("name") or f"{cat} {jnum}"

            # 实时覆盖静态时间
            if dep_info["actual"]:
                result["dep_time"] = dep_info["actual"]
            if arr_info["actual"]:
                result["arr_time"] = arr_info["actual"]

            result["dep_delay"] = dep_info["delay"]
            result["arr_delay"] = arr_info["delay"]
            result["dep_platform"] = dep_info["platform"]
            result["arr_platform"] = arr_info["platform"]
            result["is_realtime"] = dep_info["is_realtime"] or arr_info["is_realtime"]

            # 从 details 取方向确认
            first_dep = stops[fi].get("departure", {}) if fi >= 0 else {}
            transport = first_dep.get("transport", {})
            direction_stops = (transport.get("direction") or {}).get("stopPlaces", [])
            if direction_stops:
                result["direction"] = direction_stops[0].get("name", "")

            # 中间停站概要（可选：前3 + 后3）
            n_stops_between = ti - fi
            result["n_stops_real"] = max(0, n_stops_between)

            best_result = result

    return best_result or candidate


# ── 主查询逻辑 ────────────────────────────────────────────────────
def _direct_bahn_fallback(from_eva, to_eva, from_name, to_name,
                           time_min=-1, types=None, limit=20):
    """Phase 3 兜底：本地时刻表无结果时，直接用 bahn.expert 扫描今日实例。
    关键：并发扫描 + 整体 deadline + 单车型最多 PHASE3_SCAN_CAP 个号，
          避免之前 360+ 串行请求必超时→fall back→不稳定的问题。
    """
    if not _HAS_BAHN_EXPERT or not from_eva or not to_eva:
        return []

    cats = types or FIVE_TYPES
    is_evening = time_min < 0 or time_min >= 18 * 60 or time_min <= 6 * 60

    # 窄范围扫描：每段 100-200 个号，确保 22s 内能扫完
    ranges_by_cat = {
        "RE": [(3700, 3900)] if is_evening else [(1000, 1200), (700, 800)],
        "RB": [(3700, 3900)] if is_evening else [(1000, 1100)],
        "IC": [(2000, 2100), (3000, 3100)],
        "ICE": [(400, 600), (800, 1000), (2000, 2100)],
        "FLX": [(1, 50)],
    }

    deadline_ts = time.time() + PHASE3_DEADLINE_SEC
    results: list[dict] = []
    results_lock_seen: set[str] = set()
    seen_lock = __import__("threading").Lock()

    def _probe(jnum: int, cat: str) -> list[dict]:
        """单个车号探测：find_journey + detailsByJourneyId，过滤掉反向/超窗。"""
        out: list[dict] = []
        if PHASE3_POLITE_SLEEP:
            time.sleep(PHASE3_POLITE_SLEEP)
        try:
            instances = find_journey(jnum, cat)
        except Exception:
            return out
        if not instances or not isinstance(instances, list):
            return out
        for inst in instances:
            if time.time() > deadline_ts:
                break
            jid = inst.get("journeyId")
            if not jid:
                continue
            with seen_lock:
                if jid in results_lock_seen:
                    continue
                results_lock_seen.add(jid)
            try:
                det = journey_details(jid)
            except Exception:
                continue
            if not det:
                continue
            stops = det.get("stops") or []
            fi, ti = _find_stop_indices(stops, from_eva, to_eva, from_name, to_name)
            if fi < 0 or ti < 0 or fi >= ti:
                continue

            dep_info = _extract_stop_time(stops[fi], "departure")
            arr_info = _extract_stop_time(stops[ti], "arrival")
            dep_actual = dep_info["actual"] or dep_info["scheduled"]
            dep_m = to_min(dep_actual) if dep_actual else -1

            # 时间过滤
            if time_min >= 0 and dep_m >= 0:
                if dep_m < time_min - 30:
                    continue
                if dep_m > time_min + 240:
                    continue

            train = det.get("train", {})
            result = {
                "line_number": f"{cat} {jnum}",
                "train_type": cat,
                "from_station": from_name,
                "to_station": to_name,
                "dep_time": dep_actual,
                "arr_time": arr_info["actual"] or arr_info["scheduled"],
                "duration_min": None,
                "n_stops": ti - fi,
                "n_days": "?",
                "region": "",
                "source": "db_realtime",
                "journey_id": jid,
                "journey_number": jnum,
                "category": cat,
                "display_name": train.get("name", f"{cat} {jnum}"),
                "dep_delay": dep_info["delay"],
                "arr_delay": arr_info["delay"],
                "dep_platform": dep_info["platform"],
                "arr_platform": arr_info["platform"],
                "is_realtime": bool(dep_info["is_realtime"] or arr_info["is_realtime"]),
            }
            direction_stops = ((stops[fi].get("departure", {}) or {})
                               .get("transport", {}).get("direction", {})
                               .get("stopPlaces", []))
            if direction_stops:
                result["direction"] = direction_stops[0].get("name", "")
            out.append(result)
        return out

    # 组装所有要扫的 (cat, jnum) 任务
    tasks: list[tuple[int, str]] = []
    for cat in cats:
        if cat not in ranges_by_cat:
            continue
        for lo, hi in ranges_by_cat[cat]:
            upper = min(hi + 1, lo + PHASE3_SCAN_CAP)
            for jnum in range(lo, upper, 1):
                tasks.append((jnum, cat))

    # 并发探测；deadline 触发则停止提交新任务
    with ThreadPoolExecutor(max_workers=PHASE3_MAX_WORKERS) as ex:
        futures = {}
        for jnum, cat in tasks:
            if time.time() > deadline_ts:
                break
            futures[ex.submit(_probe, jnum, cat)] = (jnum, cat)
        for fut in as_completed(futures, timeout=PHASE3_DEADLINE_SEC + 2):
            if time.time() > deadline_ts:
                break
            try:
                chunk = fut.result(timeout=0.5) or []
            except Exception:
                continue
            results.extend(chunk)
            if len(results) >= limit:
                break

    results.sort(key=lambda r: r.get("dep_time") or "")
    return results[:limit]


def query_routes(from_q, to_q, time_q="", types_q="", limit=20):
    """站对站查询主入口。

    Returns dict: {routes: [...], from_candidates: [...], to_candidates: [...],
                   source: "timetable"|"mixed"|"realtime"}
    """
    timetable = load_timetable()
    station_names, _ = build_station_index(timetable)

    # 站名匹配
    from_match = match_station(from_q, station_names)
    to_match = match_station(to_q, station_names)

    if not from_match or not to_match:
        return {
            "error": from_match and "目的站未找到" or "起点站未找到",
            "from_candidates": from_match,
            "to_candidates": to_match,
            "routes": [],
        }

    from_set = set(from_match)
    to_set = set(to_match)
    types = [t.strip().upper() for t in types_q.split(",") if t.strip()] if types_q else []
    type_set = set(types) if types else None
    time_min = to_min(time_q)
    limit = min(max(limit, 1), 50)

    # ── Phase 1: 本地时刻表筛选候选线路（非对称窗口） ──
    # 窗口：向前看 30 分钟（宽容手滑），向后看 2 小时（覆盖邻近班次即可，
    #       不再返回 4 小时后「看起来错」的车次）。
    LOOKBACK_MIN = 30
    LOOKAHEAD_MIN = 120  # 2 小时
    candidates = []
    pair_seen = False            # 该 from→to 是否出现在本地时刻表（任何时段）
    all_dep_minutes = []         # 命中线路的计划发车分钟（用于提示最近/最晚班次）
    for t in timetable:
        if type_set and t.get("train_type") not in type_set:
            continue
        sts = t.get("stations", [])
        fi = next((i for i, s in enumerate(sts) if s in from_set), -1)
        if fi < 0:
            continue
        ti = next((i for i, s in enumerate(sts[fi + 1:], start=fi + 1) if s in to_set), -1)
        if ti < 0:
            continue
        pair_seen = True
        planned = t.get("planned_times", []) or []
        dep_min = to_min(planned[fi]) if fi < len(planned) else -1
        if dep_min < 0:
            continue
        all_dep_minutes.append(dep_min)
        # 非对称时间窗口
        if time_min >= 0 and dep_min < time_min - LOOKBACK_MIN:
            continue
        if time_min >= 0 and dep_min > time_min + LOOKAHEAD_MIN:
            continue
        arr_raw = planned[ti] if ti < len(planned) else None
        arr_safe = arr_raw if isinstance(arr_raw, str) and re.match(r"^\d{1,2}:\d{2}$", arr_raw) else None
        dur = (to_min(arr_raw) - dep_min) if isinstance(arr_raw, str) else None

        candidates.append({
            "line_number": t.get("line_number", ""),
            "train_type": t.get("train_type", ""),
            "from_station": sts[fi],
            "to_station": sts[ti],
            "dep_time": planned[fi] if fi < len(planned) else None,
            "arr_time": arr_safe,
            "duration_min": dur if dur and dur > 0 else None,
            "n_stops": ti - fi,
            "n_days": t.get("n_days", 0),
            "region": t.get("region", ""),
            "source": "timetable",
        })

    candidates.sort(key=lambda r: r.get("dep_time", ""))
    candidates = candidates[:limit]

    # ── Phase 2: bahn.expert 实时增强（并发，每条 ENRICH_DEADLINE_SEC 硬截断） ──
    has_live = False
    from_eva_list = resolve_eva(from_q)
    to_eva_list = resolve_eva(to_q)
    from_eva = from_eva_list[0]["evaNumber"] if from_eva_list else ""
    to_eva = to_eva_list[0]["evaNumber"] if to_eva_list else ""

    enriched: list[dict] = []
    if _HAS_BAHN_EXPERT and from_eva and to_eva and candidates:
        # 全局 deadline 防止整体阻塞；留 4s 给 Phase 3 / 结果组装
        deadline_ts = time.time() + min(ENRICH_DEADLINE_SEC, 25)

        def _enrich_one(idx_cand):
            i, c = idx_cand
            r = enrich_with_live(c, from_eva, to_eva,
                                 from_match[0], to_match[0],
                                 target_time_min=time_min,
                                 deadline_ts=deadline_ts)
            return i, r

        with ThreadPoolExecutor(max_workers=ENRICH_MAX_WORKERS) as ex:
            futures = [ex.submit(_enrich_one, (i, c)) for i, c in enumerate(candidates)]
            tmp = [None] * len(candidates)
            for fut in as_completed(futures, timeout=ENRICH_DEADLINE_SEC + 4):
                try:
                    i, r = fut.result(timeout=0.5)
                except Exception:
                    continue
                tmp[i] = r
                if r.get("source") == "db_realtime":
                    has_live = True
            # 保留原始顺序；未完成的（超时）回退到原始候选
            enriched = [tmp[i] if tmp[i] is not None else candidates[i] for i in range(len(candidates))]
    else:
        enriched = list(candidates)

    # PieBro keeps long-distance services under train_number (their
    # line_number is empty).  Fill that identifier from local history before
    # using the network-only scanner, so these cards remain actionable offline.
    for candidate in enriched:
        if not candidate.get("line_number"):
            number = _piebro_train_number(candidate)
            if number:
                candidate["journey_number"] = number
                candidate["line_number"] = "%s %s" % (candidate["train_type"], number)
                candidate["source"] = "piebro_history"

    # ── Phase 3: bahn.expert 实时扫描兜底 ──
    # ICE/IC/FLX 的本地 PieBro 时刻表没有 line_number，卡片无法构造 /api/train
    # 请求。对此只扫描缺号车型，并以找到的具体实时车次替换不可预测的本地卡片。
    missing_number_types = sorted({
        r.get("train_type", "") for r in enriched
        if not r.get("line_number") and r.get("train_type") in ("ICE", "IC", "FLX")
    })
    if (enriched and missing_number_types and _HAS_BAHN_EXPERT and from_eva and to_eva):
        numbered = _direct_bahn_fallback(from_eva, to_eva,
                                         from_match[0], to_match[0],
                                         time_min=time_min,
                                         types=missing_number_types,
                                         limit=limit)
        if numbered:
            found_types = {r.get("train_type", "") for r in numbered}
            enriched = [r for r in enriched if not (
                r.get("train_type") in found_types and not r.get("line_number")
            )]
            enriched.extend(numbered)
            enriched.sort(key=lambda r: r.get("dep_time") or "")
            enriched = enriched[:limit]
            has_live = True

    # 本地完全未知的站对站组合，扫描所有筛选车型作为最后努力。
    if not enriched and not pair_seen and _HAS_BAHN_EXPERT and from_eva and to_eva:
        types_for_fallback = list(type_set) if type_set else (types or FIVE_TYPES)
        fallback = _direct_bahn_fallback(from_eva, to_eva,
                                         from_match[0], to_match[0],
                                         time_min=time_min,
                                         types=types_for_fallback,
                                         limit=limit)
        if fallback:
            enriched = fallback
            has_live = True

    # ── 结果组装 ──
    if not enriched:
        hint = None
        if pair_seen and all_dep_minutes:
            # 线路存在，但当前时段无直达 → 诚实提示最近 / 最晚班次（不再抖动）
            if time_min >= 0:
                before = [m for m in all_dep_minutes if m <= time_min]
                after = [m for m in all_dep_minutes if m > time_min]
                last = max(before) if before else None
                nxt = min(after) if after else None

                def _fmt(m):
                    return "%02d:%02d" % (m // 60, m % 60)

                parts = []
                if last is not None:
                    parts.append("最晚 %s" % _fmt(last))
                if nxt is not None:
                    parts.append("最近 %s" % _fmt(nxt))
                hint = ("该线路今日有班次，但 %s 附近无直达（%s）。"
                        % (time_q or "当前时间", "，".join(parts)))
            else:
                hint = "该线路今日有班次，但未指定查询时间。"
        else:
            hint = (f"该时段（{time_q or '全天'}）附近无匹配直达车次。"
                    f" 已尝试德铁官方实时数据查询。" if _HAS_BAHN_EXPERT
                    else f"该时段（{time_q or '全天'}）附近无匹配直达车次")
        return {
            "routes": [],
            "from_candidates": from_match,
            "to_candidates": to_match,
            "hint": hint,
        }

    source_label = ("realtime" if has_live
                    and all(r.get("source") == "db_realtime" for r in enriched)
                    else ("mixed" if has_live else "timetable"))

    return {
        "routes": enriched,
        "from_candidates": from_match,
        "to_candidates": to_match,
        "source": source_label,
        "query_time": time_q or "",
        "time_window_min": TIME_WINDOW_MIN,
    }


# ── CLI 入口 ──────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description="站对站实时班次查询")
    p.add_argument("--from", dest="from_st", required=True, help="起点站")
    p.add_argument("--to", dest="to_st", required=True, help="目的站")
    p.add_argument("--time", default="", help="出发时间 HH:MM（可选，默认全天）")
    p.add_argument("--types", default="", help="车型逗号分隔，如 RE,RB,IC")
    p.add_argument("--limit", type=int, default=20, help="最大返回数")
    p.add_argument("--json-pretty", action="store_true", help="美化 JSON 输出")
    args = p.parse_args()

    result = query_routes(args.from_st, args.to_st, args.time, args.types, args.limit)
    indent = 2 if args.json_pretty else None
    json.dump(result, sys.stdout, ensure_ascii=False, indent=indent)


if __name__ == "__main__":
    main()
