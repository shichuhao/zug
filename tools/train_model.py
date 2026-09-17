#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""train_model.py — 车型次日延误预测（每车型独立模型）

输入:
  data/daily_cat/daily_cat_stats.parquet   日×车型
  data/weather/region_daily.parquet        区域日级天气(含明日预报)
目标: 每车型明日 avg_delay(min) 与 pct_ge5(%)  → HistGradientBoosting × 2 × 每车型
特征: 星期/月份 + 滞后(lag1/3/7, roll7, lag7_cancel) + 目标日天气预报
验证: 最后 30 天 holdout MAE (时间序)
输出: data/forecast/pred_<target>.json, model_<target>.pkl(多车型), accuracy_history.csv(评估在 daily_pipeline)
"""
import os, json, sys, pickle
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

BASE = "/root/traindelay/data"
FC = os.path.join(BASE, "forecast")
LAGS = (1, 3, 7)

def top_cats(daily, k=8):
    """停站数 top-k 车型(与月度清洗数据同口径)"""
    return daily.groupby("train_type")["n_stops"].sum().sort_values(
        ascending=False).head(k).index.tolist()

def cat_series(daily, cat):
    g = daily[daily["train_type"] == cat].set_index("date").sort_index()
    return g

def wx_national(wx):
    return wx.groupby("date").agg(
        wx_temp=("temp_mean", "mean"),
        wx_precip_max=("precip_sum", "max"),
        wx_snow_max=("snowfall_sum", "max"),
        wx_gust_max=("gust_max", "max"),
        wx_wet_regions=("precip_sum", lambda s: float((s > 2).sum())),
    )

def build_features(daily, wx, cats, target):
    """长表: 每(车型×日)一行; 滞后特征在车型组内 shift, 天气为全国聚合"""
    wxn = wx_national(wx).reset_index()
    rows = []
    for cat in cats:
        s = cat_series(daily, cat)   # 已按 date 索引排序
        if s.empty:
            continue
        f = pd.DataFrame({
            "date": s.index,
            "y": s[target].values,
            "cancel_rate": s["cancel_rate"].values,
            "lag1": s[target].shift(1).values,
            "lag3": s[target].shift(3).values,
            "lag7": s[target].shift(7).values,
            "roll7": s[target].shift(1).rolling(7, min_periods=3).mean().values,
            "lag7_cancel": s["cancel_rate"].shift(7).values,
        })
        f["cat"] = cat
        rows.append(f)
    d = pd.concat(rows, ignore_index=True).merge(wxn, on="date", how="left")
    dt = pd.to_datetime(d["date"])
    d["dow"] = dt.dt.dayofweek
    d["month"] = dt.dt.month
    feats = ["lag1", "lag3", "lag7", "roll7", "lag7_cancel",
             "wx_temp", "wx_precip_max", "wx_snow_max", "wx_gust_max", "wx_wet_regions",
             "dow", "month"]
    return d, feats

def train_cat(d, feats):
    """时间序 holdout 30 天; 返回模型与验证 MAE"""
    df = d.dropna(subset=["y"] + feats).copy()
    df["ts"] = pd.to_datetime(df["date"])
    cutoff = df["ts"].max() - pd.Timedelta(days=30)
    tr, va = df[df["ts"] <= cutoff], df[df["ts"] > cutoff]
    m = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.08,
                                      max_depth=5, l2_regularization=2.0, random_state=42)
    res = {"train_rows": int(len(tr)), "val_rows": int(len(va)), "val_mae": None}
    if len(tr) >= 30:
        m.fit(tr[feats], tr["y"])
        if len(va):
            res["val_mae"] = round(float(np.abs(m.predict(va[feats]) - va["y"]).mean()), 3)
    return m, res

def make_row(daily, wx, cat, target_date, target="avg_delay"):
    """目标日预测行: lag 对齐 D-1/D-3/D-7(用目标列自身序列), 天气用 D 预报"""
    D = pd.Timestamp(target_date)
    s = cat_series(daily, cat)   # 已按 date 索引排序
    def at(col, ts):
        ts = ts.strftime("%Y-%m-%d")
        return float(s.loc[ts, col]) if ts in s.index and pd.notna(s.loc[ts, col]) else np.nan
    w = wx_national(wx)
    wD = w.loc[target_date] if target_date in w.index else None
    win = s.loc[(s.index >= (D - pd.Timedelta(days=7)).strftime("%Y-%m-%d")) &
                (s.index <= (D - pd.Timedelta(days=1)).strftime("%Y-%m-%d")), target]
    row = {
        "lag1": at(target, D - pd.Timedelta(days=1)),
        "lag3": at(target, D - pd.Timedelta(days=3)),
        "lag7": at(target, D - pd.Timedelta(days=7)),
        "roll7": float(win.mean()) if len(win) else np.nan,
        "lag7_cancel": at("cancel_rate", D - pd.Timedelta(days=7)),
        "wx_temp": float(wD["wx_temp"]) if wD is not None else np.nan,
        "wx_precip_max": float(wD["wx_precip_max"]) if wD is not None else np.nan,
        "wx_snow_max": float(wD["wx_snow_max"]) if wD is not None else np.nan,
        "wx_gust_max": float(wD["wx_gust_max"]) if wD is not None else np.nan,
        "wx_wet_regions": float(wD["wx_wet_regions"]) if wD is not None else np.nan,
        "dow": D.dayofweek,
        "month": D.month,
    }
    return row

def main():
    os.makedirs(FC, exist_ok=True)
    daily = pd.read_parquet(os.path.join(BASE, "daily_cat/daily_cat_stats.parquet"))
    wx = pd.read_parquet(os.path.join(BASE, "weather/region_daily.parquet"))
    cats = top_cats(daily)
    print("建模车型:", cats)

    target_date = (pd.to_datetime(daily["date"].max()) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    if "--date" in sys.argv:
        target_date = sys.argv[sys.argv.index("--date") + 1]

    preds, meta, models = {}, {}, {}
    for target in ("avg_delay", "pct_ge5"):
        d, feats = build_features(daily, wx, cats, target)
        meta[target] = {}
        for cat in cats:
            dc = d[d["cat"] == cat]
            m, res = train_cat(dc, feats)
            models[f"{target}:{cat}"] = {"model": m, "features": feats}
            meta[target][cat] = res
        pickle.dump(models, open(os.path.join(FC, f"model_{target}.pkl"), "wb"))
        # 预测目标日
        for cat in cats:
            row = make_row(daily, wx, cat, target_date, target=target)
            X = pd.DataFrame([row])[feats]
            v = models[f"{target}:{cat}"]["model"].predict(X)[0]
            preds.setdefault(cat, {})[target] = round(float(v), 2)

    out = {"target_date": target_date, "generated_at": pd.Timestamp.now().isoformat(timespec="seconds"),
           "model": {t: {c: meta[t][c] for c in cats} for t in meta},
           "predictions": preds}
    pj = os.path.join(FC, f"pred_{target_date}.json")
    json.dump(out, open(pj, "w"), ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
