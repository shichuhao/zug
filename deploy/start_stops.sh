#!/bin/bash
# 自动续跑 stops 站点延误抓取（跨境 730d 回填，shard 0/7）
# 幂等：进程已在运行则跳过；否则启动。脚本自身按已产出文件判定 done_set，天然断点续跑。
# 由 keepalive.sh（60s）、reconnect.sh（重启后一次性）、healthcheck.sh（5min）调用。
#
# 内存隔离（2026-09-20）
# ───────────────────────
#  - 爬虫放进受限 cgroup（traindelay_crawler，memory.max=2G），刚性封顶它对 8GB 预算的占用。
#  - 启动前走错峰门槛（crawler_may_start.sh）：worker 忙/未就绪/内存紧张时，本次不启动，
#    留待下次 60s tick。运行期再由 crawler_yield_guard.sh 用 SIGSTOP/CONT 实时让路。
#  - 确保错峰看门狗本身在跑（每 60s tick 自愈）。
cd /root/zugfinder || { echo "无法进入 /root/zugfinder"; exit 1; }

# 1) 确保 cgroup 就绪 + 把当前在跑的爬虫移入（幂等）
bash /root/zugfinder/crawler_cgroup.sh || true

# 2) 确保错峰看门狗在跑
if ! pgrep -f "crawler_yield_guard.sh" >/dev/null; then
  nohup setsid bash /root/zugfinder/crawler_yield_guard.sh >> /root/zugfinder/yield_guard.log 2>&1 < /dev/null &
  echo "已启动错峰看门狗 (PID $!)"
fi

# 3) 已在跑则跳过
CUR="$(pgrep -f 'python3.*scrape_zugfinder_stops.py' | head -1)"
if [ -n "$CUR" ]; then
  echo "已在运行 (PID $CUR)"
  exit 0
fi

# 4) 错峰门槛：worker 忙 / 内存紧 → 本次不启动，等下次 tick
if ! bash /root/zugfinder/crawler_may_start.sh; then
  echo "$(date '+%F %T') [offpeak] worker 忙或内存紧张，跳过本次启动，等待下次"
  exit 0
fi

# 5) 启动爬虫，并立即移入受限 cgroup（从零开始完全受控）
nohup setsid python3 -u scrape_zugfinder_stops.py \
  --credentials-file account.txt \
  --base-manifest train_universe_crossborder.jsonl \
  --output-dir data/zugfinder/stops \
  --shard-index 0 \
  --shard-total 7 \
  --delay-seconds 0.6 \
  --max-lookback-days 730 \
  --max-dates-per-slug 730 \
  --fetch-date 2026-08-11 \
  >> "stops_$(hostname).log" 2>&1 < /dev/null &
NEW_PID=$!
echo "$NEW_PID" > /sys/fs/cgroup/traindelay_crawler/cgroup.procs 2>/dev/null || true

echo "已启动 (PID $NEW_PID) crossborder shard 0/7 fetch-date=2026-08-11（已限内存）"
