#!/bin/bash
# 统一启停：常驻预测 worker + node web 服务
#   ./start.sh [start|stop|restart|status]
ROOT="/root/traindelay"
PY="/root/miniconda/bin/python"
MODE="${1:-start}"

worker_pid() { pgrep -f "predictor_worker.py" | head -1; }
node_pid()   { ss -ltnp 2>/dev/null | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1; }

status() {
  local w n
  w=$(worker_pid); n=$(node_pid)
  if [ -n "$w" ]; then
    echo "worker: 运行中 (PID $w)"
    curl -s --max-time 3 http://127.0.0.1:5099/health | head -c 200; echo
  else
    echo "worker: 未运行"
  fi
  [ -n "$n" ] && echo "node:   运行中 (PID $n)" || echo "node:   未运行"
}

start() {
  cd "$ROOT" || exit 1
  if [ -z "$(worker_pid)" ]; then
    echo "启动 worker…"
    : > /tmp/worker.log
    nohup "$PY" predictor_worker.py --port 5099 >> /tmp/worker.log 2>&1 &
    echo "  worker PID=$! （后台预热约 73s，期间请求会失败或降级）"
  else
    echo "worker 已在运行 (PID $(worker_pid))"
  fi
  if [ -z "$(node_pid)" ]; then
    echo "启动 node…"
    : > /tmp/qa-server.log
    nohup node server.js >> /tmp/qa-server.log 2>&1 &
    sleep 3
    echo "  node PID=$(node_pid)"
  else
    echo "node 已在运行 (PID $(node_pid))"
  fi
}

stop() {
  local w n
  n=$(node_pid); [ -n "$n" ] && { kill "$n" 2>/dev/null; echo "已停 node ($n)"; }
  w=$(worker_pid); [ -n "$w" ] && { kill "$w" 2>/dev/null; echo "已停 worker ($w)"; }
  [ -z "$w" ] && [ -z "$n" ] && echo "均无运行实例"
}

case "$MODE" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 3; start ;;
  status)  status ;;
  *) echo "用法: $0 [start|stop|restart|status]" ; exit 1 ;;
esac
