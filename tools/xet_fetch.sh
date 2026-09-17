#!/usr/bin/env bash
# xet_fetch.sh —— 经 hf-mirror + DoH + CloudFront 真实IP直连，下载 HF Xet 存储的大文件
#
# 原理：hf-mirror.com 的 resolve 对 Xet 文件 302 直跳海外 CDN（cas-bridge.xethub.hf.co），
#       fake-ip 网关会拦截该域名；但用 DoH 拿到 CloudFront 真实 IP 后 --resolve 直连可达。
#       签名 URL 有效期 1 小时，IP 解析缓存复用。
#
# 用法:
#   ./xet_fetch.sh <hf-mirror-resolve完整URL 或 repo内相对路径> <输出文件>
# 示例:
#   ./xet_fetch.sh "raw_data/year=2026/month=2/day=10/hour_00_01_02_03_04_05.parquet" day10_h00.parquet
#   ./xet_fetch.sh "https://hf-mirror.com/datasets/<repo>/resolve/main/<path>" out.parquet
set -uo pipefail

MIRROR="https://hf-mirror.com"
REPO="piebro/deutsche-bahn-data"      # 传相对路径时使用的默认仓库
DOH="https://223.5.5.5/resolve"       # 阿里 DoH，拿真实 CloudFront IP
IP_CACHE="/tmp/xet_resolve_ip.txt"

url="${1:?用法: xet_fetch.sh <URL或repo相对路径> <输出文件>}"
out="${2:?缺少输出文件路径}"

# 相对路径 → 拼完整 resolve URL
case "$url" in
  http*) ;;
  *)    url="$MIRROR/datasets/$REPO/resolve/main/$url" ;;
esac

fetch_ip() {  # $1=host → 打印真实IP（处理 CNAME 链，取 type=1 的 A 记录）
  curl -s --max-time 10 "$DOH?name=$1&type=A" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ans=d.get('Answer') or []
a=[x['data'] for x in ans if x.get('type')==1]
print(a[0] if a else '')"
}

attempt=0
while : ; do
  attempt=$((attempt+1))
  # 1) 取 302 签名 URL
  loc=$(curl -sI --max-time 30 "$url" | tr -d '\r' | awk 'tolower($1)=="location:"{$1="";print;exit}' | sed 's/^ *//')
  if [ -z "$loc" ]; then echo "[xet_fetch] 未拿到签名URL（检查路径/网络）"; exit 1; fi
  host=$(echo "$loc" | sed -E 's#https?://([^/]+)/.*#\1#')

  # 2) 真实IP（缓存 1 小时内复用；签名过期重试时仍有效）
  ip=""
  if grep -qs "^$host " "$IP_CACHE"; then ip=$(awk -v h="$host" '$1==h{print $2}' "$IP_CACHE" | head -1); fi
  if [ -z "$ip" ]; then
    ip=$(fetch_ip "$host")
    [ -n "$ip" ] && echo "$host $ip" >> "$IP_CACHE"
  fi
  if [ -z "$ip" ]; then echo "[xet_fetch] DoH 解析 $host 失败"; exit 1; fi

  # 3) --resolve 直连下载（403=签名过期 → 换新签名重试一次）
  curl -fL --resolve "$host:443:$ip" --max-time 3600 --retry 2 -o "$out" "$loc"
  rc=$?
  if [ $rc -eq 0 ]; then echo "[xet_fetch] 完成: $out ($(stat -c%s "$out") bytes)"; exit 0; fi
  if [ $attempt -ge 2 ]; then echo "[xet_fetch] 下载失败 exit=$rc"; exit $rc; fi
  echo "[xet_fetch] 下载失败(exit=$rc)，重取签名URL重试…"
  # 签名过期时清掉该 host 的陈旧响应，避免半截文件
  rm -f "$out"
done
