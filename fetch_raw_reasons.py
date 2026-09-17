#!/usr/bin/env python3
"""fetch_raw_reasons.py —— 端到端：下载 raw_data → 解析原因 → 输出统计。

链路
----
  HuggingFace (piebro/deutsche-bahn-data)
    └ raw_data/year=Y/month=M/day=D/*.parquet
         ↓ tools/xet_fetch.sh   (经 hf-mirror + DoH 绕 fake-ip 直连 CloudFront)
      本地缓存 data/raw_cache/Y-M-D/
         ↓ parse_raw_reasons.parse_xml
      {stop_id: {cats, codes}}
         ↓ join monthly_processed_data (可选，需要时用 --monthly)
      按原因类别 / 编码的延误统计

用法
----
    # 下载并解析 2024-07-01 ~ 03，输出统计
    python3 fetch_raw_reasons.py --from 2024-07-01 --to 2024-07-03

    # 只解析已下载的缓存
    python3 fetch_raw_reasons.py --from 2024-07-01 --to 2024-07-03 --no-download

    # 指定输出
    python3 fetch_raw_reasons.py --from 2024-07-01 --to 2024-07-03 --out data/reasons/2024-07.parquet
"""
import argparse
import datetime as dt
import glob
import json
import os
import subprocess
import sys
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
RAW_CACHE = os.path.join(BASE, "data", "raw_cache")
FETCH = os.path.join(BASE, "tools", "xet_fetch.sh")
MIRROR = "https://hf-mirror.com"
REPO = "piebro/deutsche-bahn-data"


def list_day_files(d):
    """列某天在 HF 上的 raw 文件名（走 hf-mirror tree API）。"""
    base = f"raw_data/year={d.year}/month={d.month}/day={d.day}"
    url = f"{MIRROR}/api/datasets/{REPO}/tree/main/{base}"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            arr = json.load(r)
        return [(x["path"], x.get("size", 0)) for x in arr if x.get("type") == "file"]
    except Exception as e:
        print(f"  [list] {d} 失败: {e}", file=sys.stderr)
        return []


def download_day(d, force=False):
    """下载某天所有 raw 分片到 data/raw_cache/。返回本地文件列表。"""
    outdir = os.path.join(RAW_CACHE, d.isoformat())
    os.makedirs(outdir, exist_ok=True)
    files = list_day_files(d)
    if not files:
        return []
    local = []
    for path, size in files:
        fname = os.path.basename(path)
        out = os.path.join(outdir, fname)
        if not force and os.path.exists(out) and size and os.path.getsize(out) == size:
            local.append(out)
            continue
        if not os.path.exists(FETCH):
            print(f"  缺 {FETCH}，跳过下载", file=sys.stderr)
            return local
        r = subprocess.run(["bash", FETCH, path, out],
                           capture_output=True, text=True, timeout=3600)
        if os.path.exists(out) and (not size or os.path.getsize(out) == size):
            local.append(out)
            print(f"  ✓ {fname} ({os.path.getsize(out):,} B)")
        else:
            print(f"  ✗ {fname}: {r.stderr[-200:]}", file=sys.stderr)
    return local


def iter_days(d0, d1):
    d = d0
    while d <= d1:
        yield d
        d += dt.timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="d0", required=True, help="起始日期 YYYY-MM-DD")
    ap.add_argument("--to", dest="d1", required=True, help="结束日期 YYYY-MM-DD")
    ap.add_argument("--no-download", action="store_true", help="只用本地缓存")
    ap.add_argument("--force", action="store_true", help="强制重下")
    ap.add_argument("--out", help="输出 stop_reasons parquet")
    ap.add_argument("--monthly", help="monthly parquet（给出则做 join 统计）")
    ap.add_argument("--limit-days", type=int, default=0, help="最多处理天数（调试）")
    args = ap.parse_args()

    d0 = dt.date.fromisoformat(args.d0)
    d1 = dt.date.fromisoformat(args.d1)
    days = list(iter_days(d0, d1))
    if args.limit_days:
        days = days[:args.limit_days]
    print(f"[fetch] {d0} ~ {d1}（{len(days)} 天）", file=sys.stderr)

    all_files = []
    if not args.no_download:
        for d in days:
            print(f"[fetch] {d}", file=sys.stderr)
            all_files += download_day(d, force=args.force)
    else:
        for d in days:
            all_files += sorted(glob.glob(os.path.join(RAW_CACHE, d.isoformat(), "*.parquet")))
    if not all_files:
        print("无可用 raw 文件", file=sys.stderr)
        return 1
    print(f"[fetch] 共 {len(all_files)} 个本地 raw 文件", file=sys.stderr)

    # 交给解析器
    sys.path.insert(0, BASE)
    import parse_raw_reasons as P
    import pandas as pd

    # 流式：逐文件解析后立即丢弃，避免全量 concat 撑爆内存
    # （单日 raw 含 20MB XML 文本，31 天全量加载约需 数 GB）
    reason, codes = {}, {}
    for i, f in enumerate(all_files, 1):
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
        for k, v in c.items():
            codes[k] = codes.get(k, 0) + v
        del d, r
        if i % 5 == 0 or i == len(all_files):
            print(f"  [{i}/{len(all_files)}] 累计 {len(reason):,} 停靠点", file=sys.stderr)
    print(f"[parse] {len(reason):,} 个停靠点标记, {len(codes)} 种编码", file=sys.stderr)

    rows = [{
        "id": sid,
        "msg_cats": ";".join(sorted(r["cats"])),
        "delay_codes": ";".join(sorted(r["codes"])),
        "has_stoerung": "stoerung" in r["cats"],
        "has_bau": "bau" in r["cats"],
        "has_gross": "grossstoerung" in r["cats"],
    } for sid, r in reason.items()]
    df = pd.DataFrame(rows)
    out = args.out or os.path.join(BASE, "data", "reasons",
                                   f"stop_reasons_{d0.isoformat()}_{d1.isoformat()}.parquet")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    df.to_parquet(out, index=False)
    print(f"[out] {out}  ({len(df):,} 行)")

    # 可选：join monthly 做联合分布
    if args.monthly and os.path.exists(args.monthly):
        m = pd.read_parquet(args.monthly,
                            columns=["id", "delay_in_min", "is_canceled", "train_type"])
        j = m.merge(df, on="id", how="inner")
        print(f"\n[join] {len(j):,} 行 (monthly {len(m):,})", file=sys.stderr)
        if len(j):
            j["dc"] = j.delay_codes.fillna("").apply(
                lambda x: set(x.split(";")) if x else set())
            print("\n=== 有/无原因编码的延误对比 ===")
            w = j[j.delay_codes != ""].delay_in_min
            n = m[~m.id.isin(set(j[j.delay_codes != ""].id))].delay_in_min
            if len(w):
                print(f"  有编码 n={len(w):,} 均值={w.mean():.2f} ≥5分={100*(w>=5).mean():.1f}% 取消={100*j[j.delay_codes!=''].is_canceled.mean():.1f}%")
            print(f"  无编码 n={len(n):,} 均值={n.mean():.2f} ≥5分={100*(n>=5).mean():.1f}%")
            print("\n=== Top 编码 ===")
            from collections import Counter
            cc = Counter()
            for s in j.dc:
                cc.update(s)
            for code, cnt in cc.most_common(12):
                s = j[j.dc.apply(lambda st: code in st)]
                print(f"  {code:>4s} n={cnt:>6,} 均值={s.delay_in_min.mean():>6.2f} 取消%={100*s.is_canceled.mean():>5.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
