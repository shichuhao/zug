#!/usr/bin/env python3
"""单元测试 v2：ICE 500-999 缓存全扫 —— 我们口径 vs zugfinder last/max delay。

口径：
  our_end  = train_insight._end_delay(rows)     （应用显示的 last delay）
  our_max  = train_insight._max_delay(rows)     （应用显示的 max delay）
  zf_last  = rows[-1].adelay                    （zugfinder 页面 LAST DELAY 口径）
  zf_max   = 全站排除 -1 的最大 adelay          （zugfinder 页面 MAX. DELAY 口径）

伪 0 判定：**缓存写入日 == 数据日**（列车终到前拉取的占位快照，终点数据未定型）。
99:99 = 通过/无停靠计划标记，不算残缺。
"""
import sys, os, json, glob, datetime
sys.path.insert(0, "/root/traindelay")
from train_insight import _end_delay, _max_delay  # noqa: E402

CACHE = "/root/.cache/zugfinder_pro"


def zf_last(rows):
    if not rows:
        return None
    try:
        return float(rows[-1].get("adelay"))
    except (TypeError, ValueError):
        return None


def zf_max(rows):
    vals = []
    for x in rows:
        try:
            v = float(x.get("adelay"))
        except (TypeError, ValueError):
            continue
        if v != -1:
            vals.append(v)
    return max(vals) if vals else None


dirs = [d for d in sorted(glob.glob(os.path.join(CACHE, "ICE_*")))
        if 500 <= int(os.path.basename(d).split("_")[1]) <= 999]
total = 0
stats = {"pending_zero": 0, "end_neg1": 0, "last_mismatch": 0, "max_mismatch": 0,
         "consistent": 0}
ex_pend, ex_last, ex_max = [], [], []

for d in dirs:
    train = os.path.basename(d)
    for fp in sorted(glob.glob(os.path.join(d, "*.json"))):
        ds = os.path.basename(fp)[:-5]
        try:
            rows = json.load(open(fp, encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(rows, list) or not rows:
            continue
        total += 1
        mt = datetime.datetime.fromtimestamp(os.path.getmtime(fp)).date().isoformat()
        our_end = _end_delay(rows)
        our_max, our_max_st = _max_delay(rows)
        zfl, zfm = zf_last(rows), zf_max(rows)
        pending = (mt == ds)  # 数据日当天写入 → 终到前占位快照

        if our_end == -1:
            stats["end_neg1"] += 1
        if pending and our_end == 0:
            stats["pending_zero"] += 1
            if len(ex_pend) < 10:
                ex_pend.append(f"{train} {ds} | our_end=0 our_max={our_max} "
                               f"mtime={mt} (占位快照 → 应输出 None/重拉)")
            continue
        # 完整快照：last/max 分歧检测（-1 = not reached，单列）
        if our_end is not None and zfl is not None and zfl != -1 \
                and abs(our_end - zfl) > 0.5:
            stats["last_mismatch"] += 1
            if len(ex_last) < 8:
                ex_last.append(f"{train} {ds} | our_end={our_end} zf_last={zfl}")
        if our_max is not None and zfm is not None and abs(our_max - zfm) > 0.5:
            stats["max_mismatch"] += 1
            if len(ex_max) < 8:
                ex_max.append(f"{train} {ds} | our_max={our_max}@{our_max_st} zf_max={zfm}")
        if our_end not in (-1,):
            stats["consistent"] += 1

print(f"=== ICE 500-999 缓存全扫（{len(dirs)} 目录, {total} 车次日）===")
print(f"数据一致（含准点/晚点正常天）            : {stats['consistent']}")
print(f"伪 0（占位快照 our_end=0 → 修复后=None）: {stats['pending_zero']}")
print(f"end_delay=-1 残留（-1 修复应已清零）     : {stats['end_neg1']}")
print(f"last delay 分歧（完整快照）              : {stats['last_mismatch']}")
print(f"max delay 分歧                          : {stats['max_mismatch']}")
for k, v in [("伪 0 样例", ex_pend), ("last 分歧", ex_last), ("max 分歧", ex_max)]:
    if v:
        print(f"--- {k} ---")
        for line in v:
            print(" ", line)
