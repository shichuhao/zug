#!/usr/bin/env bash
# traindelay 自愈启动（cron 每 2 分钟调用，幂等）
# 用 start-linux.sh 统一注入环境变量（venv python / zugfinder 凭证 / 数据目录）

# 解释器择优：必须能 import lightgbm（模型依赖）。否则模型层会静默降级，
# 线上表现为「模型已接线但永远返回 None」。按优先级探测，第一个可用的胜出。
pick_python() {
  local c
  for c in "$PYTHON_BIN" \
           "/root/traindelay/.venv/bin/python" \
           "/root/miniconda/bin/python" \
           "$(command -v python3)"; do
    [ -x "$c" ] || continue
    if "$c" -c "import lightgbm, scipy, pandas, numpy" 2>/dev/null; then
      echo "$c"; return 0
    fi
    echo "  [skip] $c 缺 lightgbm 依赖" >&2
  done
  echo "python3"  # 兜底：接受降级
}
PYBIN="$(pick_python)"

cd /root/traindelay

if ! ss -tlnp 2>/dev/null | grep -q ':3000'; then
  PORT=3000 PYTHON_BIN="$PYBIN" \
    setsid nohup ./start-linux.sh >> /root/traindelay/server.log 2>&1 &
  sleep 3
fi

# Tailscale 通路（本机 userspace 模式；远端常走 DERP，入站不稳定，仅作备用）
if ! tailscale serve status 2>/dev/null | grep -q '100.89.62.39:3000'; then
  tailscale serve --bg --tcp 3000 tcp://127.0.0.1:3000 >/dev/null 2>&1 || true
fi

echo "$(date '+%F %T') local=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/)"
