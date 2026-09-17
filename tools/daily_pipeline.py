#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""daily_pipeline.py — 每日定时流水线（cron 入口）

流程:
 1. 拉取昨日 raw 分片 (batch_fetch_day.sh, 已有则跳过)
 2. 重跑解析管道 → stops_2026-09.parquet
 3. 重跑聚合 (月度走缓存, 只重聚 9 月) → daily_cat_stats.parquet
 4. 增量天气 → region_daily.parquet + 区域特征补齐到明日
 4.5 影响分析 → data/impact/*.csv (原因频率/天气/站区域, 供 /impact.html 与 breakdown)
 5. 评估昨日预测 pred_<prev>.json vs 实际 → eval_<prev>.json + accuracy_history.csv
 6. 重训模型 → 预测明日 → pred_<next>.json
"""
import os, json, glob, subprocess, sys, datetime as dt
import pandas as pd

ROOT = "/root/traindelay"
FC = os.path.join(ROOT, "data/forecast")
LOG = os.path.join(ROOT, "data/forecast/pipeline.log")

def log(msg):
    line = f"[{dt.datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def run(cmd, **kw):
    log(f"$ {cmd}")
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=3600, **kw)
    if r.returncode != 0:
        log(f"  exit={r.returncode}\n{r.stdout[-800:]}\n{r.stderr[-800:]}")
    else:
        log("  ok")
    return r

def evaluate(prev_date):
    pj = os.path.join(FC, f"pred_{prev_date}.json")
    if not os.path.exists(pj):
        log(f"无 {prev_date} 预测文件, 跳过评估")
        return
    pred = json.load(open(pj))["predictions"]
    daily = pd.read_parquet(os.path.join(ROOT, "data/daily_cat/daily_cat_stats.parquet"))
    act = daily[daily["date"] == prev_date]
    if act.empty:
        log(f"{prev_date} 实际数据尚未就绪, 跳过评估")
        return
    # 幂等跳过：仅当已评估过且当日数据量未变；源站补发分片导致数据量变化时重评
    sig = int(act["n_stops"].sum())
    ev_path = os.path.join(FC, f"eval_{prev_date}.json")
    if os.path.exists(ev_path):
        try:
            old = json.load(open(ev_path))
            if old.get("data_sig") == sig:
                log(f"{prev_date} 已评估过且数据量未变 (n_stops={sig}), 跳过 (幂等)")
                return
            log(f"{prev_date} 数据量变化 {old.get('data_sig')} → {sig}, 重新评估")
        except Exception:
            pass
    # 按预测文件的车型键逐一对齐实际值 (pred 键 = top_cats 细车型)
    actual = {}
    for cat in pred.keys():
        row = act[act["train_type"] == cat]
        if len(row):
            actual[cat] = {"avg_delay": round(float(row["avg_delay"].iloc[0]), 2),
                           "pct_ge5": round(float(row["pct_ge5"].iloc[0]), 2)}
    evals, diffs = {}, []
    for cat, a in actual.items():
        if cat in pred:
            d1 = abs(pred[cat]["avg_delay"] - a["avg_delay"])
            d2 = abs(pred[cat]["pct_ge5"] - a["pct_ge5"])
            evals[cat] = {"pred": pred[cat], "actual": a,
                          "abs_err_delay": round(d1, 2), "abs_err_pct5": round(d2, 2)}
            diffs.append((d1, d2))
    if diffs:
        mae_d = round(sum(x for x, _ in diffs) / len(diffs), 2)
        mae_p = round(sum(y for _, y in diffs) / len(diffs), 2)
    else:
        mae_d = mae_p = None
    out = {"date": prev_date, "evaluated_at": dt.datetime.now().isoformat(timespec="seconds"),
           "n_stops": sig, "data_sig": sig,
           "mae_delay": mae_d, "mae_pct5": mae_p, "per_cat": evals}
    json.dump(out, open(ev_path, "w"), ensure_ascii=False, indent=2)
    hist = os.path.join(FC, "accuracy_history.csv")
    row = pd.DataFrame([{"date": prev_date, "mae_delay": mae_d, "mae_pct5": mae_p,
                         "n_cats": len(evals)}])
    if os.path.exists(hist):
        h = pd.read_csv(hist)
        h = h[h["date"] != prev_date]
        pd.concat([h, row], ignore_index=True).to_csv(hist, index=False)
    else:
        row.to_csv(hist, index=False)
    log(f"评估 {prev_date}: MAE(delay)={mae_d}min, MAE(≥5min占比)={mae_p}pp, 车型数={len(evals)}")

def raw_max_date():
    """从 db_raw 文件名解析已有数据的最大主日期 (文件名前缀 YYYY-MM-DD_date_...)"""
    import re
    dates = set()
    for f in glob.glob(os.path.join(ROOT, "data/db_raw/*.parquet")):
        m = re.match(r"(\d{4}-\d{2}-\d{2})_date_", os.path.basename(f))
        if m:
            dates.add(m.group(1))
    return max(dates) if dates else None

def main():
    today = dt.date.today()
    yesterday = today - dt.timedelta(days=1)
    log(f"===== 每日流水线启动: 今日 {today} =====")

    # 1. 补跑拉取: 从已有最大日期(含当天, 刷新晚间分片)到昨天, 逐日 fetch
    maxdb = raw_max_date()
    if maxdb:
        start = dt.date.fromisoformat(maxdb)
    else:
        start = yesterday
    targets = []
    d = start
    while d <= yesterday:
        targets.append(d)
        d += dt.timedelta(days=1)
    if not targets:
        targets = [yesterday]
    log(f"拉取目标日: {[t.isoformat() for t in targets]}")
    for t in targets:
        run(f"bash {ROOT}/tools/batch_fetch_day.sh {t.month} {t.day}")

    # 2. 解析 → 3. 聚合 → 4. 天气 → 4.5 影响分析数据
    run(f"python3 {ROOT}/tools/parse_delay_pipeline.py")
    run(f"python3 {ROOT}/tools/build_trainset.py")
    run(f"python3 {ROOT}/tools/fetch_weather.py")
    # 把 weather_features_by_region_date.csv 补齐到「明天」, 否则 breakdown 恒报
    # 「预测日期超出天气数据覆盖范围」; 必须在 build_impact_data 之前跑(后者会复制该文件)
    run(f"python3 {ROOT}/tools/extend_weather_features.py")
    run(f"python3 {ROOT}/tools/build_impact_data.py")

    # 4.6 原因画像重建（可选）: 用 data/raw_cache 的历史 raw 直算
    #     「DB 延误编码 → 实测延误/取消率」，供 /api/train 的 top_codes 使用。
    #     无缓存目录时静默跳过（不阻塞主流程）。
    raw_cache = os.path.join(ROOT, "data/raw_cache")
    if os.path.isdir(raw_cache) and glob.glob(os.path.join(raw_cache, "**", "*.parquet"),
                                              recursive=True):
        run(f"python3 {ROOT}/build_reason_profile.py --raw-dir {raw_cache} "
            f"--monthly-glob \"{ROOT}/data/piebro/data-*.parquet\" "
            f"--out {ROOT}/data/reasons/reason_profile.json")
    else:
        log("无 data/raw_cache，跳过原因画像重建")

    # 4.7 逐车次原因成分索引（可选）: 从 parsed/stops_*.parquet 逐站统计
    #     delay_codes + msg_cats，供 /api/train 的 train_composition 使用。
    #     无 parquet 时静默跳过（不阻塞主流程）。
    if glob.glob(os.path.join(ROOT, "data/parsed/stops_*.parquet")):
        run(f"python3 {ROOT}/build_train_breakdowns.py --min-stops 3 "
            f"--out {ROOT}/data/reasons/train_breakdowns.json")
    else:
        log("无 data/parsed/stops_*.parquet，跳过逐车次原因索引")

    # 5. 评估: 回看最近 10 天, 有 pred 无 eval 且实际就绪的日期自动补评估 (幂等)
    for i in range(10):
        evaluate(str(yesterday - dt.timedelta(days=i)))

    # 6. 重训 + 预测下一个未覆盖日 = 数据最大日期 + 1 (任何触发时点自洽)
    daily = pd.read_parquet(os.path.join(ROOT, "data/daily_cat/daily_cat_stats.parquet"))
    dmax = pd.to_datetime(daily["date"]).max().date()
    nxt = dmax + dt.timedelta(days=1)
    log(f"重训并预测 {nxt} (数据覆盖至 {dmax})")
    run(f"python3 {ROOT}/tools/train_model.py --date {nxt}")
    log("===== 流水线完成 =====")

if __name__ == "__main__":
    main()
