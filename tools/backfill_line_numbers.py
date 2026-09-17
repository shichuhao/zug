#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
回填 timetable_re_rb.json 中 ICE / IC / FLX 记录的 line_number
================================================================
问题（2026-09-18 定位）：
    data/timetable_re_rb.json 共 39098 条，其中
      RE/RB    37219 条  -> line_number 正常（"RE 11" / "RB 36"）
      ICE       1449 条  -> line_number 全部为空字符串 ""
      IC         372 条  -> 同上
      FLX         58 条  -> 同上
    server.js 的 findServices() 按「车次号」匹配（"ICE 847" -> num "847"），
    长途车次没有号 → 永远 count:0，
    表现为 /api/services?line=ICE%20847 返回 {"count":0,"services":[]}。

修复思路：
    PieBro parquet（data/piebro/*.parquet）里有每个车次的
      train_type   = "ICE"
      train_number = "847"
      station_name / departure_planned_time / arrival_planned_time
    用 (train_type, 起点站, 终点站) 或 (train_type, 途经站集合) 去匹配
    timetable 里 line_number 为空的长途记录，把 "ICE 847" 写回去。

用法：
    python3 tools/backfill_line_numbers.py --dry-run   # 只报告，不写文件
    python3 tools/backfill_line_numbers.py --write     # 实际写入（自动备份）
"""

import argparse
import collections
import glob
import json
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMETABLE = os.path.join(ROOT, "data", "timetable_re_rb.json")
PIEBRO_DIR = os.path.join(ROOT, "data", "piebro")
LONG_DISTANCE = ("ICE", "IC", "EC", "FLX")
# 参与回填的月份数（越新越好，控制内存）
RECENT_MONTHS = int(os.environ.get("BACKFILL_MONTHS", "6"))


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def norm_station(s):
    """站名归一：去掉 Hbf/Pbf 等后缀差异带来的干扰，仅用于模糊匹配。"""
    s = str(s or "").strip()
    for suf in (" Hauptbahnhof", " Hbf", " Pbf", " (Main)", " Bf"):
        if s.endswith(suf):
            s = s[: -len(suf)]
            break
    return s.lower().replace(" ", "").replace("-", "").replace("ü", "u").replace("ö", "o").replace("ä", "a").replace("ß", "ss")


def load_piebro_services():
    """
    从最近的 parquet 里构建：
        trips[(train_type, train_number)] = [ {stations:[...], dep:"HH:MM", arr:"HH:MM"}, ... ]
    只保留长途车次，控制内存。
    """
    files = sorted(glob.glob(os.path.join(PIEBRO_DIR, "data-*.parquet")))
    if not files:
        log("!! 未找到 parquet 文件: %s" % PIEBRO_DIR)
        return {}
    files = files[-RECENT_MONTHS:]
    log("读取 parquet（最近 %d 个）: %s" % (len(files), [os.path.basename(f) for f in files]))

    try:
        import pyarrow.parquet as pq
        import pyarrow.compute as pc
    except ImportError:
        log("!! 需要 pyarrow: pip install pyarrow")
        return {}

    trips = collections.defaultdict(list)
    for f in files:
        t0 = time.time()
        table = pq.read_table(
            f,
            columns=["train_type", "train_number", "station_name",
                     "departure_planned_time", "arrival_planned_time",
                     "train_line_station_num"],
        )
        # 只留长途
        mask = None
        for tt in LONG_DISTANCE:
            m = pc.equal(table.column("train_type"), tt)
            mask = m if mask is None else pc.or_(mask, m)
        if mask is not None:
            table = table.filter(mask)
        rows = table.to_pylist()
        log("  %s: 长途行数 %d (%.1fs)" % (os.path.basename(f), len(rows), time.time() - t0))

        # 按 (type, number, 日期) 聚合成班次
        by_ride = collections.defaultdict(list)
        for r in rows:
            num = r.get("train_number")
            tt = r.get("train_type")
            if not num or not tt:
                continue
            st = r.get("station_name")
            if not st:
                continue
            seq = r.get("train_line_station_num")
            tstamp = r.get("departure_planned_time") or r.get("arrival_planned_time")
            day = str(tstamp)[:10] if tstamp else ""
            by_ride[(tt, str(num), day, seq is not None and str(seq)[:1] or "")].append(
                (seq if seq is not None else 0, st,
                 r.get("departure_planned_time"), r.get("arrival_planned_time"))
            )

        for (tt, num, day, _), stops in by_ride.items():
            stops.sort(key=lambda x: (x[0] if x[0] is not None else 0))
            names = [s[1] for s in stops]
            # 去重相邻重复
            dedup = [n for i, n in enumerate(names) if i == 0 or n != names[i - 1]]
            if len(dedup) < 2:
                continue
            dep = None
            arr = None
            for _, _, d, _a in stops:
                if d:
                    dep = str(d)[11:16]
                    break
            for _, _, _d, a in reversed(stops):
                if a:
                    arr = str(a)[11:16]
                    break
            trips[(tt, num)].append({
                "stations": dedup,
                "stations_norm": [norm_station(x) for x in dedup],
                "from": dedup[0], "to": dedup[-1],
                "dep": dep, "arr": arr,
            })
    return trips


def match_score(t_rec, cand):
    """
    给 timetable 记录与候选班次打分：站序重合度。
    返回 0~1，越高越可信。

    注意（2026-09-18 调优）：早期版本要求「首末站完全相同」，召回率只有 17%。
    实际数据里 parquet 的班次边界与 timetable 的截取范围常不一致
    （例如 timetable 记 Hamburg Dammtor→München Hbf，
      而 parquet 把同一班次记为 Hamburg-Altona→München Hbf）。
    故改为：端点**允许包含关系**，主要看途经站重合率。
    """
    t_st = [norm_station(x) for x in (t_rec.get("stations") or [])]
    if len(t_st) < 2:
        return 0.0
    c_st = cand["stations_norm"]
    if len(c_st) < 2:
        return 0.0

    tset, cset = set(t_st), set(c_st)
    # 端点关系：完全相同=满分；一个是另一个的子集=次之；毫不相干=0
    ends_ok = (t_st[0] == c_st[0] and t_st[-1] == c_st[-1])
    if ends_ok:
        end_bonus = 1.0
    elif (t_st[0] in cset and t_st[-1] in cset) or (c_st[0] in tset and c_st[-1] in tset):
        end_bonus = 0.55
    elif t_st[0] in cset or t_st[-1] in cset:
        end_bonus = 0.25
    else:
        return 0.0  # 无任何端点交集，直接判否定
    inter = len(tset & cset)
    jac = inter / float(len(tset | cset))  # Jaccard
    return 0.45 * end_bonus + 0.55 * jac


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--min-score", type=float, default=0.6)
    args = ap.parse_args()
    if not args.dry_run and not args.write:
        args.dry_run = True

    log("加载时刻表: %s" % TIMETABLE)
    with open(TIMETABLE, encoding="utf-8") as f:
        records = json.load(f)
    log("总记录: %d" % len(records))

    need = [r for r in records if str(r.get("train_type", "")).upper() in LONG_DISTANCE
            and not str(r.get("line_number", "")).strip()]
    log("缺少 line_number 的长途记录: %d" % len(need))
    if not need:
        log("无需回填，退出。")
        return 0

    trips = load_piebro_services()
    log("候班长途 (type,number) 组合数: %d" % len(trips))

    # 建两级索引加速：
    #   1) 精确端点索引（快，覆盖大多数）
    #   2) 按 train_type 分桶（兜底，处理边界不一致的班次）
    idx = collections.defaultdict(list)
    by_type = collections.defaultdict(set)
    for (tt, num), lst in trips.items():
        by_type[tt].add(num)
        for c in lst:
            idx[(tt, c["stations_norm"][0], c["stations_norm"][-1])].append((num, c))
            # 同时按「首站」和「末站」各建一份，便于边界包含匹配
            idx[(tt, "FROM:" + c["stations_norm"][0], "")].append((num, c))
            idx[(tt, "", "TO:" + c["stations_norm"][-1])].append((num, c))
    log("按类型可用的车次号: %s" % {k: len(v) for k, v in by_type.items()})

    filled = 0
    skipped = 0
    multi = 0
    for r in need:
        tt = str(r.get("train_type", "")).upper()
        st = [norm_station(x) for x in (r.get("stations") or [])]
        if len(st) < 2:
            skipped += 1
            continue
        # 候选 = 精确端点 ∪ 同首站 ∪ 同末站（去重）
        pool = {}
        for key in ((tt, st[0], st[-1]),
                    (tt, "FROM:" + st[0], ""),
                    (tt, "", "TO:" + st[-1])):
            for num, c in idx.get(key, ()):
                pool[(num, id(c))] = (num, c)
        if not pool:
            skipped += 1
            continue
        scored = []
        for num, c in pool.values():
            s = match_score(r, c)
            if s >= args.min_score:
                scored.append((s, num, c))
        if not scored:
            skipped += 1
            continue
        scored.sort(key=lambda x: -x[0])
        best = scored[0]
        nums = {x[1] for x in scored if x[0] >= best[0] - 1e-9}
        if len(nums) > 1:
            multi += 1
        r["line_number"] = "%s %s" % (tt, best[1])
        r["_backfill_score"] = round(best[0], 3)
        filled += 1

    log("")
    log("=" * 56)
    log("可回填: %d 条" % filled)
    log("无法匹配: %d 条" % skipped)
    log("多候选（取了最高分）: %d 条" % multi)
    log("=" * 56)

    samples = [r for r in need if str(r.get("line_number", "")).strip()][:10]
    for r in samples:
        log("  %s  %s → %s  (score=%s)" % (
            r.get("line_number"), r.get("from_station"), r.get("to_station"), r.get("_backfill_score")))

    if args.write:
        bak = TIMETABLE + ".bak-%s" % time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(TIMETABLE, bak)
        log("已备份: %s" % bak)
        for r in records:
            r.pop("_backfill_score", None)
        tmp = TIMETABLE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False)
        os.replace(tmp, TIMETABLE)
        log("已写入: %s" % TIMETABLE)
    else:
        log("(dry-run，未写入；加 --write 落盘)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
