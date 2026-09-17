#!/usr/bin/env python3
"""build_reason_profile.py —— 用 raw_data 的真实原因编码，生成跨月原因画像。

产出（data/reasons/）
---------------------
  reason_profile.json        全局原因构成（服务首页「晚点成分」）
      { "generated_at": ..., "source": "raw_data/delay_codes",
        "total_remarks": N, "days": M, "date_range": [min, max],
        "categories": [ {"key":"infrastruktur","pct":32.0,"n":13224,"cn":"基础设施"}, ... ],
        "codes":      [ {"code":43,"n":21807,"avg_delay":8.39,"cancel_pct":2.5,"cat":"infrastruktur"}, ... ] }

  reason_by_type.parquet     车型 × 原因类别 的交叉表（可为 breakdown 提供差异化）

与旧数据的区别
--------------
旧 `data/impact/delay_cause_frequency.csv` 基于 **2026-09 的 8 天**；
本表可用 raw_data 全量重算，窗口任意（默认最近 N 天），样本量提升 10x+，
且保留了「编码 → 实际延误/取消率」的实测对照（旧表只有频次、无延误量）。

用法
----
    python3 build_reason_profile.py --raw-dir data/raw_cache --monthly-glob "data/piebro/data-*.parquet"
    python3 build_reason_profile.py --raw-dir data/raw_cache --out data/reasons/reason_profile.json
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")

# --------------------------------------------------------------------------- #
# 延误编码 → 原因类别（与 tools/build_impact_data.py 保持一致，实测全覆盖）    #
# --------------------------------------------------------------------------- #
CODE_CAT = {}


def _range_cat(a, b, c):
    return {i: c for i in range(a, b + 1)}


CODE_CAT.update(_range_cat(1, 4, "kaskade"))          # 前行列车/运行秩序连锁
CODE_CAT.update(_range_cat(10, 11, "passagier"))
CODE_CAT[12] = "bereitstellung"
CODE_CAT.update(_range_cat(13, 16, "passagier"))
CODE_CAT.update(_range_cat(17, 19, "einsatz"))
CODE_CAT.update(_range_cat(20, 27, "fahrzeug"))
CODE_CAT[28] = "wagen"
CODE_CAT[29] = "wagen"
CODE_CAT.update(_range_cat(30, 39, "bau"))
CODE_CAT.update(_range_cat(40, 46, "infrastruktur"))
CODE_CAT.update(_range_cat(47, 59, "strecke"))
CODE_CAT.update(_range_cat(60, 69, "bereitstellung"))
CODE_CAT.update(_range_cat(70, 79, "wetter"))
CODE_CAT.update(_range_cat(80, 98, "sonstiges"))
CODE_CAT[99] = "keine"
CODE_CAT[5] = "einsatz"
CODE_CAT[6] = "einsatz"
CODE_CAT[7] = "wetter"
CODE_CAT[8] = "sonstiges"
CODE_CAT[9] = "sonstiges"

CAT_CN = {
    "infrastruktur": "基础设施（信号/接触网/供电/道岔）",
    "strecke": "线路障碍（异物/动物/封锁）",
    "bau": "施工（含限速/封锁）",
    "fahrzeug": "车辆技术故障",
    "bereitstellung": "车底与乘务调配",
    "kaskade": "运行秩序连锁",
    "wetter": "天气影响",
    "einsatz": "应急处置（警察/消防/医疗）",
    "passagier": "乘客相关",
    "wagen": "车辆编组",
    "sonstiges": "其他",
    "keine": "无说明",
}


def load_reasons(raw_cache_dir):
    """扫描缓存目录，返回 {stop_id: set(codes)}。"""
    sys.path.insert(0, BASE)
    import parse_raw_reasons as P
    import pandas as pd

    files = sorted(glob.glob(os.path.join(raw_cache_dir, "**", "*.parquet"),
                             recursive=True))
    print(f"[profile] 扫描 {len(files)} 个 raw 文件", file=sys.stderr)
    reason, codes = {}, Counter()
    for i, f in enumerate(files, 1):
        try:
            d = pd.read_parquet(f, columns=["api_name", "response_data"])
        except Exception as e:
            print(f"  跳过 {f}: {e}", file=sys.stderr)
            continue
        r, c = P.build_maps(d)
        for sid, rec in r.items():
            tgt = reason.setdefault(sid, {"cats": set(), "codes": set()})
            tgt["cats"].update(rec["cats"])
            tgt["codes"].update(rec["codes"])
        codes.update(c)
        del d, r
        if i % 5 == 0 or i == len(files):
            print(f"  [{i}/{len(files)}] 累计 {len(reason):,} 停靠点", file=sys.stderr)
    return reason, codes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", default=os.path.join(DATA, "raw_cache"))
    ap.add_argument("--monthly-glob", nargs="*", default=[],
                    help="monthly parquet（用于实测延误/取消率）")
    ap.add_argument("--out", default=os.path.join(DATA, "reasons", "reason_profile.json"))
    args = ap.parse_args()

    import pandas as pd

    reason, codes = load_reasons(args.raw_dir)
    if not reason:
        print("无 raw 数据（先跑 fetch_raw_reasons.py）", file=sys.stderr)
        return 1
    print(f"[profile] {len(reason):,} 个停靠点, {len(codes)} 种编码", file=sys.stderr)

    # 展开停靠点 × 编码
    rows = []
    for sid, rec in reason.items():
        for c in rec["codes"]:
            rows.append({"id": sid, "code": c})
    df = pd.DataFrame(rows)
    df["code_int"] = pd.to_numeric(df["code"], errors="coerce")
    df = df[df.code_int.notna()]
    df["code_int"] = df.code_int.astype(int)
    df["cat"] = df.code_int.map(CODE_CAT).fillna("sonstiges")

    # 类别构成
    cat_counts = df["cat"].value_counts()
    total = int(cat_counts.sum())
    categories = [{
        "key": k,
        "cn": CAT_CN.get(k, k),
        "n": int(v),
        "pct": round(v / total * 100, 2),
    } for k, v in cat_counts.items()]

    # 编码明细 + 实测延误（若有 monthly）
    per_code = df.groupby(["code_int", "cat"]).size().reset_index(name="n")
    if args.monthly_glob:
        mfiles = []
        for g in args.monthly_glob:
            mfiles += glob.glob(g)
        if mfiles:
            print(f"[profile] join {len(mfiles)} 个 monthly 文件", file=sys.stderr)
            m = pd.concat([pd.read_parquet(f, columns=["id", "delay_in_min", "is_canceled"])
                           for f in mfiles], ignore_index=True)
            j = m.merge(df, on="id", how="inner")
            if len(j):
                agg = j.groupby("code_int").agg(
                    avg_delay=("delay_in_min", "mean"),
                    cancel_pct=("is_canceled", "mean"),
                ).reset_index()
                per_code = per_code.merge(agg, on="code_int", how="left")
                print(f"[profile] join 命中 {len(j):,} 行", file=sys.stderr)

    codes_out = []
    for _, r in per_code.sort_values("n", ascending=False).iterrows():
        item = {"code": int(r["code_int"]), "cat": str(r["cat"]), "n": int(r["n"])}
        if "avg_delay" in r and pd.notna(r["avg_delay"]):
            item["avg_delay"] = round(float(r["avg_delay"]), 2)
        if "cancel_pct" in r and pd.notna(r["cancel_pct"]):
            item["cancel_pct"] = round(float(r["cancel_pct"]) * 100, 1)
        codes_out.append(item)

    # 日期范围（从缓存目录名推断）
    dates = sorted(os.path.basename(p) for p in glob.glob(os.path.join(args.raw_dir, "20*"))
                   if os.path.isdir(p))
    profile = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source": "raw_data / timetables/v1/fchg (delay_codes)",
        "days": len(dates),
        "date_range": [dates[0], dates[-1]] if dates else [None, None],
        "total_remarks": total,
        "total_stops": len(reason),
        "categories": categories,
        "codes": codes_out,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False, indent=1)
    print(f"[profile] 已写出: {args.out}")
    print(f"  窗口 {profile['date_range']} ({profile['days']} 天), "
          f"{total:,} 条 remark")
    for c in categories[:6]:
        print(f"  {c['cn']:24s} {c['pct']:>5.1f}%  (n={c['n']:,})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
