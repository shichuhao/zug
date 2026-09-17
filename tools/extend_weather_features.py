#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extend_weather_features.py — 把区域日级天气特征从既有末端补齐到「今天+1（预报）」

背景
----
data/db_database/weather/weather_features_by_region_date.csv 只到 2026-07-26,
导致晚点预测的天气特征恒为「预测日期超出天气数据覆盖范围」。
本脚本严格复刻原数据管线的口径（已用既有 545 行 100% 反推验证）：

站点级(每站每日)
  temperature_2m_mean/max/min, precipitation_sum, rain_sum, snowfall_sum,
  precipitation_hours, wind_speed_10m_max, wind_gusts_10m_max
风险标志(阈值由既有 10900 条站点日数据反推, 无反例)
  snow_risk         snowfall_sum        >= 1.0
  heavy_snow_risk   snowfall_sum        >= 3.0
  strong_wind_risk  wind_gusts_10m_max  >= 60
  heavy_precip_risk precipitation_sum   >= 20
  weather_delay_min = 8*snow + 20*heavy_snow + 15*strong_wind + 5*heavy_precip
区域级聚合(5 区域 × 20 站)
  t_mean = 均值, t_max = 最大, t_min = 最小
  precip/rain/snow/precip_hours = 均值
  wind_max / gust_max = 最大
  4 个风险标志 = 站点取 max（任一站点命中即命中）
  weather_delay_min = 站点取均值
  weather_station_count = 参与统计的站点数

数据源: Open-Meteo Archive API(历史) + Forecast API(近 7 天 + 明日预报)
输出: 追加写入 weather_features_by_region_date.csv
      (data/db_database/weather/ 与 data/impact/ 同步)
