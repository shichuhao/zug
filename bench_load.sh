#!/usr/bin/env bash
# 并发压测：N 个不同冷车次同时请求，期间每 0.5s 采样 worker 峰值内存
# 用法: bench_load.sh <起始编号> <并发数> [车次前缀 RB|RE]
# 注意：wait 必须显式指定 PID 列表，否则会连同内存采样 loop 一起等成死锁。
START=${1:-20}
N=${2:-4}
PREFIX=${3:-RB}
BASE="http://localhost:3000/api/train?train="
TMP=$(mktemp -d)
WPID=$(ps -eo pid,args | awk '/predictor_worker/ && !/awk/ {print $1; exit}')
SAMPLE=$TMP/samples.txt
: > "$SAMPLE"
(
  for k in $(seq 1 1200); do
    kill -0 "$WPID" 2>/dev/null || break
    awk '/RssAnon/{printf "%.0f\n",$2/1024}' /proc/$WPID/status 2>/dev/null >> "$SAMPLE"
    sleep 0.5
  done
) &
SAMPLER=$!

PIDS=()
for i in $(seq 0 $((N-1))); do
  t="$PREFIX $((START+i))"
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$t")
  (
    ST=$(date +%s%N)
    CODE=$(curl -s -m 200 -o "$TMP/$i.json" -w "%{http_code}" "${BASE}${enc}")
    ET=$(( ($(date +%s%N)-ST)/1000000 ))
    echo "$i|$CODE|$ET" > "$TMP/$i.res"
  ) &
  PIDS+=($!)
done

S=$(date +%s%N)
wait "${PIDS[@]}"          # 只等请求，不等采样 loop
E=$(( ($(date +%s%N)-S)/1000000 ))
kill $SAMPLER 2>/dev/null
wait $SAMPLER 2>/dev/null

echo "── 并发 N=$N  车次 $PREFIX $START..$((START+N-1))  墙钟 ${E}ms"
echo -n "  状态码: "; cat $TMP/*.res 2>/dev/null | cut -d'|' -f2 | sort | uniq -c | tr '\n' ' '; echo
python3 - "$TMP" <<'PY'
import sys,glob
d=sys.argv[1]
lats=[]
for f in sorted(glob.glob(d+"/*.res")):
    try:
        i,c,e=open(f).read().strip().split("|")
        lats.append(int(e))
    except Exception: pass
if lats:
    lats.sort()
    print(f"  延迟 avg={sum(lats)/len(lats):.0f}ms  min={lats[0]}ms  max={lats[-1]}ms  (n={len(lats)})")
PY
if [ -s "$SAMPLE" ]; then
  python3 - "$SAMPLE" <<'PY'
import sys
v=[int(x) for x in open(sys.argv[1]) if x.strip()]
if v: print(f"  worker 内存 min={min(v)}MB max={max(v)}MB  结束={v[-1]}MB")
PY
fi
awk '{printf "  cgroup 用量 %.2f GB / 8.00 GB\n",$1/1073741824}' /sys/fs/cgroup/memory.current
rm -rf "$TMP"
