#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_impact_data.py — 生成影响分析页(/impact.html)所需的 data/impact/ 数据文件

产出 5 个文件（server.js IMPACT_SRC 期望的确切文件名/列名）:
  1. delay_cause_frequency.csv
     列: rank, cause_category, cause_category_cn, remark_count, percent, total_remarks
     口径: 每个停站引用的每条晚点原因编码计 1 remark；
           percent = 该类 remark 数 / 总 remark 数。
  2. delay_cause_subcategory_frequency.csv
     列: cause_category, subcategory, subcategory_cn, remark_count, percent_of_category
     口径: 仅施工(bau)类细分子类，percent_of_category 相对 bau 总数。
  3. weather_features_by_region_date.csv
     直接复制 data/db_database/weather/ 同名文件（含 weather_delay_min 列，去 BOM 重写）。
  4. planned_incidents.csv
     仅表头 —— 目前无官方事件数据源；前端对空数组安全（不渲染事件表）。
  5. station_anchor_map.parquet
     直接复制 data/db_database/weather/ 同名文件（station_name/region 列匹配 server.js）。

晚点编码 → 原因类别: 启发式映射（近似口径，非 DB 官方对照表）。
  依据: DB IRIS 延误编码段落的通行语义 + 停站级 msg_cats 文本信号。
  msg_cats 含 "Bauarbeiten" 的停站 → 其编码强制归入 bau（施工信息直接来自
  DB 官方 h-msg，是最可靠的信号，优先于编码段推断）。

用法:
  python3 tools/build_impact_data.py           # 全量生成
  python3 tools/build_impact_data.py --force   # 忽略缓存强制重算（本版本无缓存，等价）
