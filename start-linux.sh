#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 加载 .env（外部已注入的同名变量优先，便于命令行临时覆盖）。
# 必须加载：cron 守护脚本每 2 分钟以干净环境调用本脚本，若不读 .env，
# 行程抓取的 ZUGFINDER_SOCKS5 会静默丢失，服务回落到直连并被 bahnapp WAF 拦下，
# 表现为 /api/journey/parse 稳定返回 journey_source_blocked，极难联想到配置丢失。
load_env_file() {
  local f="$1" line key val
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="${key//[[:space:]]/}"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    [ -z "$key" ] && continue
    # 已存在则不覆盖：外部环境变量 > .env
    [ -n "${!key+x}" ] && continue
    export "$key=$val"
  done < "$f"
}
load_env_file "$ROOT/.env"

export PORT="${PORT:-3000}"
export PYTHON_BIN="${PYTHON_BIN:-python3}"
export ZUGFINDER_CRED="${ZUGFINDER_CRED:-$ROOT/secrets/account.txt}"
export ZUGFINDER_PRO_DIR="${ZUGFINDER_PRO_DIR:-$ROOT/vendor}"
export DELAY_MODEL_DIR="${DELAY_MODEL_DIR:-$ROOT/data/delay_model}"
export PIEBRO_DIR="${PIEBRO_DIR:-$ROOT/data/piebro}"
export IMPACT_DATA_DIR="${IMPACT_DATA_DIR:-$ROOT/data/impact}"

# 长尾上沿修正（Task #55）：
#   hi = q50 + (q95 - q50) * 2  当 q95 > 20，否则保持 q90
# 已于 2026-09-13 上线，但 v6 模型（Task #56 长尾加权重训）已把 q95 学得足够宽，
# 二者同时启用会**重复放大**区间。故 v6 部署后默认关闭此后置修正（default 0），
# 仅保留开关供 A/B 或回退 v5 时临时开启。
export TRAINDELAY_ENABLE_LONGTAIL="${TRAINDELAY_ENABLE_LONGTAIL:-0}"

exec node "$ROOT/server.js"
