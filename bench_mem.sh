#!/usr/bin/env bash
# 顺序请求 N 个不同冷车次，观测 worker 内存累积（验证常驻是否有泄漏）
WPID=$(ps -eo pid,args | awk '/predictor_worker/ && !/awk/ {print $1; exit}')
rss(){ awk '/RssAnon/{printf "%.0f",$2/1024}' /proc/$WPID/status 2>/dev/null; }
cg(){ awk '{printf "%.2f",$1/1073741824}' /sys/fs/cgroup/memory.current 2>/dev/null; }
echo "worker PID=$WPID"
for t in "$@"; do
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$t")
  BEFORE=$(rss); CB=$(cg)
  S=$(date +%s%N)
  CODE=$(curl -s -m 130 -o /tmp/mem_$RANDOM.json -w "%{http_code}" "http://localhost:3000/api/train?train=$enc")
  E=$(( ($(date +%s%N)-S)/1000000 ))
  AFTER=$(rss); CA=$(cg)
  echo "$t  HTTP $CODE  ${E}ms   worker匿名内存 ${BEFORE}MB → ${AFTER}MB (Δ+$((AFTER-BEFORE))MB)  cgroup ${CB}→${CA}GB"
done
echo "--- 最终 worker health ---"
curl -s -m 5 http://127.0.0.1:5099/health
