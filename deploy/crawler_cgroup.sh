#!/usr/bin/env bash
# 幂等：确保 traindelay_crawler cgroup 存在并设内存上限，把当前 stops 爬虫移入。
#
# 为什么需要它（2026-09-20）
# ───────────────────────────
# 预测 worker（predictor_worker.py，常驻 ~3.6GB）与 stops 爬虫
# （scrape_zugfinder_stops.py）同处一个 8GB cgroup。爬虫无上限地跑抓取/落盘，
# 会与 worker 一起把内存顶到临界区，触发内核回收抖动 → worker 推理变慢 →
# 行程腿排队的 100s 闸门被打破 → 前端 spinner 长期「预测中」。
#
# 这里给爬虫一个受限子 cgroup（memory.max=2G / memory.high=1500M），把它对
# 共享预算的占用刚性封顶。注意：cgroup v2 下「运行中进程已分配的堆」仍记在根组，
# 只有入组后的新分配才计到子组 —— 所以本脚本同时负责把【当前正在跑】的实例移入；
# 而 start_stops.sh 会在【每次新启动】时把新 PID 直接写入 cgroup.procs，使下次
# 重启的爬虫从一开始就完全受控。
set -uo pipefail

CG=/sys/fs/cgroup/traindelay_crawler
mkdir -p "$CG" 2>/dev/null || { echo "无法创建 $CG"; exit 1; }

# 硬上限 2G（防极端峰值吃满预算）；软节流 1500M（超了被内核限速而非 OOM）
echo 2G    > "$CG/memory.max"  2>/dev/null || true
echo 1500M > "$CG/memory.high" 2>/dev/null || true

# 把当前在跑的爬虫移入（若有）。cgroup v2：叶子组可直接写 cgroup.procs，
# 无需启用 subtree_control（启用反而会与「含进程」冲突）。
PID="$(pgrep -f 'python3.*scrape_zugfinder_stops.py' | head -1)"
if [ -n "$PID" ]; then
  echo "$PID" > "$CG/cgroup.procs" 2>/dev/null || true
fi

echo "cgroup ready: $CG  max=$(cat "$CG/memory.max" 2>/dev/null)  high=$(cat "$CG/memory.high" 2>/dev/null)  procs=[$(cat "$CG/cgroup.procs" 2>/dev/null | tr '\n' ' ')]"
