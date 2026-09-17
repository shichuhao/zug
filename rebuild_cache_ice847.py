import json, os
# 从本会话已抓的真实数据重建 ICE_847 8 天缓存
# 完整逐站：8-19/8-18/8-17/8-16（之前 zuginfo 输出）
# 单行近似（仅 max 站+延误）：8-12/8-13/8-14/8-15（公开页 max_delay）

cache = {
    "2026-08-19": [
        {"bhf": "Köln Hbf", "arr": "99:99", "adelay": "0",  "dep": "08:26", "ddelay": "0",  "zeit": "826"},
        {"bhf": "Düsseldorf Hbf", "arr": "08:47", "adelay": "3",  "dep": "08:48", "ddelay": "7",  "zeit": "847"},
        {"bhf": "Düsseldorf Flughafen", "arr": "08:55", "adelay": "6",  "dep": "08:57", "ddelay": "5",  "zeit": "855"},
        {"bhf": "Duisburg Hbf", "arr": "09:05", "adelay": "7",  "dep": "09:06", "ddelay": "7",  "zeit": "905"},
        {"bhf": "Essen Hbf", "arr": "09:18", "adelay": "5",  "dep": "09:19", "ddelay": "10", "zeit": "918"},
        {"bhf": "Bochum Hbf", "arr": "09:30", "adelay": "11", "dep": "09:31", "ddelay": "11", "zeit": "930"},
        {"bhf": "Dortmund Hbf", "arr": "09:43", "adelay": "8",  "dep": "09:47", "ddelay": "7",  "zeit": "943"},
        {"bhf": "Hamm(Westf)Hbf", "arr": "10:02", "adelay": "7",  "dep": "10:18", "ddelay": "12", "zeit": "1002"},
        {"bhf": "Hannover Hbf", "arr": "12:27", "adelay": "69", "dep": "12:31", "ddelay": "71", "zeit": "1227"},
        {"bhf": "Wolfsburg Hbf", "arr": "13:03", "adelay": "73", "dep": "13:05", "ddelay": "73", "zeit": "1303"},
        {"bhf": "Berlin-Spandau", "arr": "13:57", "adelay": "77", "dep": "99:99", "ddelay": "77", "zeit": "1357"},
        {"bhf": "Berlin Hbf", "arr": "14:12", "adelay": "75", "dep": "14:15", "ddelay": "74", "zeit": "1412"},
        {"bhf": "Berlin Südkreuz", "arr": "14:20", "adelay": "76", "dep": "99:99", "ddelay": "76", "zeit": "1420"},
    ],
    "2026-08-18": [
        {"bhf": "Köln Hbf", "arr": "99:99", "adelay": "0",  "dep": "08:26", "ddelay": "0",  "zeit": "826"},
        {"bhf": "Düsseldorf Hbf", "arr": "08:47", "adelay": "6",  "dep": "08:48", "ddelay": "10", "zeit": "847"},
        {"bhf": "Düsseldorf Flughafen", "arr": "08:55", "adelay": "10", "dep": "08:57", "ddelay": "10", "zeit": "855"},
        {"bhf": "Duisburg Hbf", "arr": "09:05", "adelay": "9",  "dep": "09:06", "ddelay": "12", "zeit": "905"},
        {"bhf": "Essen Hbf", "arr": "09:18", "adelay": "11", "dep": "09:19", "ddelay": "12", "zeit": "918"},
        {"bhf": "Bochum Hbf", "arr": "09:30", "adelay": "9",  "dep": "09:31", "ddelay": "10", "zeit": "930"},
        {"bhf": "Dortmund Hbf", "arr": "09:43", "adelay": "8",  "dep": "09:47", "ddelay": "6",  "zeit": "943"},
        {"bhf": "Hamm(Westf)Hbf", "arr": "10:02", "adelay": "9",  "dep": "10:18", "ddelay": "24", "zeit": "1002"},
        {"bhf": "Hannover Hbf", "arr": "12:27", "adelay": "58", "dep": "12:31", "ddelay": "58", "zeit": "1227"},
        {"bhf": "Wolfsburg Hbf", "arr": "13:03", "adelay": "57", "dep": "13:05", "ddelay": "58", "zeit": "1303"},
        {"bhf": "Berlin-Spandau", "arr": "13:57", "adelay": "63", "dep": "13:59", "ddelay": "62", "zeit": "1357"},
        {"bhf": "Berlin Hbf", "arr": "14:12", "adelay": "59", "dep": "14:15", "ddelay": "59", "zeit": "1412"},
        {"bhf": "Berlin Südkreuz", "arr": "14:20", "adelay": "60", "dep": "99:99", "ddelay": "60", "zeit": "1420"},
    ],
    "2026-08-17": [
        {"bhf": "Köln Hbf", "arr": "99:99", "adelay": "2",   "dep": "08:26", "ddelay": "2",   "zeit": "826"},
        {"bhf": "Düsseldorf Hbf", "arr": "08:47", "adelay": "5",   "dep": "08:48", "ddelay": "6",   "zeit": "847"},
        {"bhf": "Düsseldorf Flughafen", "arr": "08:55", "adelay": "4",   "dep": "08:57", "ddelay": "3",   "zeit": "855"},
        {"bhf": "Duisburg Hbf", "arr": "09:05", "adelay": "3",   "dep": "09:06", "ddelay": "4",   "zeit": "905"},
        {"bhf": "Essen Hbf", "arr": "09:18", "adelay": "4",   "dep": "09:19", "ddelay": "5",   "zeit": "918"},
        {"bhf": "Bochum Hbf", "arr": "09:30", "adelay": "2",   "dep": "09:31", "ddelay": "5",   "zeit": "930"},
        {"bhf": "Dortmund Hbf", "arr": "09:43", "adelay": "3",   "dep": "09:47", "ddelay": "2",   "zeit": "943"},
        {"bhf": "Hamm(Westf)Hbf", "arr": "10:02", "adelay": "16",  "dep": "10:18", "ddelay": "21",  "zeit": "1002"},
        {"bhf": "Weetzen", "arr": "12:02", "adelay": "26",  "dep": "12:02", "ddelay": "94",  "zeit": "1202"},
        {"bhf": "Hannover Hbf", "arr": "12:27", "adelay": "108", "dep": "12:31", "ddelay": "110", "zeit": "1227"},
        {"bhf": "Wolfsburg Hbf", "arr": "13:03", "adelay": "107", "dep": "13:05", "ddelay": "109", "zeit": "1303"},
        {"bhf": "Berlin-Spandau", "arr": "13:57", "adelay": "111", "dep": "13:59", "ddelay": "111", "zeit": "1357"},
        {"bhf": "Berlin Hbf", "arr": "14:12", "adelay": "112", "dep": "14:15", "ddelay": "113", "zeit": "1412"},
        {"bhf": "Berlin Südkreuz", "arr": "14:20", "adelay": "118", "dep": "99:99", "ddelay": "118", "zeit": "1420"},
    ],
    "2026-08-16": [
        {"bhf": "Köln Hbf", "arr": "99:99", "adelay": "45",  "dep": "08:26", "ddelay": "45",  "zeit": "826"},
        {"bhf": "Düsseldorf Hbf", "arr": "08:47", "adelay": "45",  "dep": "08:48", "ddelay": "47",  "zeit": "847"},
        {"bhf": "Düsseldorf Flughafen", "arr": "08:55", "adelay": "-1", "dep": "08:57", "ddelay": "-1", "zeit": "855"},
        {"bhf": "Duisburg Hbf", "arr": "09:05", "adelay": "49",  "dep": "09:06", "ddelay": "51",  "zeit": "905"},
        {"bhf": "Essen Hbf", "arr": "09:18", "adelay": "50",  "dep": "09:19", "ddelay": "51",  "zeit": "918"},
        {"bhf": "Bochum Hbf", "arr": "09:30", "adelay": "48",  "dep": "09:31", "ddelay": "51",  "zeit": "930"},
        {"bhf": "Dortmund Hbf", "arr": "09:43", "adelay": "51",  "dep": "09:47", "ddelay": "50",  "zeit": "943"},
        {"bhf": "Hamm(Westf)Hbf", "arr": "10:02", "adelay": "51",  "dep": "10:18", "ddelay": "46",  "zeit": "1002"},
        {"bhf": "Hannover Hbf", "arr": "12:27", "adelay": "47",  "dep": "12:31", "ddelay": "49",  "zeit": "1227"},
        {"bhf": "Wolfsburg Hbf", "arr": "13:03", "adelay": "46",  "dep": "13:05", "ddelay": "46",  "zeit": "1303"},
        {"bhf": "Stendal Hbf", "arr": "13:30", "adelay": "46",  "dep": "13:30", "ddelay": "60",  "zeit": "1330"},
        {"bhf": "Berlin-Spandau", "arr": "13:57", "adelay": "68",  "dep": "13:59", "ddelay": "68",  "zeit": "1357"},
        {"bhf": "Berlin Hbf", "arr": "14:12", "adelay": "67",  "dep": "14:15", "ddelay": "71",  "zeit": "1412"},
        {"bhf": "Berlin Südkreuz", "arr": "14:20", "adelay": "71",  "dep": "99:99", "ddelay": "71",  "zeit": "1420"},
    ],
}
# 早期日：单行近似（公开页 max_delay）
cache["2026-08-15"] = [{"bhf": "Berlin Südkreuz", "arr": "14:20", "adelay": "75",  "dep": "99:99", "ddelay": "75",  "zeit": "1420"}]
cache["2026-08-14"] = [{"bhf": "Berlin Südkreuz", "arr": "14:20", "adelay": "104", "dep": "99:99", "ddelay": "104", "zeit": "1420"}]
cache["2026-08-13"] = [{"bhf": "Wolfsburg Hbf",   "arr": "13:03", "adelay": "58",  "dep": "13:05", "ddelay": "58",  "zeit": "1303"}]
cache["2026-08-12"] = [{"bhf": "Berlin Südkreuz", "arr": "14:20", "adelay": "82",  "dep": "99:99", "ddelay": "82",  "zeit": "1420"}]

base = os.path.expanduser("~/.cache/zugfinder_pro/ICE_847")
os.makedirs(base, exist_ok=True)
for d, rows in cache.items():
    p = os.path.join(base, d + ".json")
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False)
print("重建缓存: %d 天 -> %s" % (len(cache), base))