#!/usr/bin/env bash
# 并发验证（对桩 worker，不碰真实 python）
BASE="http://localhost:3001/api/train?train="
N=${2:-10}
TRAIN=$1
TMP=$(mktemp -d)
S=$(date +%s%N)
for i in $(seq 1 "$N"); do
  ( curl -s -m 30 -o "$TMP/$i.json" -w "%{http_code}" -D "$TMP/$i.h" "${BASE}${TRAIN}" > "$TMP/$i.code" 2>/dev/null ) &
done
wait
E=$(( ($(date +%s%N)-S)/1000000 ))
echo "── train=$TRAIN  N=$N  墙钟 ${E}ms"
echo -n "  状态码分布: "
sort "$TMP"/*.code | uniq -c | tr '\n' ' '
echo
echo -n "  有无响应体: "; c=0; for f in "$TMP"/*.json; do [ -s "$f" ] && c=$((c+1)); done; echo "$c/$N"
echo -n "  X-Coalesce: "; grep -h -i "x-coalesce" "$TMP"/*.h 2>/dev/null | sort | uniq -c | tr '\n' ' '; echo
echo "  样例 body: $(head -c 120 "$TMP/1.json")"
rm -rf "$TMP"
