#!/usr/bin/env bash
# 错峰看门狗（运行期实时让路）：stops 爬虫与预测 worker 抢同一个 8GB cgroup。
# 本脚本每 10s 检查一次：当 worker 正在预测（in_use>0）/ 未就绪，或 cgroup 内存
# 占用 > 85% 上限时，对爬虫发 SIGSTOP 暂停；空闲时发 SIGCONT 恢复。
#
# 这样爬虫只在「无人预测 + 内存宽松」时实际推进，从根本上消除二者同时压内存导致的
# 间歇卡顿 —— 比单纯加内存上限更主动（上限只是兜底，本脚本让爬虫主动让路）。
#
# 设计要点
# ────────
# - SIGSTOP/CONT 是进程级、可逆、安全的：爬虫的网络抓取只是被冻结，恢复后继续，
#   不会丢失进度。worker 是独立进程，爬虫暂停完全不影响预测。
# - 仅在状态需要翻转时才发信号（避免每 10s 重复发 CONT 干扰），用 /proc/PID/status
#   的 State 字段（'T' = 暂停中）判断当前是否已停。
# - 用根组 memory.current/memory.max 判断压力（这才是共享预算的真实约束）。

CG=/sys/fs/cgroup/traindelay_crawler
WORKER=http://127.0.0.1:5099/health
LOG=/root/zugfinder/yield_guard.log

worker_busy() {
  local H P
  H="$(curl -s --max-time 2 "$WORKER" 2>/dev/null)"
  [ -z "$H" ] && return 1   # 探不到就不干预（保守）
  echo "$H" | grep -q '"in_use"[[:space:]]*:[[:space:]]*[1-9]' && return 0
  echo "$H" | grep -q '"ready"[[:space:]]*:[[:space:]]*false' && return 0
  return 1
}

mem_pressure() {
  local CUR MAX
  CUR="$(cat /sys/fs/cgroup/memory.current 2>/dev/null)"
  MAX="$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
  [ -n "$CUR" ] && [ -n "$MAX" ] && [ "$MAX" != "max" ] || return 1
  # 仅极端接近 OOM（>95%）才刹车；基线上限已 ~90%，85% 会让爬虫近乎永久暂停
  [ $((CUR * 100)) -gt $((MAX * 98)) ] && return 0
  return 1
}

is_stopped() {
  local PID="$1" ST
  [ -n "$PID" ] || return 1
  ST="$(awk '/^State:/{print $2}' /proc/$PID/status 2>/dev/null)"
  [ "$ST" = "T" ] && return 0
  return 1
}

echo "$(date '+%F %T') yield-guard START" >> "$LOG"

while true; do
  PID="$(pgrep -f 'python3.*scrape_zugfinder_stops.py' | head -1)"
  [ -z "$PID" ] && { sleep 10; continue; }

  BUSY=0
  worker_busy && BUSY=1
  mem_pressure && BUSY=1

  if [ "$BUSY" -eq 1 ]; then
    if ! is_stopped "$PID"; then
      kill -STOP "$PID" 2>/dev/null && echo "$(date '+%F %T') STOP crawler $PID (worker busy / mem pressure)" >> "$LOG"
    fi
  else
    if is_stopped "$PID"; then
      kill -CONT "$PID" 2>/dev/null && echo "$(date '+%F %T') CONT crawler $PID (resume)" >> "$LOG"
    fi
  fi
  sleep 10
done