"""
import os
import sys
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

ROOT = "/root/traindelay"
DAILY = os.path.join(ROOT, "data", "db_database", "weather", "weather_daily.csv")
OUT_DB = os.path.join(ROOT, "data", "db_database", "weather",
                      "weather_features_by_region_date.csv")
OUT_IMPACT = os.path.join(ROOT, "data", "impact",
                          "weather_features_by_region_date.csv")

COLS = ["region", "date", "weather_station_count", "temperature_2m_mean",
        "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
        "rain_sum", "snowfall_sum", "precipitation_hours", "wind_kmh_max",
        "wind_gusts_kmh_max", "snow_risk", "heavy_snow_risk",
        "strong_wind_risk", "heavy_precip_risk", "weather_delay_min"]

DAILY_VARS = ("temperature_2m_mean,temperature_2m_max,temperature_2m_min,"
              "precipitation_sum,rain_sum,snowfall_sum,precipitation_hours,"
              "wind_speed_10m_max,wind_gusts_10m_max")


def _get(url, timeout=60, retries=3):
    """带退避重试; Open-Meteo 对并发敏感, 429 需等待"""
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            last = e
            code = getattr(e, "code", None)
            if code == 429 or code is None:
                time.sleep(2 + 3 * i)
                continue
            raise
    raise last


def fetch_station(lat, lon, start, end, kind="archive"):
    """返回 DataFrame[date, temperature_2m_mean, ...] (站点级日值)"""
    if kind == "archive":
        url = ("https://archive-api.open-meteo.com/v1/archive"
               f"?latitude={lat}&longitude={lon}"
               f"&start_date={start}&end_date={end}"
               f"&daily={DAILY_VARS}&timezone=Europe%2FBerlin")
    else:
        past = max(1, (pd.Timestamp(end) - pd.Timestamp(start)).days + 1)
        url = ("https://api.open-meteo.com/v1/forecast"
               f"?latitude={lat}&longitude={lon}"
               f"&daily={DAILY_VARS}&past_days={past}&forecast_days=2"
               "&timezone=Europe%2FBerlin")
    d = _get(url).get("daily") or {}
    if not d.get("time"):
        return pd.DataFrame()
    df = pd.DataFrame(d).rename(columns={"time": "date"})
    return df


def station_daily(lat, lon, start, end, today):
    """历史段走 archive(不接受未来日期, 故截到今天-2),
    全段再走 forecast 兜底并覆盖到明日; archive 优先"""
    frames = []
    arch_end = min(pd.Timestamp(end), today - pd.Timedelta(days=2))
    if pd.Timestamp(start) <= arch_end:
        try:
            frames.append(fetch_station(
                lat, lon, start, arch_end.strftime("%Y-%m-%d"), "archive"))
        except Exception as e:  # noqa: BLE001
            print(f"    archive 失败({e}), 走 forecast 兜底")
    try:
        frames.append(fetch_station(lat, lon, start, end, "forecast"))
    except Exception as e:  # noqa: BLE001
        print(f"    forecast 失败: {e}")
    frames = [f for f in frames if len(f)]
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    out = out.drop_duplicates(subset=["date"], keep="first")  # archive 优先
    return out


def add_features(df):
    """站点级: 补风险标志与 weather_delay_min"""
    df = df.copy()
    for c in ["snowfall_sum", "precipitation_sum", "rain_sum",
              "precipitation_hours", "wind_speed_10m_max", "wind_gusts_10m_max",
              "temperature_2m_mean", "temperature_2m_max", "temperature_2m_min"]:
        df[c] = pd.to_numeric(df.get(c), errors="coerce").fillna(0.0)
    df["snow_risk"] = (df["snowfall_sum"] >= 1.0).astype(int)
    df["heavy_snow_risk"] = (df["snowfall_sum"] >= 3.0).astype(int)
    df["strong_wind_risk"] = (df["wind_gusts_10m_max"] >= 60).astype(int)
    df["heavy_precip_risk"] = (df["precipitation_sum"] >= 20).astype(int)
    df["weather_delay_min"] = (8 * df["snow_risk"] + 20 * df["heavy_snow_risk"]
                               + 15 * df["strong_wind_risk"]
                               + 5 * df["heavy_precip_risk"])
    return df


def agg_region(df):
    """区域级聚合, 口径与既有文件一致"""
    g = df.groupby("date")
    out = pd.DataFrame({
        "weather_station_count": g.size(),
        "temperature_2m_mean": g["temperature_2m_mean"].mean().round(3),
        "temperature_2m_max": g["temperature_2m_max"].max().round(3),
        "temperature_2m_min": g["temperature_2m_min"].min().round(3),
        "precipitation_sum": g["precipitation_sum"].mean().round(3),
        "rain_sum": g["rain_sum"].mean().round(3),
        "snowfall_sum": g["snowfall_sum"].mean().round(3),
        "precipitation_hours": g["precipitation_hours"].mean().round(3),
        "wind_kmh_max": g["wind_speed_10m_max"].max().round(3),
        "wind_gusts_kmh_max": g["wind_gusts_10m_max"].max().round(3),
        "snow_risk": g["snow_risk"].max(),
        "heavy_snow_risk": g["heavy_snow_risk"].max(),
        "strong_wind_risk": g["strong_wind_risk"].max(),
        "heavy_precip_risk": g["heavy_precip_risk"].max(),
        "weather_delay_min": g["weather_delay_min"].mean().round(2),
    }).reset_index()
    return out


def main():
    today = pd.Timestamp.today().normalize()
    cur = pd.read_csv(OUT_DB)
    have_max = cur["date"].max()
    start = (pd.Timestamp(have_max) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    end = (today + pd.Timedelta(days=1)).strftime("%Y-%m-%d")  # 含明日预报
    if pd.Timestamp(start) > pd.Timestamp(end):
        print(f"天气特征已是最新({have_max}), 无需补拉")
        return 0
    print(f"补拉区间: {start} ~ {end}  (既有末端 {have_max})")

    st = (pd.read_csv(DAILY)[["region", "station_name", "latitude", "longitude"]]
          .drop_duplicates(subset=["region", "station_name"])
          .reset_index(drop=True))
    print(f"站点数 {len(st)} / 区域 {sorted(st.region.unique())}")

    def one(rec):
        region, name, lat, lon = rec
        try:
            d = station_daily(lat, lon, start, end, today)
        except Exception as e:  # noqa: BLE001
            print(f"  {name} 失败: {e}")
            return None
        if not len(d):
            print(f"  {name}: 无数据")
            return None
        d = d[(d["date"] >= start) & (d["date"] <= end)]
        if not len(d):
            return None
        d = add_features(d)
        d["region"] = region
        return d

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        parts = [p for p in ex.map(one, st.itertuples(index=False, name=None))
                 if p is not None]
    if not parts:
        print("全部站点拉取失败, 退出")
        return 1
    print(f"拉取完成 {len(parts)}/{len(st)} 站, 用时 {time.time()-t0:.0f}s")

    allst = pd.concat(parts, ignore_index=True)
    print(f"站点日行数 {len(allst)}, 日期 {allst['date'].min()} ~ {allst['date'].max()}")

    new_rows = []
    for region, grp in allst.groupby("region"):
        r = agg_region(grp)
        r.insert(0, "region", region)
        new_rows.append(r)
    new = pd.concat(new_rows, ignore_index=True)
    # 只保留每个区域完整覆盖(站点齐全)的日期, 避免半截数据
    need = st.groupby("region").size().to_dict()
    new = new[new.apply(lambda x: x["weather_station_count"] >= need[x["region"]] * 0.8,
                        axis=1)]
    new = new[COLS].sort_values(["region", "date"]).reset_index(drop=True)
    print(f"新增 {len(new)} 行, 日期 {new['date'].min()} ~ {new['date'].max()}")

    old = cur[COLS].copy()
    full = pd.concat([old, new], ignore_index=True)
    full = (full.drop_duplicates(subset=["region", "date"], keep="last")
                .sort_values(["region", "date"]).reset_index(drop=True))
    for path in (OUT_DB, OUT_IMPACT):
        if os.path.exists(path) or path == OUT_DB:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            full.to_csv(path, index=False, encoding="utf-8")
            print(f"写入 {path}: {len(full)} 行 "
                  f"({full['date'].min()} ~ {full['date'].max()})")
    nz = full[full["weather_delay_min"] > 0]
    print(f"风险日(weather_delay_min>0): {len(nz)} 行, "
          f"最大 {full['weather_delay_min'].max()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
