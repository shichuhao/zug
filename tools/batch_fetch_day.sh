#!/usr/bin/env bash
# batch_fetch_day.sh <month 1-12> <day 1-31> — 下载某天全部 raw 分片(大小校验+跳过已有)
set -u
ROOT=/root/traindelay/data/db_raw
FETCH=/root/traindelay/tools/xet_fetch.sh
MIRROR="https://hf-mirror.com"
M=$1; D=$2
BASE="raw_data/year=2026/month%3D$M/day%3D$D"
LOG=/root/traindelay/data/db_raw/fetch.log

list=$(curl -sL --max-time 30 "$MIRROR/api/datasets/piebro/deutsche-bahn-data/tree/main/$BASE" | python3 -c "
import json,sys
try:
    for x in json.load(sys.stdin):
        if x['type']=='file': print(x['path'], x['size'])
except Exception: pass")
if [ -z "$list" ]; then echo "[fetch_day] month=$M day=$D 源站暂无该日目录"; exit 2; fi

OK=0; SKIP=0; FAIL=0
while read -r path size; do
  [ -z "$path" ] && continue
  fname=$(basename "$path")
  # 归一化: 统一剥掉主日期前缀与 date_ 头 → "<数据日期>_hour_..."
  norm="$fname"
  case "$norm" in *_date_*) norm="${norm#*_date_}" ;; esac
  norm="${norm#date_}"
  # 跳过判断按归一化名比对库内任意命名版本
  dup=""
  for f in "$ROOT"/*"$norm"; do
    [ -f "$f" ] || continue
    dup="$f"
    [ "$(stat -c%s "$f")" = "$size" ] && break
  done
  if [ -n "$dup" ] && [ "$(stat -c%s "$dup")" = "$size" ]; then
    SKIP=$((SKIP+1)); continue
  fi
  out="$ROOT/${fname}"   # 文件名自带 date_YYYY-MM-DD 前缀
  if [ -f "$out" ] && [ "$(stat -c%s "$out")" = "$size" ]; then SKIP=$((SKIP+1)); continue; fi
  if "$FETCH" "$path" "$out" >> "$LOG" 2>&1 && [ "$(stat -c%s "$out" 2>/dev/null || echo 0)" = "$size" ]; then
    OK=$((OK+1)); echo "OK $fname"
  else
    sleep 3
    if "$FETCH" "$path" "$out" >> "$LOG" 2>&1 && [ "$(stat -c%s "$out" 2>/dev/null || echo 0)" = "$size" ]; then
      OK=$((OK+1)); echo "OK $fname (retry)"
    else
      FAIL=$((FAIL+1)); echo "FAIL $fname"
    fi
  fi
  # 下载后防线: 若下载前库内已有同归一化名的异名文件, md5 相同则删重复, 不同则两版并存
  if [ -n "$dup" ] && [ "$out" != "$dup" ]; then
    if [ "$(md5sum < "$out" | cut -d' ' -f1)" = "$(md5sum < "$dup" | cut -d' ' -f1)" ]; then
      rm -f "$out"; OK=$((OK-1)); SKIP=$((SKIP+1))
      echo "DUP $fname == $(basename "$dup"), 已去重"
    else
      echo "DIFF $fname vs $(basename "$dup") (内容不同), 两版并存待解析去重"
    fi
  fi
done <<EOF
$list
EOF
echo "[fetch_day] month=$M day=$D 新下 $OK / 跳过 $SKIP / 失败 $FAIL"
[ $FAIL -eq 0 ]
