#!/usr/bin/env python3
"""train_incidents.py —— 懒加载实时原因/事件（bahn.expert oRPC / IRIS 消息）。

用法：
    python3 train_incidents.py "RE 8" [YYYY-MM-DD] [EVA_ALONG_ROUTE]

输出 JSON：
    {"source": "iris", "train": "RE 8", "date": "2026-09-10",
     "journey_id": "...", "journey_desc": "ECE 8",
     "first_stop": "Basel SBB", "last_stop": "Hamburg Hbf",
     "max_delay": 48,
     "incidents": [
        {"category": "bereitstellung", "raw": "Verspätung aus vorheriger Fahrt",
         "label": "晚点源于前序车次", "station": "Uelzen",
         "text": "Verspätung aus vorheriger Fahrt",
         "value": 48, "time": "2026-09-10T10:51:27+02:00"}, ...
     ]}

数据来源
--------
bahn.expert 的 `journey/detailsByJourneyId` 响应里，**每个 stop 内嵌 `irisMessages`**：
    [{"text": "Verspätung aus vorheriger Fahrt", "timestamp": "...", "value": 48}]

这就是 zugfinder 页面上「BEMERKUNGEN」列（Verspätung eines vorausfahrenden Zuges /
Technische Störung am Zug / Bauarbeiten / Reparatur an einem Signal …）的同源数据。
注意：该字段在响应中**是可选键**，无消息的停站不出现，因此必须用 .get() 防御。

为何不用 zugfinder.de：旧域名 DNS 已下线（新域 zugfinder.net 需登录 Pro 才有历史
Bemerkungen）；而 bahn.expert 免登录即提供当日实时 IRIS 消息，且与本站其它实时数据
同源，口径一致。

设计：仅当目标日期为今天（或省略=今天）才查实时；历史日期无意义、直接返回空。
远端不可达 / 该车今日不运行 → 返回 {"incidents": [], "error": "..."}，
上层据此展示友好提示而非崩溃。
"""
import sys
import json


# IRIS / 运营方文本 → 应用内原因类别（与 BREAKDOWN_LABELS / CAUSE_LABELS 对齐）
# 顺序敏感：先匹配更具体的短语。
TEXT_RULES = [
    # 车辆/车底（Bereitstellung 类）
    ("bereitstellung", ["bereitstellung", "vorheriger fahrt", "vorausfahrenden zuges",
                        "vorausfahrenden zug", "wartung des zuges", "fahrzeugbereitstellung"]),
    # 车辆技术故障（Fahrzeug 类）
    ("fahrzeug", ["technische störung am zug", "störung am fahrzeug", "defekt am zug",
                  "fahrzeugstörung", "türstörung", "tür", "lokschaden",
                  "schaden am fahrzeug", "wagenschaden", "technischer defekt"]),
    # 信号 / 基础设施（Infrastruktur 类）
    ("infrastruktur", ["signalstörung", "reparatur an einem signal", "signal",
                       "weichenstörung", "weiche", "oberleitung", "stromabnehmer",
                       "leitungsstörung", "stellwerk", "störung im betriebsablauf",
                       "infrastruktur", "bahnübergang"]),
    # 施工（Bau 类）
    ("bau", ["bauarbeiten", "baustelle", "bauwerk", "gleisbau", "revision",
             "instandhaltung", "brückenarbeiten", "bau"]),
    # 线路中断（Strecke 类）
    ("strecke", ["streckensperrung", "streckenunterbrechung", "gleissperrung",
                 "gleisbelegung", "strecke gesperrt", "gesperrt", "behinderung auf der strecke",
                 "strecke"]),
    # 天气
    ("wetter", ["wetter", "sturm", "unwetter", "schnee", "eisglätte", "glätte",
                "hochwasser", "hitze", "orkan", "regen"]),
    # 应急处置（Einsatz 类）
    ("einsatz", ["polizeieinsatz", "feuerwehr", "rettungseinsatz", "notarzteinsatz",
                 "notarzt", "rettung", "polizei", "einsatz", "gefahrgut"]),
    # 乘客相关
    ("passagier", ["personen im gleis", "personenschaden", "reiseverzicht",
                   "passagier", "fahrgast", "tier im gleis", "notfall"]),
]


