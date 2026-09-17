#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""parse_delay_pipeline.py — DB timetables raw 存档 → 结构化晚点表（流式低内存版）

输入: /root/traindelay/data/db_raw/*.parquet   (piebro/deutsche-bahn-data raw_data)
  - timetables/v1/plan  计划时刻: <s id><tl f=类别 n=车次><ar/dp pt=计划时刻 YYMMDDHHMM>
  - timetables/v1/fchg  实际变更: <s id><ar/dp ct=实际/预测时刻 cl=取消><m t=d c=晚点原因>
  关联键: <s id> 全局唯一 (trip×车站)

输出: /root/traindelay/data/parsed/
  - stops_2026-09.parquet   逐停级: 车次×车站 计划/实际时刻 + 晚点分钟
  - daily_stats_2026-09.csv 每日趋势: 准点率/晚点分布/取消数/晚点原因Top

内存策略: cgroup 限 8G → worker 解析单文件后直接落盘 tmp parquet(无大数据回传),
          主进程分批 concat + 逐级去重。
"""
import glob, os, re, sys, shutil
from multiprocessing import Pool
from datetime import datetime
import xml.etree.ElementTree as ET
import pandas as pd
import pyarrow.parquet as pq

RAW_DIR = "/root/traindelay/data/db_raw"
OUT_DIR = "/root/traindelay/data/parsed"
TMP_DIR = os.path.join(OUT_DIR, "tmp")
PREFIX = "2026-09"

RE_PLAN = re.compile(r"/plan/(\d+)/\d{6}/\d{2}$")
RE_FCHG = re.compile(r"/fchg/(\d+)$")

PLAN_COLS = ["sid", "eva", "station", "train_cat", "train_num", "line",
             "sched_arr", "sched_dep"]
FCHG_COLS = ["sid", "obs_ts", "real_arr", "real_dep", "cl_arr", "cl_dep",
             "delay_codes", "msg_cats"]

def parse_ts(s):
    """YYMMDDHHMM → datetime；异常返回 NaT"""
    try:
        return datetime(2000 + int(s[0:2]), int(s[2:4]), int(s[4:6]),
                        int(s[6:8]), int(s[8:10]))
    except Exception:
        return pd.NaT

def parse_plan_row(url, resp):
    m = RE_PLAN.search(url or "")
    if not m:
        return []
    eva = m.group(1)
    try:
        root = ET.fromstring(resp)
    except Exception:
        return []
    station = root.get("station") or ""
    out = []
    for s in root.iter("s"):
        tl = s.find("tl")
        ar, dp = s.find("ar"), s.find("dp")
        pt_arr = ar.get("pt") if ar is not None else None
        pt_dep = dp.get("pt") if dp is not None else None
        line = (ar.get("l") if ar is not None else None) or (dp.get("l") if dp is not None else None)
        # 车型: tl@c = 细车型(ICE/RB/RE/私铁, 与月度清洗数据 train_type 同口径), 缺失回退 f
        cat = (tl.get("c") or tl.get("f")) if tl is not None else None
        out.append((
            s.get("id"), eva, station,
            cat,
            tl.get("n") if tl is not None else None,
            line,
            parse_ts(pt_arr) if pt_arr else pd.NaT,
            parse_ts(pt_dep) if pt_dep else pd.NaT,
        ))
    return out

def parse_fchg_row(ts, url, resp):
    m = RE_FCHG.search(url or "")
    if not m:
        return []
    try:
        root = ET.fromstring(resp)
    except Exception:
        return []
    out = []
    for s in root.iter("s"):
        ar, dp = s.find("ar"), s.find("dp")
        ct_arr = ar.get("ct") if ar is not None else None
        cl_arr = ar.get("cl") if ar is not None else None
        ct_dep = dp.get("ct") if dp is not None else None
        cl_dep = dp.get("cl") if dp is not None else None
        # 晚点原因(t=d, c=DB延误编码)挂在 ar/dp 内层, 不在 s 级
        codes = set()
        for el in (ar, dp):
            if el is not None:
                for mm in el.findall("m"):
                    if mm.get("t") == "d" and mm.get("c"):
                        codes.add(mm.get("c"))
        codes = ",".join(sorted(codes))
        hcats = ",".join(sorted({mm.get("cat") for mm in s.findall("m")
                                 if mm.get("t") == "h" and mm.get("cat")}))
        if not (ct_arr or ct_dep or cl_arr or cl_dep or codes or hcats):
            continue
        out.append((
            s.get("id"), ts,
            parse_ts(ct_arr) if ct_arr else pd.NaT,
            parse_ts(ct_dep) if ct_dep else pd.NaT,
            cl_arr, cl_dep, codes, hcats,
        ))
    return out

def worker(args):
    idx, path = args
    t = pq.read_table(path, columns=["api_name", "url", "timestamp",
                                     "response_data", "status_code"]).to_pandas()
    t = t[t["status_code"].astype(str) == "200"]  # 列实为字符串 "200"
    plan_rows, fchg_rows = [], []
    for api, url, ts, resp in t[["api_name", "url", "timestamp", "response_data"]].itertuples(index=False):
        if not isinstance(resp, str) or not resp:
            continue
        if api == "timetables/v1/plan":
            plan_rows += parse_plan_row(url, resp)
        elif api == "timetables/v1/fchg":
            fchg_rows += parse_fchg_row(ts, url, resp)
    plan = pd.DataFrame(plan_rows, columns=PLAN_COLS)
    fchg = pd.DataFrame(fchg_rows, columns=FCHG_COLS)
    n_plan = len(plan); n_fchg = len(fchg)
    del plan_rows, fchg_rows, t
    # 文件内预去重（控制后续 concat 体量）
    if not plan.empty:
        plan = plan.drop_duplicates(subset="sid", keep="first")
    if not fchg.empty:
        fchg = (fchg.sort_values("obs_ts")
                    .drop_duplicates(subset="sid", keep="last"))
    plan.to_parquet(os.path.join(TMP_DIR, f"plan_{idx:02d}.parquet"), index=False)
    fchg.to_parquet(os.path.join(TMP_DIR, f"fchg_{idx:02d}.parquet"), index=False)
    return (idx, n_plan, n_fchg)

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    shutil.rmtree(TMP_DIR, ignore_errors=True)
    os.makedirs(TMP_DIR, exist_ok=True)
    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.parquet")))
    print(f"输入 {len(files)} 个 raw 文件", flush=True)

    nproc = min(4, os.cpu_count() or 1)
    with Pool(nproc) as p:
        for idx, n_plan, n_fchg in p.imap_unordered(worker, list(enumerate(files))):
            print(f"  文件{idx:02d}: plan {n_plan:,} 行 → 预去重; fchg {n_fchg:,} 行 → 终值", flush=True)

    # ---- 合并 plan ----
    parts = []
    for f in sorted(glob.glob(os.path.join(TMP_DIR, "plan_*.parquet"))):
        d = pd.read_parquet(f)
        if not d.empty:
            parts.append(d.drop_duplicates(subset="sid", keep="first"))
    plan = (pd.concat(parts, ignore_index=True)
              .drop_duplicates(subset="sid", keep="first"))
    del parts
    print(f"plan 全局去重后 unique trip×station {len(plan):,}", flush=True)
    if plan.empty:
        sys.exit("错误: plan 解析为空，检查过滤条件")

    # ---- 合并 fchg（全局取 obs_ts 最新）----
    parts = []
    for f in sorted(glob.glob(os.path.join(TMP_DIR, "fchg_*.parquet"))):
        d = pd.read_parquet(f)
        if not d.empty:
            parts.append(d)
    fchg = (pd.concat(parts, ignore_index=True)
              .sort_values("obs_ts")
              .drop_duplicates(subset="sid", keep="last"))
    del parts
    print(f"fchg 全局最终观测 {len(fchg):,}", flush=True)

    stops = plan.merge(fchg.drop(columns=["obs_ts"]), on="sid", how="left")
    del plan, fchg

    stops["train_label"] = (stops["train_cat"].fillna("") + " " +
                            stops["train_num"].fillna("")).str.strip()
    stops.loc[stops["train_label"] == "", "train_label"] = stops["sid"]

    # 晚点分钟 = 实际 - 计划
    for k, (real, sched) in {"arr": ("real_arr", "sched_arr"),
                             "dep": ("real_dep", "sched_dep")}.items():
        delta = pd.to_datetime(stops[real]) - pd.to_datetime(stops[sched])
        stops[f"delay_{k}_min"] = (delta.dt.total_seconds() / 60.0).where(
            stops[real].notna() & stops[sched].notna())
        # 夜车改点等计划变更会产生大负值(ct 早于 pt)，非真实早到，置缺失
        stops.loc[stops[f"delay_{k}_min"] < -15, f"delay_{k}_min"] = pd.NA
    stops["cancelled"] = (stops["cl_arr"] == "1") | (stops["cl_dep"] == "1")

    # 运营日: 优先计划出发日期，其次计划到达
    stops["date"] = pd.to_datetime(stops["sched_dep"].fillna(stops["sched_arr"])).dt.strftime("%Y-%m-%d")

    keep = ["sid", "eva", "station", "date", "train_cat", "train_num", "train_label",
            "line", "sched_arr", "sched_dep", "real_arr", "real_dep",
            "delay_arr_min", "delay_dep_min", "cancelled", "delay_codes", "msg_cats"]
    stops = stops[keep]
    out_parquet = os.path.join(OUT_DIR, f"stops_{PREFIX}.parquet")
    stops.to_parquet(out_parquet, index=False)
    print(f"输出 {out_parquet}  ({len(stops):,} 行)", flush=True)

    # ---- 每日趋势统计 ----
    dep = stops[stops["sched_dep"].notna() & stops["real_dep"].notna() & ~stops["cancelled"]]
    rows = []
    for date, g in dep.groupby("date"):
        d = g["delay_dep_min"]
        day_stops = stops[stops["date"] == date]
        top_codes = (g["delay_codes"].dropna()[g["delay_codes"].dropna() != ""]
                     .str.split(",").explode().value_counts().head(5).to_dict())
        rows.append({
            "date": date,
            "stops_total": int(len(day_stops)),
            "trips": int(g["train_label"].nunique()),
            "cancelled": int(day_stops["cancelled"].sum()),
            "avg_delay_min": round(d.mean(), 2),
            "median_delay_min": round(d.median(), 2),
            "p90_delay_min": round(d.quantile(0.9), 1),
            "pct_on_time_le1": round((d <= 1).mean() * 100, 1),
            "pct_delay_ge3": round((d >= 3).mean() * 100, 1),
            "pct_delay_ge5": round((d >= 5).mean() * 100, 1),
            "pct_delay_ge10": round((d >= 10).mean() * 100, 1),
            "pct_delay_ge30": round((d >= 30).mean() * 100, 1),
            "top_delay_codes": " | ".join(f"{k}:{v}" for k, v in top_codes.items()),
        })
    daily = pd.DataFrame(rows).sort_values("date")
    out_csv = os.path.join(OUT_DIR, f"daily_stats_{PREFIX}.csv")
    daily.to_csv(out_csv, index=False, encoding="utf-8-sig")
    print(f"输出 {out_csv}  ({len(daily)} 天)")
    print()
    print(daily.to_string(index=False, max_colwidth=42))

    shutil.rmtree(TMP_DIR, ignore_errors=True)

if __name__ == "__main__":
    main()
