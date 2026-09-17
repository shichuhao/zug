#!/usr/bin/env python3
"""从 data/parsed/stops_*.parquet 构建「逐车次号原因成分」索引。

产出 data/reasons/train_breakdowns.json：
  {
    "generated_at": "...",
    "source": "parsed/stops_*.parquet (delay_codes + msg_cats, 逐站)",
    "window": ["2026-09-01", "2026-09-30"],
    "trains": {
      "RE 3308": {
        "train_label": "RE 3308",
        "train_cat": "RE", "train_num": "3308",
        "days": 42,                  # 有记录的运营日数
        "stops": 238,                # 站次数
        "stops_with_code": 174,      # 带 DB 编码的站次数
        "stops_with_msg": 150,       # 带消息分类的站次数
        "avg_delay": 3.42,           # 平均出发延误（分钟）
        "cancel_pct": 1.2,
        "max_delay": 61,
        "cats": {"infrastruktur": 120, ...},   # 编码→类别计数
        "codes": {"43": 88, "48": 20, ...},    # 原始编码计数
        "msgcats": {"Störung": 90, ...},       # 消息分类计数
        "cat_minutes": {"infrastruktur": 1.8, ...},  # 折算分钟
        "evas": ["8000105", ...]     # 途经站（前 8 个）
      }
    }
  }

用法：
  python3 build_train_breakdowns.py                    # 默认全部
  python3 build_train_breakdowns.py --min-stops 5      # 只保留站次>=5 的车次
  python3 build_train_breakdowns.py --glob "data/parsed/stops_2026-*.parquet"
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sys
from datetime import datetime

import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

# 复用原因画像脚本里的编码→类别映射，保证两处口径完全一致
from build_reason_profile import CODE_CAT, CAT_CN  # noqa: E402

# msg_cats 里的德文分类 → 内部类别（与 zugfinder 文本分类对齐）
MSG_CAT_MAP = {
    "Information": "sonstiges",
    "Störung": "infrastruktur",     # 故障类，DB 里绝大多数落在基础设施
    "Bauarbeiten": "bau",
    "Hinweis": "sonstiges",
}

# DB 编码 → 中文短标签（前端图形用，简洁）
CAT_SHORT = {
    "infrastruktur": "基础设施",
    "strecke": "线路障碍",
    "bau": "施工",
    "fahrzeug": "车辆故障",
    "bereitstellung": "车底调配",
    "kaskade": "秩序连锁",
    "wetter": "天气",
    "einsatz": "应急处置",
    "passagier": "乘客相关",
    "wagen": "车辆编组",
    "sonstiges": "其他",
    "keine": "无说明",
}


def norm_msg_cat(raw: str) -> str:
    """把 'Bauarbeiten. (Quelle: zuginfo.nrw)' 归一到 'Bauarbeiten'。"""
    s = (raw or "").strip()
    if not s:
        return ""
    s = s.split("(")[0].strip().rstrip(".").strip()
    return s


def build(glob_pat: str, min_stops: int) -> dict:
    files = sorted(glob.glob(glob_pat))
    if not files:
        raise SystemExit("没有匹配的 parquet: %s" % glob_pat)

    # train_label -> 聚合桶
    agg: dict[str, dict] = {}
    dates_seen: set[str] = set()

    for f in files:
        df = pd.read_parquet(
            f,
            columns=["train_cat", "train_num", "train_label", "line", "date",
                     "eva", "delay_codes", "msg_cats", "delay_dep_min",
                     "delay_arr_min", "cancelled"],
        )
        dates_seen.update(df["date"].astype(str).unique().tolist())

        # 统一车次标签：优先 train_label，缺失时用 类别+号 拼
        label = df["train_label"].astype(str)
        fallback = df["train_cat"].astype(str).str.strip() + " " + df["train_num"].astype(str)
        label = label.where(label.str.len() > 1, fallback)

        for lab, sub in df.groupby(label, sort=False):
            lab = str(lab).strip()
            if not lab or lab.lower() in ("nan", "none", "<na>"):
                continue
            b = agg.get(lab)
            if b is None:
                cat = str(sub["train_cat"].iloc[0]).strip()
                num = str(sub["train_num"].iloc[0]).strip()
                b = agg[lab] = {
                    "train_label": lab, "train_cat": cat, "train_num": num,
                    "days": set(), "stops": 0,
                    "stops_with_code": 0, "stops_with_msg": 0,
                    "delay_sum": 0.0, "delay_n": 0, "cancel": 0,
                    "max_delay": 0,
                    "cats": collections.Counter(),
                    "codes": collections.Counter(),
                    "msgcats": collections.Counter(),
                    "lines": collections.Counter(),
                    "evas": [],
                }
            b["days"].update(sub["date"].astype(str).unique().tolist())
            b["stops"] += len(sub)

            dc = sub["delay_codes"].fillna("").astype(str)
            mc = sub["msg_cats"].fillna("").astype(str)
            b["stops_with_code"] += int((dc.str.len() > 0).sum())
            b["stops_with_msg"] += int((mc.str.len() > 0).sum())

            # 延误：优先出发延误，缺失时用到达
            d = pd.to_numeric(sub["delay_dep_min"], errors="coerce")
            d = d.fillna(pd.to_numeric(sub["delay_arr_min"], errors="coerce"))
            dv = d.dropna()
            if len(dv):
                b["delay_sum"] += float(dv.sum())
                b["delay_n"] += int(len(dv))
                b["max_delay"] = max(b["max_delay"], float(dv.max()))
            b["cancel"] += int(pd.to_numeric(sub["cancelled"], errors="coerce").fillna(0).sum())

            # DB 编码 → 类别
            for v in dc:
                if not v:
                    continue
                for tok in v.replace(";", ",").split(","):
                    tok = tok.strip()
                    if not tok:
                        continue
                    try:
                        code = int(float(tok))
                    except ValueError:
                        continue
                    b["codes"][str(code)] += 1
                    c = CODE_CAT.get(code)
                    if c:
                        b["cats"][c] += 1
                    else:
                        b["cats"]["sonstiges"] += 1

            # 消息分类
            for v in mc:
                if not v:
                    continue
                for tok in v.replace(";", ",").split(","):
                    tok = norm_msg_cat(tok)
                    if not tok:
                        continue
                    b["msgcats"][tok] += 1

            for ln in sub["line"].astype(str).unique():
                ln = str(ln).strip()
                if ln and ln.lower() not in ("nan", "none", "<na>", ""):
                    b["lines"][ln] += 1

            for e in sub["eva"].astype(str).unique():
                e = str(e).strip()
                if e and e.lower() not in ("nan", "none", "<na>") and e not in b["evas"]:
                    b["evas"].append(e)
                    if len(b["evas"]) >= 8:
                        break

    # 收尾：算派生字段
    trains: dict[str, dict] = {}
    base_cats = collections.Counter()
    for lab, b in agg.items():
        if b["stops"] < min_stops:
            continue
        # 类别成分（百分比 + 折算分钟）
        total_cat = sum(b["cats"].values())
        avg_delay = (b["delay_sum"] / b["delay_n"]) if b["delay_n"] else 0.0
        cats = {}
        cat_minutes = {}
        for k, n in b["cats"].most_common():
            if not total_cat:
                continue
            pct = 100.0 * n / total_cat
            cats[k] = round(pct, 2)
            cat_minutes[k] = round(avg_delay * pct / 100.0, 2)
            base_cats[k] += n
        trains[lab] = {
            "train_label": lab,
            "train_cat": b["train_cat"],
            "train_num": b["train_num"],
            "days": len(b["days"]),
            "stops": b["stops"],
            "stops_with_code": b["stops_with_code"],
            "stops_with_msg": b["stops_with_msg"],
            "avg_delay": round(avg_delay, 2),
            "cancel_pct": round(100.0 * b["cancel"] / max(b["stops"], 1), 2),
            "max_delay": round(b["max_delay"], 1),
            "cats": cats,
            "cat_minutes": cat_minutes,
            "codes": dict(b["codes"].most_common(12)),
            "msgcats": dict(b["msgcats"].most_common(8)),
            "lines": dict(b["lines"].most_common(3)),
            "evas": b["evas"],
        }

    total_cat_all = sum(base_cats.values())
    base_profile = {k: round(100.0 * n / total_cat_all, 2)
                    for k, n in base_cats.most_common()} if total_cat_all else {}

    ds = sorted(dates_seen)
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source": "parsed/stops_*.parquet (delay_codes 逐站 + msg_cats 逐站)",
        "window": [ds[0], ds[-1]] if ds else [],
        "n_trains": len(trains),
        "n_stops": int(sum(b["stops"] for b in trains.values())),
        "total_coded_stops": int(sum(b["stops_with_code"] for b in trains.values())),
        "baseline": base_profile,      # 全网基线，供前端对比
        "cat_cn": CAT_CN,
        "cat_short": CAT_SHORT,
        "trains": trains,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="构建逐车次原因成分索引")
    ap.add_argument("--glob", default=os.path.join(ROOT, "data/parsed/stops_*.parquet"))
    ap.add_argument("--min-stops", type=int, default=3, help="保留站次数下限")
    ap.add_argument("--out", default=os.path.join(ROOT, "data/reasons/train_breakdowns.json"))
    args = ap.parse_args()

    data = build(args.glob, args.min_stops)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)

    size_mb = os.path.getsize(args.out) / 1e6
    print("写出 %s (%.2f MB)" % (args.out, size_mb))
    print("车次数: %d  站次: %d  有编码站次: %d"
          % (data["n_trains"], data["n_stops"], data["total_coded_stops"]))
    print("窗口: %s" % (data["window"],))
    print("全网基线: %s" % json.dumps(data["baseline"], ensure_ascii=False))
    top = sorted(data["trains"].items(), key=lambda kv: -kv[1]["stops_with_code"])[:5]
    print("\nTop5（按有编码站次数）:")
    for lab, t in top:
        print("  %-12s stops=%-5d coded=%-5d days=%-3d avg+%.1f  cats=%s"
              % (lab, t["stops"], t["stops_with_code"], t["days"], t["avg_delay"],
                 json.dumps(t["cats"], ensure_ascii=False)[:90]))


if __name__ == "__main__":
    main()
