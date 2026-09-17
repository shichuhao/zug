#!/usr/bin/env python3
"""parse_zugfinder_reasons.py —— 从 zugfinder 730 天归档抽取晚点原因（Bemerkungen）。

数据来源
--------
`all_trains_final.zip`（内含 all_trains_final/trains/<SLUG>_730_daily.jsonl），
每个文件是一车次的历史日记录（最多 730 天）。单条记录：

    {
      "service_date": "2025-09-20",
      "train": "RB 10001", "train_slug": "RB_10001", "weekday": "Sat",
      "last_delay_min": 0, "max_delay_min": 0,
      "last_delay_text": "+0 on time +0 on time",
      "max_delay_text": "",
      "remarks": "Verspätung eines vorausfahrenden Zuges",   ← ★晚点原因（德文正文）
      "source_url": "https://www.zugfinder.net/en/train-RB_10001-730"
    }

与 raw_data 的差异
------------------
  * raw_data：DB 延误**编码**（数值，如 #49），需查表映射，但样本极大（百万级/月）
  * zugfinder：**德文原因正文**，可直接读懂，但仅 6.8% 记录带原因（免费层限制）

两者互补：编码用于大规模统计，正文用于语义验证与展示。

设计
----
**流式读取**：直接从 zip 内逐文件解析，不落盘（78,872 个文件会触发 inode 配额）。
聚合后仅输出：
  * remarks_frequency.csv  原因正文频次
  * reason_stats.json       类别构成 + 每类延误强度
  * train_reason_index.parquet  (可选) 车次 × 原因 的稀疏索引

用法
----
    python3 parse_zugfinder_reasons.py --zip /tmp/zf/stage/all_trains_final.zip \
        --out-dir data/reasons/zugfinder
    # 限制文件数（调试）
    python3 parse_zugfinder_reasons.py --zip ... --limit 500
"""
import argparse
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))

# 德文原因正文 → 内部类别（与 build_impact_data.py 的 cause_category 对齐）
REASON_RULES = [
    ("kaskade", ["vorausfahrenden zuges", "vorheriger fahrt", "vorfahrt eines anderen",
                 "entgegenkommenden zug", "warten auf anschluss", "verspätung im ausland",
                 "vorausfahrende"]),
    ("bereitstellung", ["bereitstellung", "personal aus vorheriger", "personalausfall",
                        "kurzfristiger personal", "verfügbarkeit der gleise",
                        "warten auf personal"]),
    ("fahrzeug", ["technische störung am zug", "technischer defekt", "defekt an einem anderen zug",
                  "störung am fahrzeug", "türstörung", "lokschaden", "wagenschaden",
                  "technischer defekt an einem anderen zug"]),
    ("infrastruktur", ["reparatur an einem signal", "signal", "reparatur an einer weiche",
                       "weiche", "oberleitung", "stellwerk", "bahnübergang",
                       "reparatur an der strecke", "geschwindigkeit auf der strecke"]),
    ("bau", ["bauarbeiten", "baustelle", "revision", "instandhaltung"]),
    ("strecke", ["streckensperrung", "sperrung", "unbefugte personen", "personen auf der strecke",
                 "notarzteinsatz auf der strecke", "feuerwehreinsatz auf der strecke",
                 "beschädigung einer brücke", "umleitung", "hindernis", "tier"]),
    ("wetter", ["wetter", "sturm", "unwetter", "schnee", "eis", "glätte", "hochwasser",
                "hitze", "orkan", "regen"]),
    ("einsatz", ["polizeieinsatz", "feuerwehreinsatz", "notarzteinsatz", "rettung",
                 "notarzt", "polizei", "einsatz"]),
    ("passagier", ["fahrgast", "passagier", "haltezeit am bahnhof", "reisende",
                   "warten auf anschlussreisende"]),
]

CAT_CN = {
    "kaskade": "运行秩序连锁",
    "bereitstellung": "车底与人员调配",
    "fahrzeug": "车辆技术故障",
    "infrastruktur": "基础设施故障",
    "bau": "施工",
    "strecke": "线路障碍",
    "wetter": "天气影响",
    "einsatz": "应急处置",
    "passagier": "乘客相关",
    "sonstiges": "其他",
}


def classify(text):
    t = (text or "").strip().lower()
    for cat, kws in REASON_RULES:
        for kw in kws:
            if kw in t:
                return cat
    return "sonstiges"


# 原因严重度分级（按经验延误量级；用于前端加权展示与特征的加权统计）
CAT_SEVERITY = {
    "strecke": 3,        # 线路障碍：平均 37.7 min，最高
    "einsatz": 2,        # 应急处置：26.6
    "infrastruktur": 2,  # 基础设施故障：23.6
    "fahrzeug": 2,       # 车辆技术故障：23.4
    "bau": 2,            # 施工：20.0
    "sonstiges": 2,      # 其他：19.9
    "bereitstellung": 1, # 车底与人员调配：18.3
    "passagier": 1,      # 乘客相关：15.5
    "kaskade": 1,        # 运行秩序连锁：13.8（最常见但最轻）
    "wetter": 2,         # 天气影响
}


