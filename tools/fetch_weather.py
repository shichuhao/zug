#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_weather.py — 区域日级天气: 历史 parquet(2025-11~2026-07) + Open-Meteo 增量(近8天+明日)

输出: data/weather/region_daily.parquet
  region date temp_mean precip_sum snowfall_sum wind_max gust_max wx_code
预测用: 明日天气预报也会合入(date=明天), 供 train_model 预测次日。
"""
import os, json, shutil, urllib.request
import pandas as pd

OUT = "/root/traindelay/data/weather/region_daily.parquet"
TMP = "/root/traindelay/data/weather/tmp_om"
HIST = "/root/traindelay/data/db_database/weather/hourly_region_2025-11_2026-07.parquet"

REGIONS = {  # 与 impact/hourly_region 口径一致的 5 区域代表点
    "de_nord":  (53.55, 9.99),
    "de_ost":   (51.05, 13.74),
    "de_west":  (51.23, 6.78),
    "de_mitte": (50.11, 8.68),
    "de_sued":  (48.14, 11.58),
}

def fetch_om(region, lat, lon):
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lat}&longitude={lon}"
           "&hourly=temperature_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,weather_code"
           "&past_days=7&forecast_days=2&timezone=Europe%2FBerlin")
    with urllib.request.urlopen(url, timeout=30) as r:
        d = json.loads(r.read())
    h = d["hourly"]
    df = pd.DataFrame(h)
    df["date"] = df["time"].str.slice(0, 10)
    g = df.groupby("date")
    out = pd.DataFrame({
        "temp_mean": g["temperature_2m"].mean().round(2),
        "precip_sum": g["precipitation"].sum().round(2),
        "snowfall_sum": g["snowfall"].sum().round(2),
        "wind_max": g["wind_speed_10m"].max(),
        "gust_max": g["wind_gusts_10m"].max(),
        "wx_code": g["weather_code"].mean().round(1),
    }).reset_index()
    out.insert(0, "region", region)
    return out

def fetch_archive(region, lat, lon, start, end):
    """Open-Meteo Archive API 补 5 天延迟之前的历史(小时→日, 口径同上)"""
    url = ("https://archive-api.open-meteo.com/v1/archive"
           f"?latitude={lat}&longitude={lon}"
           "&hourly=temperature_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,weather_code"
           f"&start_date={start}&end_date={end}&timezone=Europe%2FBerlin")
    with urllib.request.urlopen(url, timeout=60) as r:
        d = json.loads(r.read())
    h = d["hourly"]
    df = pd.DataFrame(h)
    df["date"] = df["time"].str.slice(0, 10)
    g = df.groupby("date")
    out = pd.DataFrame({
        "temp_mean": g["temperature_2m"].mean().round(2),
        "precip_sum": g["precipitation"].sum().round(2),
        "snowfall_sum": g["snowfall"].sum().round(2),
        "wind_max": g["wind_speed_10m"].max(),
        "gust_max": g["wind_gusts_10m"].max(),
        "wx_code": g["weather_code"].mean().round(1),
    }).reset_index()
    out.insert(0, "region", region)
    return out

def hist_daily():
    t = pd.read_parquet(HIST)
    t["date"] = pd.to_datetime(t["time"]).dt.strftime("%Y-%m-%d")
    g = t.groupby(["region", "date"])
    out = pd.DataFrame({
        "temp_mean": g["temp_mean"].mean().round(2),
        "precip_sum": g["precip_sum"].sum().round(2),
        "snowfall_sum": g["snowfall"].sum() if "snowfall" in g.obj.columns else g["snowfall_sum"].sum().round(2),
        "wind_max": g["wind_max"].max(),
        "gust_max": g["gust_max"].max(),
        "wx_code": g["weather_code"].mean().round(1),
    }).reset_index()
    return out

def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    base = hist_daily()
    print(f"历史(2025-11~2026-07): {len(base)} 行")
    # Archive 补更早历史: 覆盖 2024-07-01 ~ 2025-10-31 (延迟数据起点起)
    arch_need_start, arch_need_end = "2024-07-01", "2025-10-31"
    arch = []
    for region, (lat, lon) in REGIONS.items():
        try:
            arch.append(fetch_archive(region, lat, lon, arch_need_start, arch_need_end))
        except Exception as e:
            print(f"  archive {region} 失败: {e}")
    arch_df = pd.concat(arch, ignore_index=True) if arch else pd.DataFrame()
    print(f"Archive 补历史: {len(arch_df)} 行" if len(arch_df) else "Archive: 无")
    fresh = []
    for region, (lat, lon) in REGIONS.items():
        fresh.append(fetch_om(region, lat, lon))
    om = pd.concat(fresh, ignore_index=True)
    print(f"Open-Meteo 增量: {len(om)} 行 ({om['date'].min()} ~ {om['date'].max()})")
    full = pd.concat([base, arch_df, om], ignore_index=True)
    full = full.drop_duplicates(subset=["region", "date"], keep="last")  # 新数据覆盖旧
    full = full.sort_values(["region", "date"]).reset_index(drop=True)
    full.to_parquet(OUT, index=False)
    print(f"输出 {OUT}: {len(full)} 行, {full['date'].min()} ~ {full['date'].max()}")

if __name__ == "__main__":
    main()
