#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_trainset.py — 聚合月度清洗数据(2024-07~2026-08) + 9月raw解析表 → 日×车型训练表

口径:
  月度文件(data/piebro/data-YYYY-MM.parquet): train_type / time / delay_in_min / is_canceled
  9月raw(data/parsed/stops_2026-09.parquet):  train_cat → train_type, delay_dep_min → delay_in_min,
                                              cancelled → is_canceled
输出: data/daily_cat/daily_cat_stats.parquet  每行 = (date, train_type)
  n_stops n_cancel cancel_rate avg_delay med_delay p90_delay pct_ge5 pct_ge10
"""
import glob, os, sys, shutil
from multiprocessing import Pool
import pandas as pd
import pyarrow.parquet as pq

PIEBRO = "/root/traindelay/data/piebro"
RAW9 = "/root/traindelay/data/parsed/stops_2026-09.parquet"
OUT = "/root/traindelay/data/daily_cat/daily_cat_stats.parquet"
TMP = "/root/traindelay/data/daily_cat/tmp"

def agg(df, delay_col, cancel_col):
    df = df.copy()
    df["date"] = pd.to_datetime(df["time"]).dt.strftime("%Y-%m-%d")
    df[delay_col] = df[delay_col].where(df[delay_col] >= -15)  # 计划改点大负值→NaN
    ok = df[~df[cancel_col].fillna(False) & df[delay_col].notna()]
    g = df.groupby(["date", "train_type"])
    base = g.agg(n_stops=(delay_col, "size"),
                 n_cancel=(cancel_col, lambda s: int(s.fillna(False).sum())))
    ok_g = ok.groupby(["date", "train_type"])[delay_col]
    base["avg_delay"] = ok_g.mean().round(3)
    base["med_delay"] = ok_g.median()
    base["p90_delay"] = ok_g.quantile(0.9)
    base["pct_ge5"] = (ok_g.apply(lambda s: (s >= 5).mean()) * 100).round(2)
    base["pct_ge10"] = (ok_g.apply(lambda s: (s >= 10).mean()) * 100).round(2)
    base["cancel_rate"] = (base["n_cancel"] / base["n_stops"] * 100).round(3)
    return base.reset_index()

def worker_month(path):
    name = os.path.basename(path).replace(".parquet", "")
    out_path = os.path.join(TMP, f"m_{name}.parquet")
    if os.path.exists(out_path):  # 断点复用(流式聚合产物)
        d = pd.read_parquet(out_path)
        return (name, len(d))
    t = pq.read_table(path, columns=["train_type", "time", "delay_in_min", "is_canceled"])
    df = t.to_pandas()
    out = agg(df, "delay_in_min", "is_canceled")
    out.to_parquet(out_path, index=False)
    return (name, len(out))

def worker_sep(_=None):
    df = pd.read_parquet(RAW9,
        columns=["date", "train_cat", "delay_dep_min", "cancelled"])
    df = df.rename(columns={"train_cat": "train_type", "delay_dep_min": "delay_in_min",
                            "cancelled": "is_canceled"})
    df["time"] = pd.to_datetime(df["date"])
    out = agg(df, "delay_in_min", "is_canceled")
    out.to_parquet(os.path.join(TMP, "m_sep2026_raw.parquet"), index=False)
    return ("sep2026_raw", len(out))

def main():
    os.makedirs(TMP, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    files = sorted(glob.glob(os.path.join(PIEBRO, "data-*.parquet")))
    cache = os.path.join(os.path.dirname(OUT), "monthly_agg.parquet")
    sig = "|".join(os.path.basename(f) for f in files)

    # 月度聚合缓存: 文件集合未变则复用(每日流水线只重聚 9 月 raw)
    full_months = None
    if os.path.exists(cache) and "--rebuild-months" not in sys.argv:
        cached = pd.read_parquet(cache)
        if len(cached) and cached["_sig"].iloc[0] == sig:
            full_months = cached.drop(columns=["_sig"])
            print(f"月度缓存命中: {len(full_months)} 行")
    if full_months is None:
        print(f"月度文件 {len(files)} 个", flush=True)
        with Pool(min(4, os.cpu_count())) as p:
            for name, n in p.imap_unordered(worker_month, files):
                print(f"  {name}: {n} 行", flush=True)
        mp = [pd.read_parquet(f) for f in glob.glob(os.path.join(TMP, "m_data-*.parquet"))]
        full_months = pd.concat(mp, ignore_index=True).drop_duplicates(
            subset=["date", "train_type"], keep="last")
        full_months["_sig"] = sig
        full_months.to_parquet(cache, index=False)
        print(f"月度缓存写入: {len(full_months)} 行")

    _, n = worker_sep()
    print(f"  sep2026_raw: {n} 行", flush=True)
    sep = pd.read_parquet(os.path.join(TMP, "m_sep2026_raw.parquet"))

    full = pd.concat([full_months, sep], ignore_index=True)
    # 9月底月度文件出现时与raw重叠 → raw口径优先
    full["_raw"] = full["date"].str.startswith("2026-09")
    full = full.sort_values(["date", "train_type", "_raw"]).drop_duplicates(
        subset=["date", "train_type"], keep="last").drop(columns=["_raw"])
    full = full.sort_values(["date", "train_type"]).reset_index(drop=True)
    full.to_parquet(OUT, index=False)
    print(f"输出 {OUT}: {len(full)} 行, 日期 {full['date'].min()} ~ {full['date'].max()}")
    print("车型分布(按停站数):")
    print(full.groupby("train_type")["n_stops"].sum().sort_values(ascending=False).to_string())
    shutil.rmtree(TMP, ignore_errors=True)

if __name__ == "__main__":
    main()
