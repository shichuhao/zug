#!/usr/bin/env bash
# 错峰判定：worker 空闲 + 内存宽松 才允许启动 stops 爬虫。
# 返回 0 = 可启动；1 = 等（worker 忙 / 未就绪 / 内存紧张）。
#
# 配合 start_stops.sh：它每 60s 被 keepalive 调用一次，若此刻 worker 正在
# 预测（in_use>0），就跳过本次启动，等下个 tick 再试。真正的「运行期让路」由
# crawler_yield_guard.sh 用 SIGSTOP/CONT 实时完成；本脚本只管「启动时机」。
set -uo pipefail

H="$(curl -s --max-time 2 http://127.0.0.1:5099/health 2>/dev/null)"
if [ -n "$H" ]; then
  # worker 正在预测（in_use >= 1）
  echo "$H" | grep -q '"in_use"[[:space:]]*:[[:space:]]*[1-9]' && exit 1
  # worker 模型未就绪（预热中）
  echo "$H" | grep -q '"ready"[[:space:]]*:[[:space:]]*false' && exit 1
fi

CUR="$(cat /sys/fs/cgroup/memory.current 2>/dev/null)"
MAX="$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
if [ -n "$CUR" ] && [ -n "$MAX" ] && [ "$MAX" != "max" ]; then
  # 仅极端接近 OOM（>95%）才延后启动；基线上限已 ~90%，85% 会让爬虫几乎永远起不来
  [ $((CUR * 100)) -gt $((MAX * 98)) ] && exit 1
fi

exit 0