"""
import os
import shutil
import sys

import pandas as pd

ROOT = "/root/traindelay"
PARSED = os.path.join(ROOT, "data", "parsed", "stops_2026-09.parquet")
WEATHER_SRC = os.path.join(ROOT, "data", "db_database", "weather",
                           "weather_features_by_region_date.csv")
STATION_SRC = os.path.join(ROOT, "data", "db_database", "weather",
                           "station_anchor_map.parquet")
OUT_DIR = os.path.join(ROOT, "data", "impact")

# ---- 原因类别（与 public/impact.js CAUSE_LABELS 键一致）----
CAT_CN = {
    "kaskade": "前车/先前晚点连锁",
    "ausfall": "列车停运/车辆停用",
    "bau": "施工/维护/减速限速",
    "wagen": "改编组",
    "fahrzeug": "列车车辆技术故障",
    "infrastruktur": "设施/信号/道岔/接触网故障",
    "passagier": "乘客相关（候补/医疗/上下客）",
    "einsatz": "紧急部门介入（警察/消防/医疗/官方）",
    "bereitstellung": "晚备车/营运组织/用人",
    "wetter": "天气/自然灾害",
    "sonstiges": "其他/未归类",
    "strecke": "线路障碍（落树/异物/动物）",
    "ausland": "跨境/边境管制",
    "keine": "无原因说明",
    "ersatz": "替代交通/绕行",
}
SUB_CN = {
    "bauarbeiten": "施工",
    "signal_rep": "信号设备维修",
    "strecke_rep": "线路维修",
    "weiche_rep": "道岔维修",
    "oberleitung_rep": "接触网维修",
    "sperrung": "线路封锁",
    "langsamfahrt": "临时限速",
    "haltezeit": "延长停站",
    "bruecke": "桥梁损坏",
}

# ---- 启发式编码映射 ----
def _range_cat(lo, hi, cat):
    return {c: cat for c in range(lo, hi + 1)}

CODE_CAT = {}
CODE_CAT.update(_range_cat(1, 4, "kaskade"))        # 前行列车/运行秩序连锁
CODE_CAT.update(_range_cat(10, 11, "passagier"))    # 乘客上下车/候补
CODE_CAT[12] = "bereitstellung"                     # 车底/乘务调配
CODE_CAT.update(_range_cat(13, 16, "passagier"))    # 行动不便/行李/乘车
CODE_CAT.update(_range_cat(17, 19, "einsatz"))      # 警察/消防/医疗介入
CODE_CAT.update(_range_cat(20, 27, "fahrzeug"))     # 车辆技术故障
CODE_CAT[28] = "wagen"                              # 缺车/改编组
CODE_CAT[29] = "wagen"                              # 车辆编组变更
CODE_CAT.update(_range_cat(30, 39, "bau"))          # 施工/维护/限速
CODE_CAT.update(_range_cat(40, 46, "infrastruktur"))  # 接触网/信号/供电/道岔
CODE_CAT.update(_range_cat(47, 59, "strecke"))      # 线路障碍/异物/动物
CODE_CAT.update(_range_cat(60, 69, "bereitstellung"))  # 人员/运营组织
CODE_CAT.update(_range_cat(70, 79, "wetter"))       # 天气/自然灾害
CODE_CAT.update(_range_cat(80, 98, "sonstiges"))    # 其他
CODE_CAT[99] = "keine"                              # 无原因说明
CODE_CAT[5] = "einsatz"                             # 通道内人员/紧急情况
CODE_CAT[6] = "einsatz"                             # 警方/官方行动
CODE_CAT[7] = "wetter"                              # 天气影响
CODE_CAT[8] = "sonstiges"
CODE_CAT[9] = "sonstiges"

# bau 子类（编码 → 子类；其余 bau 编码默认 bauarbeiten）
BAU_SUB = {
    30: "bauarbeiten", 31: "bauarbeiten", 32: "bauarbeiten",
    33: "strecke_rep", 34: "strecke_rep", 35: "strecke_rep",
    36: "bauarbeiten",
    37: "langsamfahrt", 38: "langsamfahrt",
    39: "sperrung",
    40: "oberleitung_rep",   # 停站带 Bauarbeiten 消息时的接触网类施工
    43: "weiche_rep",        # 道岔相关施工
    44: "sperrung",          # 线路封锁
}


def build_causes():
    df = pd.read_parquet(PARSED, columns=["delay_codes", "msg_cats"])
    df = df[df["delay_codes"].notna() & (df["delay_codes"] != "")]
    print(f"含晚点原因编码的停站: {len(df):,}")

    rows = df[["delay_codes", "msg_cats"]].copy()
    rows["codes"] = rows["delay_codes"].str.split(",")
    rows = rows.explode("codes")
    rows["codes"] = rows["codes"].str.strip()
    rows = rows[rows["codes"] != ""]
    rows["code"] = pd.to_numeric(rows["codes"], errors="coerce")
    rows = rows[rows["code"].notna()]
    rows["code"] = rows["code"].astype(int)

    # msg_cats 含 Bauarbeiten（含 zuginfo.nrw 变体）→ bau
    msg = rows["msg_cats"].fillna("").str.replace(" (Quelle: zuginfo.nrw)", "",
                                                  regex=False)
    is_bau_msg = msg.str.contains("Bauarbeiten", case=False, regex=False)

    rows["category"] = rows["code"].map(CODE_CAT).fillna("sonstiges")
    rows.loc[is_bau_msg, "category"] = "bau"

    # 施工子类: 仅 bau 类停站参与；编码细分，未命中默认 bauarbeiten
    bau_rows = rows[rows["category"] == "bau"].copy()
    bau_rows["subcategory"] = bau_rows["code"].map(BAU_SUB).fillna("bauarbeiten")

    total = int(len(rows))
    print(f"总 remark 数（停站×编码）: {total:,}")

    cat_counts = rows["category"].value_counts()
    cause_out = []
    for rank, (cat, cnt) in enumerate(cat_counts.items(), start=1):
        cause_out.append({
            "rank": rank,
            "cause_category": cat,
            "cause_category_cn": CAT_CN.get(cat, cat),
            "remark_count": int(cnt),
            "percent": round(cnt / total * 100, 2),
            "total_remarks": total,
        })
    causes = pd.DataFrame(cause_out)
    causes.to_csv(os.path.join(OUT_DIR, "delay_cause_frequency.csv"),
                  index=False, encoding="utf-8")
    print("delay_cause_frequency.csv:")
    print(causes.drop(columns=["total_remarks"]).to_string(index=False))

    bau_total = int(len(bau_rows))
    sub_counts = bau_rows["subcategory"].value_counts()
    sub_out = []
    for sub, cnt in sub_counts.items():
        sub_out.append({
            "cause_category": "bau",
            "subcategory": sub,
            "subcategory_cn": SUB_CN.get(sub, sub),
            "remark_count": int(cnt),
            "percent_of_category": round(cnt / bau_total * 100, 1) if bau_total else 0.0,
        })
    subs = pd.DataFrame(sub_out)
    subs.to_csv(os.path.join(OUT_DIR, "delay_cause_subcategory_frequency.csv"),
                index=False, encoding="utf-8")
    print(f"\ndelay_cause_subcategory_frequency.csv (bau 总数 {bau_total:,}):")
    print(subs.to_string(index=False))


def copy_weather():
    d = pd.read_csv(WEATHER_SRC, encoding="utf-8-sig")
    d.to_csv(os.path.join(OUT_DIR, "weather_features_by_region_date.csv"),
             index=False, encoding="utf-8")
    lo, hi = d["date"].min(), d["date"].max()
    print(f"weather_features_by_region_date.csv: {len(d)} 行 ({lo} ~ {hi}), "
          f"区域 {sorted(d['region'].unique())}")


def copy_station_map():
    shutil.copy2(STATION_SRC,
                 os.path.join(OUT_DIR, "station_anchor_map.parquet"))
    import pyarrow.parquet as pq
    n = pq.ParquetFile(STATION_SRC).metadata.num_rows
    print(f"station_anchor_map.parquet: {n} 行")


def write_incidents_header():
    header = "region,start_date,end_date,incident_type,cause,severity,delay_min\n"
    with open(os.path.join(OUT_DIR, "planned_incidents.csv"), "w",
              encoding="utf-8") as f:
        f.write(header)
    print("planned_incidents.csv: 仅表头（暂无官方事件数据源）")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    build_causes()
    copy_weather()
    copy_station_map()
    write_incidents_header()
    print(f"\n完成 → {OUT_DIR}")
    for f in sorted(os.listdir(OUT_DIR)):
        print(f"  {f}  {os.path.getsize(os.path.join(OUT_DIR, f)):,} B")


if __name__ == "__main__":
    sys.exit(main())
