#!/usr/bin/env python3
"""parse_raw_reasons.py —— 从 PieBro **raw_data** 抽取延误原因，join 到 monthly。

背景
----
PieBro 两套 parquet：
  * monthly_processed_data/data-*.parquet —— 已清洗，**无原因字段**（只有 delay_in_min）
  * raw_data/year=Y/month=M/day=D/data.parquet —— 原始 API 响应，**含原因**

原因藏在 `timetables/v1/fchg`（变更接口）的响应 XML。实测 DB 的 `<m>` 元素有 8 种
`t` 类型，其中与「原因」相关的有三类：

    <s id="..." eva="...">                        ← 与 monthly.id 完全一致
      <ar ct=".." cl="..">                        ← 实际到达时刻 / 取消标记
        <m id=".." t="d" c="42" ts=".."/>         ← ★ 晚点原因（DB 延误编码）
        <m id=".." t="f" c="0"/>                  ← 行车/路线变更
        <m id=".." t="q" c=".."/>                 ← 质量管理
      </ar>
      <m t="h" cat="Störung"/>                    ← ★ 公告类别（挂在 s 级）
    </s>

  | t | 含义 | 关键属性 | 挂载位置 |
  |---|------|----------|----------|
  | h | Hinweis 公告 | `cat` = Information/Störung/Bauarbeiten/Großstörung | `<s>` 级 |
  | d | 晚点原因 | `c` = DB 编码（如 42/43/48） | `<ar>`/`<dp>` 内层 |
  | f | 行车变更 | `c` | `<ar>`/`<dp>` 内层 |
  | q | 质量管理 | `c` | `<ar>`/`<dp>` 内层 |

输出（两张表）
--------------
  data/reasons/stop_reasons.parquet
      id, msg_cats(分号分隔的 h 类别), delay_codes(分号分隔的 d 编码),
      has_stoerung, has_bau, has_gross, n_msgs
  data/reasons/code_freq.parquet
      delay_code, n, first_seen, last_seen          （延误编码频次，便于后续映射表）

用法
----
    # 单日
    python3 parse_raw_reasons.py --raw /tmp/raw_2024-07-01.parquet --out data/reasons/2024-07.parquet
    # 整个目录（递归）
    python3 parse_raw_reasons.py --raw-dir data/db_raw --out data/reasons/2026-09.parquet
"""
import argparse
import glob
import os
import re
import sys
from collections import Counter

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")

# 公告类别归一化（德文 → 内部键）
CAT_NORM = [
    ("grossstörung", "grossstoerung"),
    ("großstörung", "grossstoerung"),
    ("störung", "stoerung"),
    ("stoerung", "stoerung"),
    ("bauarbeiten", "bau"),
    ("information", "information"),
]

_S_BLOCK = re.compile(r"<s\s+[^>]*\bid=\"([^\"]+)\"[^>]*>(.*?)</s>", re.S)
_M_TAG = re.compile(r"<m\s+([^>]*?)/?>", re.I)
_ATTR = re.compile(r"([\w-]+)=\"([^\"]*)\"")


def _norm_cat(raw_cat):
    """'Bauarbeiten (Quelle: zuginfo.nrw)' → 'bau'。"""
    c = (raw_cat or "").strip().lower()
    c = re.sub(r"\.?\s*\(quelle:[^)]*\)", "", c).strip(" .")
    for k, v in CAT_NORM:
        if c.startswith(k):
            return v
    return None


def parse_xml(xml):
    """解析一个 fchg XML → {s_id: {"cats": set, "codes": set}}。"""
    out = {}
    for sid, block in _S_BLOCK.findall(xml or ""):
        cats, codes = set(), set()
        for raw_attrs in _M_TAG.findall(block):
            a = dict(_ATTR.findall(raw_attrs))
            t = a.get("t", "")
            if t == "h" and a.get("cat"):
                n = _norm_cat(a["cat"])
                if n:
                    cats.add(n)
            elif t == "d" and a.get("c"):
                codes.add(a["c"])
        if cats or codes:
            rec = out.setdefault(sid, {"cats": set(), "codes": set()})
            rec["cats"].update(cats)
            rec["codes"].update(codes)
    return out


