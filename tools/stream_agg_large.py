#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stream_agg_large.py — 流式批聚合 6 个 600MB+ 大月度文件(iter_batches, 防僵死/OOM)

口径与 build_trainset 一致, 仅保留可跨批合并统计量:
  n_stops n_cancel cancel_rate avg_delay(=sum/count) pct_ge5 pct_ge10
输出: /root/traindelay/data/daily_cat/tmp/m_data-YYYY-MM.parquet (与大文件产物同格式)
"""
import glob, os, sys
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

PIEBRO = "/root/traindelay/data/piebro"
TMP = "/root/traindelay/data/daily_cat/tmp"
NEED = ["data-2025-11", "data-2025-12", "data-2026-01", "data-2026-02",
        "data-2026-03", "data-2026-04", "data-2026-05", "data-2026-06"]

def agg_file(path):
    name = os.path.basename(path).replace(".parquet", "")
    out_path = os.path.join(TMP, f"m_{name}.parquet")
    if os.path.exists(out_path):
        print(f"{name}: 已存在, 跳过", flush=True)
        return
    pf = pq.ParquetFile(path)
    parts = []  # 每批的部分聚合(date, train_type → counts/sums)
    for batch in pf.iter_batches(batch_size=2_000_000,
                                 columns=["train_type", "time", "delay_in_min", "is_canceled"]):
        df = batch.to_pandas()
        df["date"] = pd.to_datetime(df["time"]).dt.strftime("%Y-%m-%d")
        df["is_canceled"] = df["is_canceled"].fillna(False).astype(bool)
        df["delay_in_min"] = df["delay_in_min"].where(df["delay_in_min"] >= -15)
        ok = (~df["is_canceled"]) & df["delay_in_min"].notna()
        g = df.groupby(["date", "train_type"]).agg(
            n_stops=("delay_in_min", "size"),
            n_cancel=("is_canceled", "sum"))
        o = df[ok].groupby(["date", "train_type"])["delay_in_min"].agg(
            cnt="size", dsum="sum",
            ge5=lambda s: (s >= 5).sum(),
            ge10=lambda s: (s >= 10).sum())
        part = g.join(o).reset_index().fillna({"cnt": 0, "dsum": 0.0, "ge5": 0, "ge10": 0})
        parts.append(part)
    p = pd.concat(parts, ignore_index=True)
    f = p.groupby(["date", "train_type"], as_index=False).agg(
        n_stops=("n_stops", "sum"), n_cancel=("n_cancel", "sum"),
        cnt=("cnt", "sum"), dsum=("dsum", "sum"),
        ge5=("ge5", "sum"), ge10=("ge10", "sum"))
    f["avg_delay"] = (f["dsum"] / f["cnt"]).round(3)
    f["pct_ge5"] = (f["ge5"] / f["cnt"] * 100).round(2)
    f["pct_ge10"] = (f["ge10"] / f["cnt"] * 100).round(2)
    f["med_delay"] = np.nan
    f["p90_delay"] = np.nan
    f["cancel_rate"] = (f["n_cancel"] / f["n_stops"] * 100).round(3)
    f = f[["date", "train_type", "n_stops", "n_cancel", "cancel_rate",
           "avg_delay", "med_delay", "p90_delay", "pct_ge5", "pct_ge10"]]
    f.to_parquet(out_path, index=False)
    print(f"{name}: {len(f)} 行 完成", flush=True)

if __name__ == "__main__":
    os.makedirs(TMP, exist_ok=True)
    for n in NEED:
        agg_file(os.path.join(PIEBRO, n + ".parquet"))
    print("全部完成")
