#!/usr/bin/env python3
"""zugfinder.net Pro 逐站晚点客户端

用 Pro 账号登录 zugfinder.net，抓取指定车次某天的逐站到发延误。
凭据从 account.txt 读取（避免密码进命令行/历史）。

用法：
  python zugfinder_pro.py ICE_847 2026-08-19          # 单日逐站
  python zugfinder_pro.py ICE_847 2026-08-19 --json    # 输出原始 JSON
  python zugfinder_pro.py ICE_847 2026-08-17 2026-08-19  # 多日（含起止）

输出：表格（站/计划到/实际延误/计划发/出发延误），多日模式输出各日逐站汇总。
接口：GET /js/zuginfo_json.php?z=<train>&d=<date>（需登录 cookie）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

BASE = "https://www.zugfinder.net"
LOGIN_URL = BASE + "/pro/login.php"
ZUGINFO_URL = BASE + "/js/zuginfo_json.php"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

DEFAULT_CRED = r"K:/ZUGDATABASE/account.txt"

# zugfinder 账号级限流 marker（字段级内嵌 or HTML 页），见 K:/ZUGDATABASE/scrape_zugfinder_pro.py
RATE_LIMIT_MARKERS = ("zu viele abfragen", "limitreaktivieren",
                      "bestätige, dass du ein mensch bist")
REACTIVATE_URL = BASE + "/pro/limitreaktivieren.php"


def _looks_limited(text: str) -> bool:
    """响应（HTML 或 JSON 文本）是否携带限流 marker。"""
    low = (text or "").lower()
    return any(m in low for m in RATE_LIMIT_MARKERS)


def unfreeze_rate_limit(session: requests.Session) -> bool:
    """POST 固定答案 loesung=8 到 /pro/limitreaktivieren.php 解除账号限流（幂等）。

    zugfinder 验证题固定为 "Wieviel ist Fünf plus Drei?"（5+3=8），提交后
    返回 "Vielen Dank" 并重置账号级限流；未限流时调用无害。
    """
    try:
        probe = session.get(REACTIVATE_URL, timeout=15)
        if probe.status_code != 200:
            return False
        # 页面用 HTML 实体写 umlaut（F&uuml;nf），需先还原再匹配
        norm = probe.text.replace("&uuml;", "ü").replace("&auml;", "ä")
        if "Fünf plus Drei" not in norm:
            print("WARNING: zugfinder 验证题已变化，需人工验证。",
                  file=sys.stderr, flush=True)
            return False
        r = session.post(REACTIVATE_URL, data={"loesung": "8"}, timeout=15)
        if "Vielen Dank" in r.text or (r.status_code == 200 and "Kein Bot" not in r.text):
            return True
        return False
    except requests.RequestException as exc:
        print("unfreeze failed: %s" % exc, file=sys.stderr, flush=True)
        return False


def load_credentials(path: str = DEFAULT_CRED) -> tuple[str, str]:
    """从 account.txt 读 (email, password)。"""
    if not os.path.exists(path):
        raise FileNotFoundError("凭据文件不存在: %s" % path)
    lines = [l.strip() for l in open(path, encoding="utf-8") if l.strip()]
    if len(lines) < 2:
        raise ValueError("凭据文件需两行：email / password")
    return lines[0], lines[1]


class ZugfinderPro:
    """zugfinder.net Pro 客户端（登录态保持）。"""

    def __init__(self, cred_path=DEFAULT_CRED) -> None:
        self.s = requests.Session()
        # 禁用环境代理（Windows 系统代理常不可达，导致 ProxyError）
        self.s.trust_env = False
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "en,de;q=0.8"})
        # 支持传文件路径或 (email, password) 元组（多账号池轮换）
        cred = cred_path if isinstance(cred_path, tuple) else load_credentials(cred_path)
        self._login(cred)

    def _login(self, cred: tuple[str, str]) -> None:
        email, pw = cred
        self.s.get(BASE + "/en/login", timeout=30)  # 拿 PHPSESSID
        r = self.s.post(LOGIN_URL, data={
            "email": email, "pass": pw, "fullpage": "true", "lang": "en",
        }, timeout=30, allow_redirects=True)
        if "dashboard" not in r.url:
            raise RuntimeError("登录失败（redirect=%s）" % r.url[:80])

    def zuginfo(self, train: str, day: str) -> list[dict]:
        """单日逐站：list of {bhf, arr, adelay, dep, ddelay, zeit}。

        限流时自动 POST 固定答案 loesung=8 解封（unfreeze_rate_limit）并重试一次；
        解封失败则抛 RuntimeError（调用方降级 PieBro 历史）。
        """
        def _fetch():
            r = self.s.get(ZUGINFO_URL, params={"z": train, "d": day}, timeout=30)
            r.raise_for_status()
            text = r.text
            if _looks_limited(text):
                return None, text
            try:
                return r.json(), text
            except ValueError:
                return None, text

        rows, text = _fetch()
        if rows is None and _looks_limited(text):
            # 账号级限流 → 自动填 8 解除 → 重试一次（每个账号只尝试一次解封，
            # 失败后标记 _unfreeze_failed，后续请求直接快速失败，便于多账号轮换）
            if getattr(self, "_unfreeze_failed", False):
                raise RuntimeError("zugfinder 限流（该账号解封失败）")
            if unfreeze_rate_limit(self.s):
                time.sleep(1.0)
                rows, _ = _fetch()
            else:
                self._unfreeze_failed = True
        if rows is None:
            raise RuntimeError(
                "zugfinder 限流（自动解封失败）或响应异常，请稍后重试")
        return rows

    def to_frame(self, rows: list[dict]) -> pd.DataFrame:
        df = pd.DataFrame(rows)
        for c in ("adelay", "ddelay"):
            if c in df.columns:
                df[c] = pd.to_numeric(df[c], errors="coerce")
        return df


def fmt_cell(time_str: str, delay) -> str:
    if time_str == "99:99" or not time_str:
        return "--"
    try:
        d = int(delay)
    except (TypeError, ValueError):
        d = None
    if d is None or d < 0:
        return time_str
    return "%s(+%d)" % (time_str, d)


def main() -> None:
    ap = argparse.ArgumentParser(description="zugfinder.net Pro 逐站晚点查询")
    ap.add_argument("train", help="车次，如 ICE_847")
    ap.add_argument("date_or_start", help="日期 YYYY-MM-DD 或起始日期")
    ap.add_argument("end", nargs="?", help="结束日期（多日模式）")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON")
    ap.add_argument("--cred", default=DEFAULT_CRED, help="凭据文件路径")
    args = ap.parse_args()

    client = ZugfinderPro(args.cred)

    days = [args.date_or_start]
    if args.end:
        d0 = date.fromisoformat(args.date_or_start)
        d1 = date.fromisoformat(args.end)
        days = [(d0 + timedelta(days=i)).isoformat()
                for i in range((d1 - d0).days + 1)]

    for day in days:
        rows = client.zuginfo(args.train, day)
        if args.json:
            print(json.dumps(rows, ensure_ascii=False))
            continue
        print("=== %s %s（%d 站）===" % (args.train, day, len(rows)))
        print("%-22s %-12s %-12s" % ("站", "到(延误)", "发(延误)"))
        for x in rows:
            print("%-22s %-12s %-12s" % (
                x["bhf"],
                fmt_cell(x.get("arr", ""), x.get("adelay", 0)),
                fmt_cell(x.get("dep", ""), x.get("ddelay", 0)),
            ))
        print()


if __name__ == "__main__":
    sys.exit(main())