def build_maps(raw_df, want_status="200"):
    """从 raw DataFrame 构建 ({id: {...}}, Counter(delay_code))。"""
    reason = {}
    codes = Counter()
    if "api_name" in raw_df.columns:
        sub = raw_df[raw_df["api_name"] == "timetables/v1/fchg"]
    else:
        sub = raw_df
    if want_status and "status_code" in sub.columns:
        sub = sub[sub["status_code"].astype(str) == want_status]
    for xml in sub["response_data"]:
        for sid, rec in parse_xml(xml).items():
            tgt = reason.setdefault(sid, {"cats": set(), "codes": set()})
            tgt["cats"].update(rec["cats"])
            tgt["codes"].update(rec["codes"])
            codes.update(rec["codes"])
    return reason, codes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", nargs="*", default=[], help="raw parquet 文件")
    ap.add_argument("--raw-dir", help="递归扫描该目录下所有 parquet")
    ap.add_argument("--out", help="输出 parquet 路径")
    ap.add_argument("--out-codes", help="延误编码频次表输出路径")
    ap.add_argument("--limit", type=int, default=0, help="限制行数（调试）")
    args = ap.parse_args()

    try:
        import pandas as pd
    except ImportError:
        print("需要 pandas + pyarrow", file=sys.stderr)
        return 2

    files = list(args.raw)
    if args.raw_dir:
        files += sorted(glob.glob(os.path.join(args.raw_dir, "**", "*.parquet"),
                                  recursive=True))
    # 排除已解析产物，避免自噬
    files = [f for f in files if "/parsed/" not in f.replace("\\", "/")]
    if not files:
        print("请用 --raw 或 --raw-dir 指定输入", file=sys.stderr)
        return 2

    print(f"[parse] 读取 {len(files)} 个 raw 文件…", file=sys.stderr)
    frames = []
    for f in files:
        try:
            cols = ["api_name", "response_data"]
            avail = set(pd.read_parquet(f).columns) if args.limit else None
            d = pd.read_parquet(f) if avail is None else pd.read_parquet(f)
            frames.append(d)
        except Exception as e:
            print(f"  跳过 {f}: {e}", file=sys.stderr)
    if not frames:
        print("无有效 raw 数据", file=sys.stderr)
        return 1
    raw = pd.concat(frames, ignore_index=True)
    if args.limit:
        raw = raw.head(args.limit)

    reason, codes = build_maps(raw)
    print(f"[parse] 抽出 {len(reason):,} 个停靠点原因标记, "
          f"{len(codes)} 种延误编码", file=sys.stderr)

    rows = []
    for sid, rec in reason.items():
        c, cd = rec["cats"], rec["codes"]
        rows.append({
            "id": sid,
            "msg_cats": ";".join(sorted(c)),
            "delay_codes": ";".join(sorted(cd)),
            "has_stoerung": "stoerung" in c,
            "has_bau": "bau" in c,
            "has_gross": "grossstoerung" in c,
        })
    df = pd.DataFrame(rows)
    print(f"[parse] 结果 {len(df):,} 行", file=sys.stderr)
    top = df.msg_cats.value_counts().head(8)
    print("  公告类别 Top:", dict(top), file=sys.stderr)

    out = args.out or os.path.join(DATA, "reasons", "stop_reasons.parquet")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    df.to_parquet(out, index=False)
    print(f"[parse] 已写出: {out}")

    if codes:
        outc = args.out_codes or os.path.join(os.path.dirname(out), "code_freq.parquet")
        cdf = pd.DataFrame(
            [{"delay_code": k, "n": v} for k, v in codes.most_common()])
        cdf.to_parquet(outc, index=False)
        print(f"[parse] 已写出: {outc}  (Top 编码: {dict(codes.most_common(10))})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
