#!/usr/bin/env python3
"""站名搜索 —— 混合策略：本地索引（短查询）+ bahn.expert（长查询）

用法：
  python station_search.py "<query>" [max_results]

策略：
  - ≤2 字符 → 本地全量站名索引（4251 站），严格前缀匹配
  - ≥3 字符 → bahn.expert stopPlace.byTerm（DB 官方 IRIS），包含匹配

输出 JSON 数组到 stdout。
"""
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

# ── 本地全量站名索引 ──────────────────────────────────────────────
_STATIONS_FILE = os.path.join(_HERE, "data", "all_stations.json")
_LOCAL_INDEX = None


def _load_local():
    global _LOCAL_INDEX
    if _LOCAL_INDEX is None and os.path.isfile(_STATIONS_FILE):
        with open(_STATIONS_FILE, "r", encoding="utf-8") as f:
            _LOCAL_INDEX = json.load(f)
    return _LOCAL_INDEX or []


# 重要城市/主站关键词（用于排序提升）
_BOOST_KEYWORDS = [
    "Hbf", "Hauptbahnhof", "Flughafen", "Airport",
    "München", "Berlin", "Hamburg", "Köln", "Frankfurt",
    "Stuttgart", "Düsseldorf", "Leipzig", "Dresden", "Hannover",
    "Nürnberg", "Karlsruhe", "Essen", "Dortmund", "Bremen",
    "Basel", "Zürich", "Wien", "Salzburg", "Prag", "Warszawa",
    "Paris", "Amsterdam", "Bruxelles", "København", "Stockholm",
]


def _importance_score(name: str) -> int:
    """返回排序分（越高越靠前）。"""
    score = 0
    nl = name.lower()
    # Hbf / Hauptbahnhof 大幅加分
    if "hbf" in nl or "hauptbahnhof" in nl:
        score += 10000
    # Flughafen / Airport 加分
    if "flughafen" in nl or "airport" in nl:
        score += 8000
    # 重要城市名加分
    for kw in _BOOST_KEYWORDS:
        if kw.lower() in nl:
            score += 5000
            break
    # 名字越短通常越重要（主站名短）
    score += max(0, 30 - len(name)) * 10
    # 不含括号/子站标记的更可能是主站
    if "(" not in name and "-" not in name.split()[0] if name.split() else False:
        score += 500
    return score


def search_local(q: str, limit: int = 20) -> list[str]:
    """从本地索引做前缀/包含匹配，按重要性排序。"""
    idx = _load_local()
    ql = q.lower()
    if len(q) <= 2:
        # 短查询：严格前缀
        hits = [s for s in idx if s.lower().startswith(ql)]
    else:
        # 中等长度：前缀优先，包含兜底
        pre = [s for s in idx if s.lower().startswith(ql)]
        if pre:
            hits = pre
        else:
            hits = [s for s in idx if ql in s.lower()]
    # 按重要性降序排列
    hits.sort(key=_importance_score, reverse=True)
    return hits[:limit]


# ── bahn.expert 在线搜索 ───────────────────────────────────────────
def search_live(q: str, limit: int = 20) -> list[str]:
    """调 bahn.expert stopPlace.byTerm（DB 官方 IRIS）。"""
    try:
        from db_bahn_expert import search_station as _se
        r = _se(q, limit * 2)  # 多拉一些，过滤后截断
        names = [s.get("name", "") for s in r if s.get("name")]
        # 长查询保持 bahn.expert 原序（已按相关度排序）
        return names[:limit]
    except Exception as e:
        sys.stderr.write("bahn.expert error: %s\n" % e)
        return []


# ── 主入口 ─────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print("[]")
        return

    q = sys.argv[1].strip()
    if not q:
        print("[]")
        return

    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20

    # 策略选择
    if len(q) <= 2:
        # 短查询：本地索引（覆盖全德 4251 站）
        results = search_local(q, limit)
        source = "local_index"
    else:
        # 常见站名优先使用本地索引：避免每次输入已知站名都依赖不稳定的
        # bahn.expert；只有本地没有匹配时才请求官方名称搜索。
        local_results = search_local(q, limit)
        if local_results:
            results = local_results
            source = "local_index"
        else:
            results = search_live(q, limit)
            if not results:
                results = local_results
                source = "local_fallback"
            else:
                source = "bahn_expert"

    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