def _split_train(train):
    """'RE 8' / 'RE_26709' → ('RE', 8) / ('RE', 26709)"""
    import re
    m = re.match(r"^([A-Za-z]+)[\s_]*(\d+)", str(train).strip())
    if not m:
        return None, None
    return m.group(1).upper(), int(m.group(2))


def _cat_of_text(text):
    """从消息文本推断原因类别。返回 (应用类别, 是否命中规则)。"""
    blob = (text or "").strip().lower()
    for mapped, kws in TEXT_RULES:
        for kw in kws:
            if kw in blob:
                return mapped, True
    return "sonstiges", False


def fetch_incidents(train, date_iso="", eva_along=""):
    from datetime import date as _date
    today = _date.today().isoformat()
    target = date_iso or today
    if target < today:
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "非当日无实时事件"}

    cat, num = _split_train(train)
    if not cat or not num:
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "无法解析车次"}

    try:
        from db_bahn_expert import find_journey, journey_details
    except Exception as e:  # noqa
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "bahn.expert 模块加载失败: %s" % str(e)[:60]}

    try:
        journeys = find_journey(num, cat, eva_along_route=(eva_along or None))
    except Exception as e:  # noqa
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "bahn.expert 查询失败: %s" % str(e)[:80]}
    if not journeys:
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "今日无该车次实例"}

    # 多实例时优先选「与请求类别一致」的那条；否则取第一条
    jny = None
    for j in journeys:
        tj = (j.get("train") or {})
        if (tj.get("category") or "").upper() == cat:
            jny = j
            break
    jny = jny or journeys[0]
    jid = jny.get("journeyId")
    if not jid:
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "journeyId 为空"}

    try:
        det = journey_details(jid)
    except Exception as e:  # noqa
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "行程详情获取失败: %s" % str(e)[:80]}
    if not det:
        return {"source": "iris", "train": train, "date": target,
                "incidents": [], "error": "行程详情为空"}

    incidents = []
    seen = set()
    max_delay = 0
    first_stop = last_stop = ""

    stops = det.get("stops") or []
    if stops:
        first_stop = ((stops[0].get("stopPlace") or {}).get("name") or "")
        last_stop = ((stops[-1].get("stopPlace") or {}).get("name") or "")

    for s in stops:
        sp = s.get("stopPlace") or {}
        st_name = sp.get("name") or ""
        for side in ("departure", "arrival"):
            ev = s.get(side) or {}
            d = ev.get("delay")
            if isinstance(d, (int, float)) and d > max_delay:
                max_delay = int(d)
        for msg in (s.get("irisMessages") or []):
            _add(incidents, seen, msg, st_name)

    return {
        "source": "iris",
        "train": train,
        "date": target,
        "journey_id": jid,
        "journey_desc": ((det.get("train") or {}).get("journeyDescription")
                         or jny.get("train", {}).get("category", "") + " " + str(num)),
        "first_stop": first_stop,
        "last_stop": last_stop,
        "max_delay": max_delay,
        "incidents": incidents,
    }


def _add(incidents, seen, msg, station):
    """把一条 irisMessage 归一化后加入列表（按 (类别,站,文本) 去重）。"""
    text = (msg.get("text") or "").strip()
    if not text:
        return
    cat_inner, _hit = _cat_of_text(text)
    key = (cat_inner, station, text[:60])
    if key in seen:
        return
    seen.add(key)
    incidents.append({
        "category": cat_inner,
        "label": text,           # 原文即「Bemerkung」，直接展示
        "text": text,
        "station": station,
        "value": msg.get("value"),
        "time": msg.get("timestamp") or "",
    })


if __name__ == "__main__":
    train = sys.argv[1] if len(sys.argv) > 1 else ""
    date_iso = sys.argv[2] if len(sys.argv) > 2 else ""
    eva_along = sys.argv[3] if len(sys.argv) > 3 else ""
    print(json.dumps(fetch_incidents(train, date_iso, eva_along),
                     ensure_ascii=False, indent=1))
