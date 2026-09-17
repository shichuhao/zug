#!/usr/bin/env bash
# 批量下载 2026-09 月至今全部每日数据（raw_data/year=2026/month=9/day=1..6 × 4 个 hour 文件）
# 每个文件下载后校验大小与 API 元数据一致；失败自动重试一次。
set -u
ROOT=/root/traindelay/data/db_raw
FETCH=/root/traindelay/tools/xet_fetch.sh
MIRROR="https://hf-mirror.com"
BASE="raw_data/year=2026/month=9"
LOG=/root/.codebuddy/artifact/dbraw_sep_dl.log
: > "$LOG"

DAYS="1 2 3 4 5 6"
TOTAL_OK=0; TOTAL_FAIL=0; TOTAL_BYTES=0

for d in $DAYS; do
  # 拿该天文件清单（path + size）
  list=$(curl -sL --max-time 30 "$MIRROR/api/datasets/piebro/deutsche-bahn-data/tree/main/$(echo $BASE | sed 's/=/%3D/g')/day%3D$d" | python3 -c "
import json,sys
for x in json.load(sys.stdin):
    if x['type']=='file': print(x['path'], x['size'])")
  while read -r path size; do
    [ -z "$path" ] && continue
    fname=$(basename "$path")
    out="$ROOT/2026-09-$(printf '%02d' $d)_${fname#hour_}"
    # 已存在且大小一致 → 跳过（断点续跑）
    if [ -f "$out" ] && [ "$(stat -c%s "$out")" = "$size" ]; then
      echo "SKIP $out (已存在 $(stat -c%s $out))" | tee -a "$LOG"
      TOTAL_OK=$((TOTAL_OK+1)); TOTAL_BYTES=$((TOTAL_BYTES+size)); continue
    fi
    rel="${path// /%20}"
    if "$FETCH" "$rel" "$out" >> "$LOG" 2>&1 && [ "$(stat -c%s "$out" 2>/dev/null || echo 0)" = "$size" ]; then
      echo "OK   $out ($size bytes)" | tee -a "$LOG"
      TOTAL_OK=$((TOTAL_OK+1)); TOTAL_BYTES=$((TOTAL_BYTES+size))
    else
      echo "FAIL $path (期望 $size)" | tee -a "$LOG"
      TOTAL_FAIL=$((TOTAL_FAIL+1))
      sleep 3
      if "$FETCH" "$rel" "$out" >> "$LOG" 2>&1 && [ "$(stat -c%s "$out" 2>/dev/null || echo 0)" = "$size" ]; then
        echo "OK   $out ($size bytes) [重试成功]" | tee -a "$LOG"
        TOTAL_OK=$((TOTAL_OK+1)); TOTAL_FAIL=$((TOTAL_FAIL-1)); TOTAL_BYTES=$((TOTAL_BYTES+size))
      else
        echo "FAIL $path 重试仍失败" | tee -a "$LOG"
      fi
    fi
  done <<EOF
$list
EOF
done

echo "==== 完成: 成功 $TOTAL_OK / 失败 $TOTAL_FAIL / 总计 $(awk "BEGIN{printf \"%.2f GB\", $TOTAL_BYTES/1073741824}") ====" | tee -a "$LOG"