def iter_records(zf, limit=0):
    """流式产出 zip 内所有 trains/*.jsonl 的记录。"""
    names = [n for n in zf.namelist() if "/trains/" in n and n.endswith(".jsonl")]
    names.sort()
    if limit:
        names = names[:limit]
    total = len(names)
    for i, name in enumerate(names, 1):
        try:
            with zf.open(name) as fh:
                for raw in io.TextIOWrapper(fh, encoding="utf-8", errors="ignore"):
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        yield json.loads(raw)
                    except ValueError:
                        continue
        except Exception as e:
            print(f"  跳过 {name}: {e}", file=sys.stderr)
        if i % 2000 == 0 or i == total:
            print(f"  [{i}/{total}] 文件", file=sys.stderr)


def iter_records_dir(root, limit=0):
    """流式产出已解压目录下所有 */trains/*.jsonl 的记录（比读 zip 快）。"""
    import glob
    names = sorted(glob.glob(os.path.join(root, "**", "trains", "*.jsonl"),
                             recursive=True))
    if limit:
        names = names[:limit]
    total = len(names)
    for i, name in enumerate(names, 1):
        try:
            with open(name, encoding="utf-8", errors="ignore") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        yield json.loads(raw)
                    except ValueError:
                        continue
        except Exception as e:  # noqa: BLE001
            print(f"  跳过 {name}: {e}", file=sys.stderr)
        if i % 2000 == 0 or i == total:
            print(f"  [{i}/{total}] 文件", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="all_trains_final.zip 路径")
    ap.add_argument("--dir", help="已解压目录（含 */trains/*.jsonl）；优先于 --zip")
    ap.add_argument("--out-dir", default=os.path.join(BASE, "data", "reasons", "zugfinder"))
    ap.add_argument("--limit", type=int, default=0, help="限制文件数（调试）")
    args = ap.parse_args()

    if not args.zip and not args.dir:
        print("需提供 --zip 或 --dir", file=sys.stderr)
        return 2
    if args.zip and not args.dir and not os.path.exists(args.zip):
        print(f"找不到 {args.zip}", file=sys.stderr)
        return 2

    # 累加器（供两种数据源共用）
    remarks = Counter()
    cat_stat = defaultdict(lambda: {"n": 0, "delay_sum": 0.0, "max_delay": 0, "cancel_like": 0})
    overall = {"records": 0, "with_remark": 0, "delay_sum": 0.0,
               "no_remark_delay_sum": 0.0, "no_remark_n": 0}
    by_year = Counter()
    slug_cat = Counter()   # (slug, cat) → n，用于车次级索引
    # 车次 × 日期 × 原因 明细索引（reason 特征的原料）
    # 键: (train_slug, service_date) → {cat: {n, delay_sum, max_delay}}
    detail = defaultdict(lambda: defaultdict(
        lambda: {"n": 0, "delay_sum": 0.0, "max_delay": 0}))
    # 车次级原因画像（跨全期聚合，用于特征/展示）
    slug_profile = defaultdict(lambda: {"n": 0, "delay_sum": 0.0,
                                        "max_delay": 0, "cats": Counter()})

    def accumulate(d):
        overall["records"] += 1
        md = d.get("max_delay_min") or 0
        ld = d.get("last_delay_min") or 0
        delay = max(md, ld)
        r = (d.get("remarks") or "").strip()
        if not r:
            overall["no_remark_n"] += 1
            overall["no_remark_delay_sum"] += delay
            return
        overall["with_remark"] += 1
        overall["delay_sum"] += delay
        remarks[r] += 1
        cat = classify(r)
        s = cat_stat[cat]
        s["n"] += 1
        s["delay_sum"] += delay
        s["max_delay"] = max(s["max_delay"], delay)
        slug = d.get("train_slug") or ""
        sd = d.get("service_date") or ""
        slug_cat[(slug, cat)] += 1
        if slug and sd:
            cell = detail[(slug, sd)][cat]
            cell["n"] += 1
            cell["delay_sum"] += delay
            cell["max_delay"] = max(cell["max_delay"], delay)
            prof = slug_profile[slug]
            prof["n"] += 1
            prof["delay_sum"] += delay
            prof["max_delay"] = max(prof["max_delay"], delay)
            prof["cats"][cat] += 1
        if len(sd) >= 4:
            by_year[sd[:4]] += 1

    if args.dir:
        print(f"[zf] 读取目录 {args.dir}", file=sys.stderr)
        for d in iter_records_dir(args.dir, args.limit):
            accumulate(d)
    else:
        print(f"[zf] 读取 {args.zip}", file=sys.stderr)
        with zipfile.ZipFile(args.zip) as zf:
            for d in iter_records(zf, args.limit):
                accumulate(d)

    n = overall["records"]
    wr = overall["with_remark"]
    print(f"[zf] 记录 {n:,}  有原因 {wr:,} ({100*wr/max(n,1):.1f}%)  原因种类 {len(remarks):,}",
          file=sys.stderr)

    os.makedirs(args.out_dir, exist_ok=True)

    # 1) 原因正文频次
    import csv
    freq_path = os.path.join(args.out_dir, "remarks_frequency.csv")
    with open(freq_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["rank", "remark", "category", "count", "pct_of_remarks"])
        for i, (k, v) in enumerate(remarks.most_common(), 1):
            w.writerow([i, k, classify(k), v, round(v / max(wr, 1) * 100, 3)])
    print(f"[zf] 已写出: {freq_path}")

    # 2) 结构化统计
    avg_with = overall["delay_sum"] / max(wr, 1)
    avg_without = overall["no_remark_delay_sum"] / max(overall["no_remark_n"], 1)
    cats = []
    for c, s in sorted(cat_stat.items(), key=lambda x: -x[1]["n"]):
        cats.append({
            "key": c, "cn": CAT_CN.get(c, c), "n": s["n"],
            "pct": round(s["n"] / max(wr, 1) * 100, 2),
            "avg_delay": round(s["delay_sum"] / max(s["n"], 1), 2),
            "max_delay": s["max_delay"],
        })
    stats = {
        "source": "zugfinder 730d archive (all_trains_final.zip)",
        "records": n,
        "with_remark": wr,
        "remark_pct": round(wr / max(n, 1) * 100, 2),
        "unique_remarks": len(remarks),
        "avg_delay_with_remark": round(avg_with, 2),
        "avg_delay_without_remark": round(avg_without, 2),
        "categories": cats,
        "by_year": dict(sorted(by_year.items())),
        "top_remarks": [{"remark": k, "cat": classify(k), "n": v}
                        for k, v in remarks.most_common(40)],
        "severity": CAT_SEVERITY,
    }
    stats_path = os.path.join(args.out_dir, "reason_stats.json")
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    print(f"[zf] 已写出: {stats_path}")

    # 3) 车次级原因明细索引（reason 特征的原料）
    #    train_reason_detail.parquet：每行 (train_slug, service_date, cat, n,
    #    delay_sum, max_delay, avg_delay, severity)
    try:
        import pandas as pd
        rows = []
        for (slug, sd), cats_map in detail.items():
            for cat, c in cats_map.items():
                rows.append({
                    "train_slug": slug,
                    "service_date": sd,
                    "cat": cat,
                    "n": c["n"],
                    "delay_sum": round(c["delay_sum"], 2),
                    "max_delay": c["max_delay"],
                    "avg_delay": round(c["delay_sum"] / max(c["n"], 1), 3),
                    "severity": CAT_SEVERITY.get(cat, 2),
                })
        if rows:
            df = pd.DataFrame(rows)
            df = df.sort_values(["train_slug", "service_date", "cat"])
            det_path = os.path.join(args.out_dir, "train_reason_detail.parquet")
            df.to_parquet(det_path, index=False)
            print(f"[zf] 已写出: {det_path}（{len(df):,} 行，"
                  f"{df['train_slug'].nunique():,} 车次）")

        # 4) 车次级原因画像（跨全期聚合）
        prows = []
        for slug, p in slug_profile.items():
            top = p["cats"].most_common(1)
            prows.append({
                "train_slug": slug,
                "n_remark": p["n"],
                "delay_sum": round(p["delay_sum"], 2),
                "avg_delay": round(p["delay_sum"] / max(p["n"], 1), 3),
                "max_delay": p["max_delay"],
                "top_cat": top[0][0] if top else "",
                "n_cats": len(p["cats"]),
            })
        if prows:
            pdf = pd.DataFrame(prows)
            pdf = pdf.sort_values("n_remark", ascending=False)
            prof_path = os.path.join(args.out_dir, "train_reason_profile.parquet")
            pdf.to_parquet(prof_path, index=False)
            print(f"[zf] 已写出: {prof_path}（{len(pdf):,} 车次）")
    except ImportError:
        print("[zf] 未装 pandas，跳过 parquet 输出", file=sys.stderr)

    print(f"\n  平均延误：有原因 {avg_with:.2f} 分 vs 无原因 {avg_without:.2f} 分"
          f"（{avg_with/max(avg_without,0.01):.1f}×）")
    for c in cats[:8]:
        print(f"  {c['cn']:16s} {c['pct']:>5.1f}%  n={c['n']:>7,}  均值={c['avg_delay']:>5.2f}分")
    return 0


if __name__ == "__main__":
    sys.exit(main())
