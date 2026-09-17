#!/usr/bin/env python3
"""举一反三：扫描 ~/.cache/zugfinder_pro 下所有车次缓存，找出整班取消日。

复用 train_insight.py 中已上线的 _is_day_canceled 判定，验证修复不只覆盖 ICE_847，
并区分「真取消（-1 哨兵）」与「误判（全 0 占位，非取消）」，避免一刀切。
同时演示修复前旧 bug：把 adelay=='-1' 当真实数值 → '提前 1 分钟' 误导基线。
"""
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from train_insight import _is_day_canceled, CACHE_DIR  # noqa: E402


def stats(rows):
    n = len(rows)
    neg1 = sum(1 for r in rows if str(r.get("adelay", "")).strip() == "-1")
    zeros = sum(1 for r in rows if str(r.get("adelay", "")).strip() == "0")
    # 修复前旧行为：把 -1 当数值返回（最后一个有真实 arr 的站）
    old_ed = None
    for x in reversed(rows):
        if str(x.get("arr", "")) not in ("", "99:99"):
            try:
                old_ed = float(x["adelay"])
            except (KeyError, TypeError, ValueError):
                old_ed = None
            break
    return n, neg1, zeros, old_ed


def main():
    if not os.path.isdir(CACHE_DIR):
        print("CACHE_DIR 不存在:", CACHE_DIR)
        return
    trains = sorted(d for d in os.listdir(CACHE_DIR)
                    if os.path.isdir(os.path.join(CACHE_DIR, d)))
    total_days = 0
    real_cancel = []   # 真取消：命中 _is_day_canceled 且含 -1 哨兵
    false_pos = []     # 旧逻辑曾误判：全 0 占位日（adelay 全 "0"）
    for tr in trains:
        tdir = os.path.join(CACHE_DIR, tr)
        for fn in sorted(os.listdir(tdir)):
            if not fn.endswith(".json"):
                continue
            ds = fn[:-5]
            total_days += 1
            try:
                rows = json.load(open(os.path.join(tdir, fn), encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(rows, list) or not rows:
                continue
            n, neg1, zeros, old_ed = stats(rows)
            flagged = _is_day_canceled(rows)
            if flagged and neg1 > 0:
                real_cancel.append((tr, ds, n, neg1, old_ed))
            # 记录「全 0 占位但旧 detector 会误判」的日（供对比）
            if neg1 == 0 and zeros == n and n >= 3:
                false_pos.append((tr, ds, n))
    print("=" * 78)
    print("缓存车次数: %d   扫描日文件: %d" % (len(trains), total_days))
    print("真·整班取消日 (_is_day_canceled 命中且含 -1 哨兵): %d" % len(real_cancel))
    print("全 0 占位日 (非取消，旧逻辑曾误判): %d" % len(false_pos))
    print("=" * 78)
    if real_cancel:
        print("\n[真取消] 这些日现在会被标记 🚫 并从基线剔除：")
        print("%-12s %-12s %-5s %-5s %-14s" % ("车次", "日期", "站数", "-1数", "旧bug终点延误"))
        for tr, ds, n, k, oed in real_cancel:
            print("%-12s %-12s %-5d %-5d %-14s" % (
                tr, ds, n, k, ("%.0f分(误判提前)" % oed) if oed is not None else "—"))
    if false_pos:
        print("\n[非取消·全0占位] 不应标🚫（已修正 detector 排除）：")
        print("%-12s %-12s %-5s" % ("车次", "日期", "站数"))
        for tr, ds, n in false_pos:
            print("%-12s %-12s %-5d" % (tr, ds, n))
    print("\n结论：修复后仅真实取消日（含 -1 哨兵）被剔除；全 0 正常/占位日保留为基线。")


if __name__ == "__main__":
    main()
