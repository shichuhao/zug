// 列车晚点 webapp —— 零依赖 Node 后端
// 接口：
//   /api/delay?train=X        —— 本地模拟数据集查询（旧，兼容）
//   /api/train?train=X        —— 真实预测：zugfinder Pro 逐站 + 明日预测（调 python train_insight.py）
//   POST /api/share           —— 保存预测快照 {data} → {id, url}
//   GET  /api/share/:id       —— 读取预测快照（分享链接加载）
// 环境变量：PYTHON_BIN（python 解释器，默认指向本地已验证解释器）
// 分享快照：data/shares/<id>.json，默认保留 30 天（启动时清理过期）

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const url = require("url");
const childProcess = require("child_process");
const { spawn } = require("child_process");
const zlib = require("zlib");

// 读取 .env：进程本身不依赖 dotenv，但如果运维直接 `node server.js` 而不先 export，
// 行程抓取的 ZUGFINDER_SOCKS5 等配置就会静默丢失（表现为 IndexOf `SubTitle=0`、
// 代理分支不生效而回落到直连）。故在此显式加载；已有同名环境变量优先，便于覆盖。
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  let text;
  try { text = fs.readFileSync(envPath, "utf8"); } catch (_) { return; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // 去掉成对引号
    if (val.length >= 2 && /^(["']).*\1$/.test(val)) val = val.slice(1, -1);
    if (key in process.env) continue; // 外部传入优先
    process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "delays.json");
const INSIGHT_SCRIPT = path.join(ROOT, "train_insight.py");
const TIMETABLE = path.join(ROOT, "data", "timetable_re_rb.json");
const SHARES_DIR = path.join(ROOT, "data", "shares");
// 分享快照 TTL。QA SEC-04 建议 ≤7 天：分享链接无需鉴权，任何人拿到 id 即可读，
// 存活越久泄露面越大。默认收到 7 天（原 30 天），可用 SHARE_TTL_DAYS 覆盖。
const SHARE_TTL_MS = (parseInt(process.env.SHARE_TTL_DAYS, 10) || 7) * 86400000;
// 用户 / 会话 / 查询历史（零依赖 JSON 存储）
const USERS_FILE = path.join(ROOT, "data", "users.json");
const SESSIONS_FILE = path.join(ROOT, "data", "sessions.json");
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
// 访问人数统计（独立访客，按前端 visitorId 去重；零依赖 JSON 存储）
const VISITORS_FILE = path.join(ROOT, "data", "visitors.json");
const HISTORY_LIMIT = 200;           // 每用户最多保留条数
const SESSION_TTL_MS = 30 * 86400000; // 会话 30 天
// 评论区（零依赖 JSON 存储；登录可发评，游客可看）
const COMMENTS_FILE = path.join(ROOT, "data", "comments.json");
const COMMENTS_LIMIT = 500;           // 评论区最多保留条数（超出丢最旧）
const COMMENT_MAX_LEN = 500;          // 单条评论最长字符
// 评论配图：存于 data/comment_images/，仅服务端命名的安全文件名可被静态访问
const COMMENT_IMG_DIR = path.join(ROOT, "data", "comment_images");
const COMMENT_IMG_MAX_BYTES = 3 * 1024 * 1024; // 单图上限 3MB
// 评论体要容纳 base64 图片（膨胀约 4/3）+ JSON 外壳，默认 64KB 会把稍大的图直接截断。
// 6MB ≈ 4MB 原图转 base64 后的量，留足余量；非评论接口仍走各自的小上限。
const COMMENT_BODY_MAX_BYTES = 6 * 1024 * 1024;
const COMMENT_IMG_EXT = { png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif", webp: "webp" };
const PREDICTION_CACHE_TTL_MS = Math.max(0, parseInt(process.env.PREDICTION_CACHE_TTL_MS, 10) || 3600000);
const PREDICTION_CACHE_MAX_ENTRIES = Math.max(1, parseInt(process.env.PREDICTION_CACHE_MAX_ENTRIES, 10) || 100);
// 运行中列车（响应含 `running`）的延误每分钟都在变，长 TTL 会把旧值（如早上的 3 分）
// 一直返回给用户，让底层实时补正"修了却看不见"。对这类响应改用短 TTL：
//   进程内缓存 90s、磁盘缓存 120s。列车终到后 running 消失，自动回到长 TTL。
//   2026-09-18 bug：修好 train_insight 的实时补正后，UI 仍停留在旧值，即因此。
const RUNNING_CACHE_TTL_MS = Math.max(0, parseInt(process.env.RUNNING_CACHE_TTL_MS, 10) || 90000);
const RUNNING_DISK_CACHE_TTL_MS = Math.max(0, parseInt(process.env.RUNNING_DISK_CACHE_TTL_MS, 10) || 120000);
const predictionCache = new Map();
// ---- /api/train 并发合并表（2026-09-14 压测）----
// cacheKey → { n, waiters: [respond] }。同一冷车次的并发请求共用一次 python spawn，
// 避免 N 个人 = N 个 3.4GB 进程一起跑 → CPU 打满 → 全员超时 502。
// 仅在「未命中任何缓存、确实要 spawn」时登记，命中缓存的请求从不进这里。
const trainInflight = new Map();
// spawn 降级闸门（2026-09-14 并发压测发现）：
// worker 崩溃/超时后所有在途请求会同时降级 spawn，而单个 spawn 冷启 RSS ≈ 3.4GB
// （21MB 模型 + 131MB 历史表 + pandas 中间态）。实测 4 个并发降级就把 8GB 撞爆，
// oom_kill 直接清场 —— 比「明确报错」糟糕得多，因为它把故障面从 worker 扩大到整机。
// 所以给 spawn 加硬闸门：超出 M 个并发就直接 503，宁可让用户重试也不拖垮服务。
const SPAWN_MAX_CONCURRENCY = (() => {
  const v = parseInt(process.env.SPAWN_MAX_CONCURRENCY, 10);
  return Number.isFinite(v) && v >= 1 ? v : 1;
})();
let _spawnActive = 0;
// 常驻预测 worker（2026-09-14 架构升级）：缺省开启，设 PREDICTOR_WORKER_URL="" 可关闭
// 回落到 spawn-per-request 老路径（老路径已原样保留作降级）。
const PREDICTOR_WORKER_URL =
  process.env.PREDICTOR_WORKER_URL !== undefined
    ? String(process.env.PREDICTOR_WORKER_URL)
    : "http://127.0.0.1:5099";
// worker 调用超时：worker 单次预测 8~10s（模型已常驻），但冷 socket + 网络抓取
// 偶发抖动，给 120s 余量；超过则降级 spawn，不让用户干等。
const WORKER_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.WORKER_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 5000 ? v : 120000;
})();

// 调用常驻 worker 做预测，返回解析好的 dict（含 error 字段表示业务失败）。
// worker 本身负责串行/并发闸门；这里只做 HTTP + JSON + 超时。
function callPredictorWorker(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const u = new URL("/predict", PREDICTOR_WORKER_URL);
    // https 原在别处函数内 require（行 ~668），此处按需引入避免顶层污染
    const mod = u.protocol === "https:" ? require("https") : http;
    let req;
    try {
      req = mod.request({
        hostname: u.hostname, port: u.port, path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          // 非 200 = worker 明确拒绝，最常见是并发闸门满 → 503 worker_busy。
          // 必须把 status 带给上层：繁忙与「进程不可达」的处理方式完全相反，
          // 前者若跟着降级 spawn，会瞬间 fork 出 N 个 3.4GB 的 python 打爆内存。
          if (res.statusCode !== 200) {
            // worker 对业务错误也走 HTTP 502（见 predictor_worker.py 的 code 判定），
            // 必须把 body 一起带上，否则上层分不清「车次不存在」和「worker 挂了」。
            let j = null;
            try { j = JSON.parse(raw); } catch (_) {}
            const e2 = new Error("worker HTTP " + res.statusCode + ": "
              + ((j && j.error) ? j.error : raw.slice(0, 200)));
            e2.status = res.statusCode;
            e2.body = j;
            return reject(e2);
          }
          try {
            resolve(JSON.parse(raw));
          } catch (_) {
            reject(new Error("worker 返回非 JSON: " + raw.slice(0, 200)));
          }
        });
      });
    } catch (e) { return reject(e); }
    req.setTimeout(WORKER_TIMEOUT_MS, () => {
      try { req.destroy(new Error("worker 超时 " + WORKER_TIMEOUT_MS + "ms")); } catch (_) {}
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---- 磁盘级预测缓存（2026-09-11）：跨用户共享 + 当日有效、次日自动失效 ----
// 之前只有进程内 Map：重启即失效、无法给其他访问者复用。python 预测一次 10~40s，
// 同一天同一车次被多人查询时应直接复用。文件名 = sha1(cacheKey)，内容带
// saved_at_date（欧洲/柏林时区），读出时日期不是今天 → 删除并视为未命中。
const TRAIN_DISK_CACHE_DIR = path.join(ROOT, "data", "cache", "train");

function berlinToday() {
  // sv-SE locale 直接给 YYYY-MM-DD
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

// 柏林时区「今天 + n 天」，YYYY-MM-DD。
// 用于预热时复刻前端的默认预测日期（predictDateISO() 里 tomorrow = +1），
// 保证预热写入的 cacheKey 与用户实际请求完全一致（见 warmupOneTrain 注释）。
function berlinDateOffset(n) {
  const base = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  base.setDate(base.getDate() + n);
  return base.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

function trainDiskCachePath(key) {
  const h = crypto.createHash("sha1").update(key).digest("hex");
  return path.join(TRAIN_DISK_CACHE_DIR, h + ".json");
}

function getTrainDiskCache(key) {
  const f = trainDiskCachePath(key);
  try {
    const entry = JSON.parse(fs.readFileSync(f, "utf-8"));
    if (entry.saved_at_date !== berlinToday()) {
      // 次日（或更旧）→ 失效：删文件重算
      try { fs.unlinkSync(f); } catch (_) {}
      return null;
    }
    // 运行中列车的今日数据是动态变化的：磁盘条目也用短 TTL 过期，避免旧值整天返回
    // （2026-09-18 bug：运行时补正已生效，但磁盘缓存把早上的旧值继续送出）。
    if (entry.data && entry.data.running && RUNNING_DISK_CACHE_TTL_MS) {
      const age = Date.now() - Date.parse(entry.saved_at || 0);
      if (!Number.isFinite(age) || age > RUNNING_DISK_CACHE_TTL_MS) {
        try { fs.unlinkSync(f); } catch (_) {}
        return null;
      }
    }
    // 无 _query 回显的旧文件无法被 /api/breakdown 回放 → 视为无效，删除重算
    if (!entry.data || !entry.data._query) {
      try { fs.unlinkSync(f); } catch (_) {}
      return null;
    }
    return entry.data;
  } catch (_) {
    return null;
  }
}

function setTrainDiskCache(key, data) {
  try {
    fs.mkdirSync(TRAIN_DISK_CACHE_DIR, { recursive: true });
    const f = trainDiskCachePath(key);
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      saved_at_date: berlinToday(),
      saved_at: new Date().toISOString(),
      data,
    }), "utf-8");
    fs.renameSync(tmp, f);
  } catch (e) {
    console.error("train disk cache write err:", e.message);
  }
}

function cleanTrainDiskCache() {
  // 启动 + 每小时：删除非今天的缓存文件（幂等）
  const today = berlinToday();
  fs.readdir(TRAIN_DISK_CACHE_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(TRAIN_DISK_CACHE_DIR, f);
      try {
        const entry = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (entry.saved_at_date !== today) fs.unlinkSync(p);
      } catch (_) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
  });
}
setInterval(cleanTrainDiskCache, 3600 * 1000).unref();

// ---- 车次数据暂存（供 /api/breakdown 复用 /api/train 已取回的 python 结果）----
// breakdown 拆为独立懒加载端点后，/api/train 不再同步计算成分拆解；
// 这里按 cacheKey 记住最近的 python 输出 + 查询参数，/api/breakdown 直接取用。
const _trainDataMemo = new Map(); // key -> { train, destination, data, at }
const TRAIN_MEMO_MAX = 300;
function memoTrainData(key, train, destination, data) {
  if (_trainDataMemo.size >= TRAIN_MEMO_MAX) {
    _trainDataMemo.delete(_trainDataMemo.keys().next().value);
  }
  _trainDataMemo.set(key, { train, destination, data, at: Date.now() });
}
function takeMemoTrainData(key) {
  const m = _trainDataMemo.get(key);
  if (!m) return null;
  m.at = Date.now(); // touch
  return m;
}

// 兜底匹配：cacheKey 严格不一致时（旧缓存无 _query 回显 / 前端参数形式差异），
// 按「同车次 + 同区间」找最近一条 memo。找不到才 410。
function findMemoFuzzy(train, q) {
  const want = String(train || "").toUpperCase().replace(/\s+/g, " ");
  let best = null;
  for (const m of _trainDataMemo.values()) {
    if (String(m.train || "").toUpperCase().replace(/\s+/g, " ") !== want) continue;
    const qq = (m.data && m.data._query) || {};
    if ((qq.ride_from || "") !== (q.ride_from || "")) continue;
    if ((qq.ride_to || "") !== (q.ride_to || "")) continue;
    if (!best || m.at > best.at) best = m;
  }
  return best;
}
const JOURNEY_FETCH_MAX_BYTES = 2 * 1024 * 1024;
// python 解释器：可用 PYTHON_BIN 覆盖。
// Linux 优先使用 miniconda（含 lightgbm/scipy 等模型依赖）；直接用 "python3"
// 会解析到 pyenv shim，缺少 lightgbm → train_insight 静默降级、模型层永远
// 不可用（线上实测 MODEL_PREDICT_SKIP: No module named 'lightgbm'）。
const PYTHON_BIN =
  process.env.PYTHON_BIN ||
  (process.platform === "win32"
    ? "C:/Users/hh/.workbuddy/binaries/python/envs/lgb/Scripts/python.exe"
    : (fs.existsSync("/root/miniconda/bin/python")
        ? "/root/miniconda/bin/python"
        : "python3"));
// python 预测子进程超时预算（毫秒）。冷启动实测 85s 属正常，默认给 150s 余量。
const PYTHON_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.PYTHON_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 30000 ? v : 150000;
})();
// 启动自检：所选解释器是否具备模型依赖（lightgbm）。缺失则显式告警，
// 避免「模型已接线但静默降级」这种不可观测状态。
const MODEL_DEPS_OK = (() => {
  try {
    const r = childProcess.spawnSync(PYTHON_BIN,
      ["-c", "import lightgbm, scipy, pandas, numpy"],
      { timeout: 20000, windowsHide: true });
    return r.status === 0;
  } catch (_) { return false; }
})();
if (!MODEL_DEPS_OK) {
  console.warn("[warn] 模型依赖缺失（lightgbm/scipy/pandas）：PYTHON_BIN=" +
    PYTHON_BIN + " → 预测将降级为统计基线。请安装依赖或用 PYTHON_BIN 指定。");
} else {
  console.log("[ok] 模型依赖就绪：" + PYTHON_BIN);
}
const LOCAL_PRO_DIR = process.env.ZUGFINDER_PRO_DIR ||
  (process.platform === "win32" ? "K:/ZUGVORHERSAGEN/delay_model" : "");

// 影响分析数据源，可通过 IMPACT_DATA_DIR 指向部署机上的数据目录
const IMPACT_DATA_DIR = process.env.IMPACT_DATA_DIR || path.join(ROOT, "data", "impact");
const IMPACT_SRC = {
  causes: path.join(IMPACT_DATA_DIR, "delay_cause_frequency.csv"),
  sub: path.join(IMPACT_DATA_DIR, "delay_cause_subcategory_frequency.csv"),
  weather: path.join(IMPACT_DATA_DIR, "weather_features_by_region_date.csv"),
  incidents: path.join(IMPACT_DATA_DIR, "planned_incidents.csv"),
  stationMap: path.join(IMPACT_DATA_DIR, "station_anchor_map.parquet"),
  // 原因画像：由 raw_data 的 delay_codes 直接统计（含实测延误/取消率），
  // 窗口可任意（默认最近一轮批处理）。与 causes CSV 互为交叉验证。
  reasonProfile: process.env.REASON_PROFILE ||
    path.join(ROOT, "data", "reasons", "reason_profile.json"),
  // zugfinder 730 天归档的原因统计（德文正文，可读；覆盖 2024-2026）。
  // 与 reasonProfile（数值编码）互补：编码看规模，正文看语义。
  zfReasons: process.env.ZF_REASONS ||
    path.join(ROOT, "data", "reasons", "zugfinder", "reason_stats.json"),
  // 分车型原因分布与严重度倍率（由全量 220 万行逐日归档计算）。
  // 动机：车型间差异巨大 —— remark 率 IC 0.72% vs ICE 36.36%（50 倍），
  // 有/无 remark 延误差 ICE 2.00x vs IC 8.26x。全局权重会误判。
  zfByType: process.env.ZF_BY_TYPE ||
    path.join(ROOT, "data", "reasons", "zugfinder", "reason_by_type.json"),
  // 逐车次号原因成分（parquet delay_codes 逐站 + msg_cats 逐站，本地窗口）。
  // 让单车次查询也能出「成分构成图」，样本不足时降级到线路画像。
  trainBreakdowns: process.env.TRAIN_BREAKDOWNS ||
    path.join(ROOT, "data", "reasons", "train_breakdowns.json"),
};

// 合法原因类别键（用于过滤线路画像里的派生键，如 ausfall 取消率）
const CAT_KEYS = new Set([
  "infrastruktur", "strecke", "bau", "fahrzeug", "bereitstellung", "kaskade",
  "wetter", "einsatz", "passagier", "wagen", "sonstiges", "keine",
]);

// 逐车次原因索引：懒加载 + 进程内缓存（19MB JSON，不重复解析）
let _TB_CACHE = null;function loadTrainBreakdowns() {
  if (_TB_CACHE) return _TB_CACHE;
  _TB_CACHE = readJSON(IMPACT_SRC.trainBreakdowns, null);
  return _TB_CACHE;
}

// 在逐车次索引里按「车次号」定位，容忍 "RE 3308" / "RE3308" / "3308"+"RE" 等写法
function findTrainBreakdown(train) {
  const tb = loadTrainBreakdowns();
  if (!tb || !tb.trains) return null;
  const raw = String(train || "").trim().toUpperCase();
  if (!raw) return null;
  // 归一：拆成 (字母前缀, 数字)
  const m = raw.match(/^([A-Z]+)\s*(\d+)$/) || raw.match(/^([A-Z]+)_(\d+)$/);
  const cat = m ? m[1] : "";
  const num = m ? m[2] : raw.replace(/\D/g, "");
  if (!num) return null;
  const key = cat ? cat + " " + num : num;
  if (tb.trains[key]) return tb.trains[key];
  // 前缀对不上时（如 RE 写成 RB），只按数字号兜底匹配
  if (num) {
    const hit = tb.trains["RE " + num] || tb.trains["RB " + num] ||
      tb.trains["IC " + num] || tb.trains["ICE " + num];
    if (hit) return hit;
  }
  return null;
}

// =========================== 用户 / 会话 / 查询历史 ===========================
// 零依赖实现：JSON 文件 + crypto.scrypt（无密码复杂度限制，邮箱无需验证）

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch (_) { return fallback; }
}

// 数据目录可写性标志（2026-09-18 新增）。
// 2026-09-17 的 QA 复现了「data/ 被挂成只读（EROFS）→ 写操作抛异常 →
// 异常冒泡拖垮整个 Node 进程 → 全站 HTTP 000」的单点故障。
// 这里统一把 FS 错误收敛成可识别的 StorageError，绝不冒泡到进程层。
class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StorageError";
    this.code = "E_STORAGE_READONLY";
    this.status = 503;
    this.cause = cause;
  }
}
let _storageReadonly = false;
const _storageWarned = new Set();
function writeJSONAtomic(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf-8");
    fs.renameSync(tmp, p); // 原子替换，防并发读半文件
    _storageReadonly = false;
  } catch (e) {
    const ro = e && (e.code === "EROFS" || e.code === "EACCES" || e.code === "EPERM" || e.code === "ENOSPC" || e.code === "EDQUOT");
    if (ro) {
      _storageReadonly = true;
      const key = String(e.code);
      if (!_storageWarned.has(key)) {
        _storageWarned.add(key);
        console.error("[storage] 数据目录不可写（" + e.code + "）：" + p +
          " —— 写操作将返回 503，服务本身继续提供只读查询。" +
          " 请检查挂载是否只读 / 磁盘是否写满。");
      }
      throw new StorageError("存储暂时不可写（" + e.code + "），请稍后重试", e);
    }
    // 非存储类错误（如序列化失败）原样抛出，便于定位
    throw e;
  }
}
// ===================== 速率限制（2026-09-18，QA SEC-01/SEC-02）=====================
// QA 指出：/api/register 无速率限制 → 可暴力枚举邮箱+灌水；
//          评论 5s 内可连发 10 条 → 反垃圾形同虚设。
// 这里做**进程内滑动窗口**限流（零依赖、足够抵挡脚本灌水）。
// 注意：单机内存计数在多实例部署下会失效，若将来横向扩容需换 Redis。
const RATE_LIMITS = {
  // route        : [窗口毫秒, 窗口内允许次数]
  register:        [10 * 60 * 1000, 5],    // 注册：10 分钟 5 次
  login:           [5 * 60 * 1000, 20],    // 登录：5 分钟 20 次（防撞库）
  comment_post:    [60 * 1000, 5],         // 发评论：1 分钟 5 条
  comment_like:    [60 * 1000, 60],        // 点赞：1 分钟 60 次（正常用户够用）
  share_post:      [60 * 1000, 20],        // 建分享：1 分钟 20 次
  journey_parse:   [60 * 1000, 20],        // 行程解析：1 分钟 20 次（耗外部资源）
  train_incidents: [60 * 1000, 30],        // 实时事件：1 分钟 30 次
};
const _rateBuckets = new Map();
function clientIp(req) {
  // 部署在 nginx/tailscale 之后：优先取转发头，否则取 socket 地址
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (xf) return xf;
  return (req.socket && (req.socket.remoteAddress || "")) || "unknown";
}
/**
 * 返回 null 表示放行；否则返回 {retryAfter} 表示被限流。
 */
function checkRate(route, req) {
  const conf = RATE_LIMITS[route];
  if (!conf) return null;
  const [winMs, max] = conf;
  const key = route + "|" + clientIp(req);
  const now = Date.now();
  let arr = _rateBuckets.get(key);
  if (!arr) { arr = []; _rateBuckets.set(key, arr); }
  // 清掉窗口外的旧记录
  while (arr.length && now - arr[0] > winMs) arr.shift();
  if (arr.length >= max) {
    return { retryAfter: Math.max(1, Math.ceil((winMs - (now - arr[0])) / 1000)) };
  }
  arr.push(now);
  return null;
}
// 定期清理空桶，避免长期运行内存缓慢增长
setInterval(function () {
  const now = Date.now();
  for (const [k, arr] of _rateBuckets) {
    const route = k.split("|")[0];
    const conf = RATE_LIMITS[route];
    if (!conf) { _rateBuckets.delete(k); continue; }
    while (arr.length && now - arr[0] > conf[0]) arr.shift();
    if (!arr.length) _rateBuckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

/**
 * 限流中间件式调用：被限流时直接回 429 并返回 true（调用方应立即 return）。
 */
function rateLimited(res, route, req) {
  const hit = checkRate(route, req);
  if (!hit) return false;
  res.setHeader("Retry-After", String(hit.retryAfter));
  sendJSON(res, 429, {
    error: "E_RATE_LIMITED",
    message: "操作过于频繁，请 " + hit.retryAfter + " 秒后重试",
    retry_after: hit.retryAfter,
  });
  return true;
}

// 把「写操作 catch 块」里捕获的异常正确归因（2026-09-18）。
// 旧代码一律写成「请求体解析失败: ...」，于是 2026-09-17 存储只读时
// 返回的是 `请求体解析失败: EROFS: read-only file system...` ——
// 文案把「磁盘只读」伪装成「客户端请求格式错」，严重误导排查方向。
function sendWriteError(res, e, fallbackMsg) {
  if (e && e.name === "StorageError") {
    return sendJSON(res, 503, { error: "E_STORAGE_READONLY", message: e.message });
  }
  return sendJSON(res, 400, { error: (fallbackMsg || "请求体解析失败") + ": " + (e && e.message) });
}
// 把任意 handler 抛出的错误转成响应；绝不让异常冒泡到进程层
function failSafe(res, e, fallbackMsg) {
  try {
    if (e && e.name === "StorageError") {
      return sendJSON(res, 503, { error: "E_STORAGE_READONLY", message: e.message });
    }
    console.error("[handler] 未捕获异常: " + (e && e.stack || e));
    return sendJSON(res, 500, {
      error: "E_INTERNAL",
      message: (fallbackMsg || "服务内部错误") + (process.env.NODE_ENV === "production" ? "" : "：" + (e && e.message)),
    });
  } catch (_) {
    try { res.writeHead(500); res.end(); } catch (__) {}
  }
}

function loadUsers() { return readJSON(USERS_FILE, {}); }
function loadSessions() { return readJSON(SESSIONS_FILE, {}); }
function loadHistory() { return readJSON(HISTORY_FILE, {}); }
// 访问人数：{ count: 累计独立访客数, ids: { visitorId: lastSeenMs } }
function loadVisitors() {
  const v = readJSON(VISITORS_FILE, {});
  if (!v.ids || typeof v.ids !== "object") v.ids = {};
  if (typeof v.count !== "number") v.count = 0;
  return v;
}
function saveVisitors(v) { writeJSONAtomic(VISITORS_FILE, v); }
// 评论配图：解析前端传来的 data URL，校验格式/体积，落盘到 COMMENT_IMG_DIR，返回可访问路径
// ===================== 图片安全校验（2026-09-18，QA SEC-05 / LOW-07）=====================
// QA 指出两个问题：
//   SEC-05：评论图片直传，未做 magic bytes 校验 —— 只信 data URL 里的 MIME 声明，
//           把 .exe 改名成 .png 再 base64 就能过。
//   LOW-07：未剥离 EXIF —— 手机拍的图带 GPS 坐标，发一张图就暴露住址。
// 做法：magic bytes 用纯 Node 校验（零依赖、快），EXIF 剥离交给已有的 Python(PIL)。
const IMAGE_MAGIC = [
  // [MIME, 文件头字节（可从 offset 0 开始匹配任一项）]
  ["png",  [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]],
  ["jpeg", [Buffer.from([0xff, 0xd8, 0xff])]],
  ["gif",  [Buffer.from("GIF87a"), Buffer.from("GIF89a")]],
  // webp: "RIFF"????"WEBP"
  ["webp", [Buffer.from("RIFF")]],
];
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  for (const [type, magics] of IMAGE_MAGIC) {
    for (const m of magics) {
      if (buf.length >= m.length && buf.slice(0, m.length).equals(m)) {
        // webp 需再校验第 8-11 字节是 "WEBP"
        if (type === "webp" && buf.slice(8, 12).toString("ascii") !== "WEBP") continue;
        return type;
      }
    }
  }
  return null;
}
// 剥离 EXIF（含 GPS）与其它元数据。失败时原样返回（不因元数据问题拒收用户图片）。
const EXIF_STRIP_PY = path.join(ROOT, "tools", "strip_exif.py");
function stripExif(buf, ext, cb) {
  if (ext === "gif") return cb(null, buf); // GIF 一般不带 EXIF，跳过省一次进程开销
  const child = spawn(PYTHON_BIN, [EXIF_STRIP_PY], {
    env: Object.assign({}, process.env), windowsHide: true,
  });
  let out = [], errOut = "";
  let killed = false;
  const t = setTimeout(function () { killed = true; child.kill(); }, 8000);
  child.stdout.on("data", function (d) { out.push(d); });
  child.stderr.on("data", function (d) { errOut += d; });
  child.on("error", function () { clearTimeout(t); cb(null, buf); });
  child.on("close", function (code) {
    clearTimeout(t);
    const res = Buffer.concat(out);
    if (killed || code !== 0 || !res.length) {
      if (errOut) console.error("[exif-strip] 失败，保留原图:", errOut.slice(0, 200));
      return cb(null, buf); // 降级：剥离失败不阻断上传
    }
    cb(null, res);
  });
  child.stdin.end(buf);
}

function parseCommentImage(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("图片格式不支持，请用 PNG/JPG/GIF/WebP");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > COMMENT_IMG_MAX_BYTES) throw new Error("图片过大，请控制在 3MB 以内");
  // 关键：不再信任 data URL 里的 MIME 声明，以文件头为准
  const realType = sniffImageType(buf);
  if (!realType) {
    throw new Error("图片内容与格式不符（已拒绝），请重新导出为 PNG/JPG/GIF/WebP");
  }
  return { ext: COMMENT_IMG_EXT[realType], buf: buf, declared: m[1], real: realType };
}
function saveCommentImage(img) {
  const name = crypto.randomBytes(8).toString("hex") + "." + img.ext;
  const dst = path.join(COMMENT_IMG_DIR, name);
  try {
    fs.mkdirSync(COMMENT_IMG_DIR, { recursive: true });
    fs.writeFileSync(dst, img.buf);
    _storageReadonly = false;
  } catch (e) {
    // 存储只读时给出明确归因，避免冒泡成「请求体解析失败」
    if (e && (e.code === "EROFS" || e.code === "EACCES" || e.code === "EPERM" || e.code === "ENOSPC")) {
      _storageReadonly = true;
      throw new StorageError("存储暂时不可写（" + e.code + "），请稍后重试", e);
    }
    throw e;
  }
  return "/comment_images/" + name;
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString("hex");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 从请求提取 Bearer token
function getToken(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

// token → 用户（含会话过期清理）
function getUserByToken(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const rec = sessions[token];
  if (!rec) return null;
  if (Date.now() - new Date(rec.created_at).getTime() > SESSION_TTL_MS) {
    delete sessions[token];
    writeJSONAtomic(SESSIONS_FILE, sessions);
    return null;
  }
  const u = loadUsers()[rec.email];
  return u ? { email: u.email, created_at: u.created_at } : null;
}

// 记录查询历史（仅登录用户；失败静默不阻塞主流程）
function recordHistory(req, entry) {
  try {
    const token = getToken(req);
    if (!token) return;
    const email = loadSessions()[token];
    if (!email) return;
    const hist = loadHistory();
    const list = hist[email.email] || [];
    list.unshift(Object.assign(
      { id: crypto.randomBytes(4).toString("hex"), ts: new Date().toISOString() },
      entry));
    if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
    hist[email.email] = list;
    writeJSONAtomic(HISTORY_FILE, hist);
  } catch (e) {
    console.warn("[history] 记录失败:", e.message);
  }
}

function readBody(req, cb, maxBytes) {
  const limit = maxBytes || 65536;
  const chunks = [];
  let size = 0;
  let stopped = false;
  req.on("data", (c) => {
    if (stopped) return;
    size += c.length;
    chunks.push(c);
    if (size > limit) {
      // 不再 destroy：destroy 会切断连接，前端只能拿到一个没有 body 的 network error。
      // 这里标记超限后继续把剩余数据丢弃，等 end 时原样回调，让路由返回可读的错误。
      stopped = true;
    }
  });
  req.on("end", () => {
    if (stopped) {
      return cb(JSON.stringify({ __tooLarge: true, __limit: limit }));
    }
    cb(Buffer.concat(chunks).toString("utf8"));
  });
}

// 给历史记录补充"预测 vs 实际"对比（仅 train 类型）：
//   - 预测日已过且有实际值 → {actual:{date,end_delay,error}}
//   - 预测日已过但无实际值 → {actual:{needs_backfill:true}}
//   - 预测日未到 → actual=null（待验证）
function enrichHistory(rec) {
  const out = Object.assign({}, rec);
  if (rec.type !== "train") return out;
  const pd = rec.prediction && rec.prediction.prediction_date;
  const est = rec.prediction && rec.prediction.point_estimate;
  const days = rec.actual_days || [];
  const day = days.find((x) => x.date === pd);
  const todayStr = new Date().toISOString().slice(0, 10);
  if (day && day.end_delay != null) {
    out.actual = {
      date: pd,
      end_delay: day.end_delay,
      // -1 = 整班取消哨兵（zugfinder Pro 约定），不算数值误差
      canceled: day.end_delay === -1,
      error: (est != null && day.end_delay !== -1
              ? Math.round((day.end_delay - est) * 10) / 10 : null),
    };
  } else if (pd && pd < todayStr) {
    out.actual = { date: pd, end_delay: null, needs_backfill: true };
  } else {
    out.actual = null; // 未到预测日
  }
  return out;
}

// 清理过期分享快照（启动时执行一次）
function pruneShares() {
  try {
    if (!fs.existsSync(SHARES_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(SHARES_DIR)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(SHARES_DIR, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > SHARE_TTL_MS) fs.unlinkSync(p);
      } catch (_) { /* 单文件失败忽略 */ }
    }
    console.log(`分享快照清理完成（保留 ${SHARE_TTL_MS / 86400000} 天）`);
  } catch (e) {
    console.error("分享快照清理失败:", e.message);
  }
}

function saveShare(data) {
  // 2026-09-18：改为经 writeJSONAtomic 落盘，让存储只读（EROFS）被统一
  // 收敛成 StorageError(503)，而不是抛到 handler 里被误报成「请求体解析失败」。
  // 同时做白名单脱敏：分享链接无鉴权，快照里绝不能残留任何 PII（QA SEC-04）。
  const id = crypto.randomBytes(6).toString("base64url"); // 8 字符
  const safe = sanitizeSharePayload(data, 0) || {};
  const rec = {
    id,
    created_at: new Date().toISOString(),
    train: (safe && safe.train) || "",
    data: safe,
  };
  writeJSONAtomic(path.join(SHARES_DIR, id + ".json"), rec);
  return rec;
}

function loadShare(id) {
  if (!/^[A-Za-z0-9_-]{6,24}$/.test(id || "")) return null;
  const p = path.join(SHARES_DIR, id + ".json");
  if (!fs.existsSync(p)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(p, "utf-8"));
    // 过期校验
    if (Date.now() - new Date(rec.created_at).getTime() > SHARE_TTL_MS) {
      fs.unlinkSync(p);
      return null;
    }
    return rec;
  } catch (_) {
    return null;
  }
}

// ===================== 分享数据脱敏（2026-09-18，QA SEC-04 / LOW-09）=====================
// QA 指出：/api/share GET 无需鉴权，任何人拿到 id 即可读快照；
//           若快照含用户身份信息则构成数据泄露。
// 现状：GET 链路本来就不带 token（设计如此，分享的意义就是给别人看），
//       所以**不能靠加鉴权解决**，正确做法是保证快照里根本不存在 PII。
// 这里做白名单式深拷贝：只保留预测展示必需字段，其余（尤其 email / user /
// token / visitorId 这类）一律丢弃。宁可少存，不可多存。
const SHARE_ALLOW_KEYS = new Set([
  "train", "line", "stations", "station_days", "days_stations",
  "prediction", "on_time_prob", "point_estimate", "generated_at",
  "query_date", "prediction_date", "destination", "source",
  "breakdown", "historical", "realtime", "incidents", "summary",
  "hourly", "daily", "days", "date", "title", "train_key",
  // 常见嵌套容器
  "data", "stats", "history", "segments", "rows",
]);
// 明确禁止的键（即便出现在白名单容器内也剔除）
const SHARE_DENY_KEYS = /^(email|user|username|token|password|passwd|visitorId|visitor_id|ip|authorization|cookie|session|sessions|uid|userId|user_id)$/i;
const SHARE_MAX_DEPTH = 6;
const SHARE_MAX_STR = 500;    // 单个字符串上限（防塞日志/长文本）
function sanitizeSharePayload(v, depth) {
  if (depth > SHARE_MAX_DEPTH) return undefined;
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > SHARE_MAX_STR ? v.slice(0, SHARE_MAX_STR) : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v.slice(0, 500)) {   // 数组上限，防超大载荷
      const s = sanitizeSharePayload(item, depth + 1);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) {
      if (SHARE_DENY_KEYS.test(k)) continue;       // 禁键优先
      if (!SHARE_ALLOW_KEYS.has(k)) continue;      // 白名单
      const s = sanitizeSharePayload(v[k], depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;   // function/symbol 等一律丢弃
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// 颜色判定：与原脚本一致 —— bis>15 红，>5 黄，否则绿
function colorFor(bis) {
  if (bis > 15) return "Red";
  if (bis > 5) return "Yellow";
  return "Green";
}

// 取数适配层：当前读本地模拟数据；将来可改为调用真实 API
function loadDataset() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("无法读取数据集:", e.message);
    return {};
  }
}

function queryDelay(train, limit) {
  const dataset = loadDataset();
  const t = (train || "").trim().toLowerCase();
  // LIKE '%train%' —— 匹配车次键（含部分匹配）
  const matchedKeys = Object.keys(dataset).filter((k) =>
    k.toLowerCase().includes(t)
  );

  const rows = [];
  for (const key of matchedKeys) {
    for (const r of dataset[key]) {
      rows.push({
        train: key,
        station: r.station,
        scheduled: r.scheduled,
        forecast: r.forecast,
        probe: r.probe,
        von: r.von,
        bis: r.bis,
        delay: `${r.von}-${r.bis} min`,
        color: colorFor(r.bis),
      });
    }
  }

  if (typeof limit === "number" && limit > 0 && rows.length > limit) {
    rows.length = limit;
  }
  return { train: train || "", count: rows.length, rows };
}

// ===================== 安全响应头（2026-09-18，QA SEC 项）=====================
// QA 指出：全站没有 CSP / X-Frame-Options / Referrer-Policy。
// 这里在响应层统一注入，保证**所有**出口（静态文件、JSON、图片）都带上，
// 避免逐个 handler 补漏。
//
// CSP 设计取舍：站点用到内联 <script>/<style>（index.html 522 行全 inline），
// 且引用 cdnjs 兜底与 buymeacoffee。若直接上严格 CSP 会白屏，
// 故对 script/style 保留 'unsafe-inline'，但把 frame-ancestors / object-src /
// base-uri 收死 —— 这三项才是防点击劫持与注入的关键，且不影响现有功能。
const SECURITY_HEADERS = {
  // 防点击劫持（QA LOW-10）
  "X-Frame-Options": "DENY",
  // 禁 MIME 嗅探
  "X-Content-Type-Options": "nosniff",
  // 外链不泄露访客来源路径（站点有 buymeacoffee 等外链）
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // 收敛高危能力
  // 注意（2026-09-18 实测补白名单）：以下来源是站点既有功能，漏放行会造成**功能回归**：
  //   - cdnjs.cloudflare.com  : Chart.js / html2canvas / qrcodejs 的 CDN 兜底
  //   - api.qrserver.com      : 分享二维码 img 兜底（'self' 会把它拦掉 → 二维码空白）
  // 链接跳转（buymeacoffee / t.me / wa.me / agentos-app）不受 CSP 约束，无需放行。
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://api.qrserver.com",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",       // 禁 plugin（Flash/PDF 嵌入）
    "base-uri 'self'",         // 防 <base> 注入改写相对路径
    "form-action 'self'",      // 防表单外发
    "frame-ancestors 'none'",  // 与 X-Frame-Options 双保险
  ].join("; "),
  // 明确禁用不需要的浏览器能力
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
};
function applySecurityHeaders(res) {
  try {
    for (const k of Object.keys(SECURITY_HEADERS)) {
      if (!res.getHeader(k)) res.setHeader(k, SECURITY_HEADERS[k]);
    }
  } catch (_) {}
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  applySecurityHeaders(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// 为耗时预测和路径查询输出可关联的单行结构化日志；响应只允许完成一次。
function observeRequest(req, res, endpoint) {
  const requestId = crypto.randomBytes(6).toString("hex");
  const startedAt = process.hrtime.bigint();
  let completed = false;
  res.setHeader("X-Request-Id", requestId);
  return function respond(status, body, details) {
    if (completed) return;
    completed = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log("[api]", JSON.stringify(Object.assign({
      request_id: requestId,
      endpoint,
      method: req.method,
      status,
      duration_ms: Math.round(durationMs),
    }, details || {})));
    sendJSON(res, status, body);
  };
}

function fileVersion(file) {
  try { return String(fs.statSync(file).mtimeMs); }
  catch (_) { return "missing"; }
}

function predictionCacheKey(params) {
  const dataVersion = process.env.PREDICTION_CACHE_VERSION ||
    [fileVersion(INSIGHT_SCRIPT), fileVersion(DATA_FILE)].join(":");
  return JSON.stringify({
    version: dataVersion,
    // 车次归一化：下划线 → 空格。
    // 站对站/车次查询链路上，同一车次会以两种形式出现：'RE 49127'（用户输入
    // 与 /api/train）和 'RE_49127'（前端内部 _bdLazy / 分享快照的下划线格式）。
    // 若不归一，/api/train 写入的 key 与 /api/breakdown 查询的 key 不等，
    // 后者必然 memo_miss → 410 → 原因图表永不渲染（已实测复现）。
    train: params.train.toUpperCase().replace(/_/g, " ").replace(/\s+/g, " ").trim(),
    days: params.days,
    date: params.predictDate,
    destination: params.destination,
    ride_from: params.rideFrom,
    ride_to: params.rideTo,
    ride_time: params.rideTime,
  });
}

function getPredictionCache(key) {
  const entry = predictionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    predictionCache.delete(key);
    return null;
  }
  return entry.data;
}

function setPredictionCache(key, data) {
  if (!PREDICTION_CACHE_TTL_MS) return;
  // 运行中列车：延误动态变化，改用短 TTL，避免旧值滞留（见 RUNNING_CACHE_TTL_MS 注释）
  const ttl = (data && data.running) ? RUNNING_CACHE_TTL_MS : PREDICTION_CACHE_TTL_MS;
  if (!ttl) return;
  if (predictionCache.size >= PREDICTION_CACHE_MAX_ENTRIES) {
    predictionCache.delete(predictionCache.keys().next().value);
  }
  predictionCache.set(key, { data, expiresAt: Date.now() + ttl });
}

function recordPredictionHistory(req, data, params) {
  const pred = data.prediction || {};
  recordHistory(req, {
    type: "train", train: params.train, days: params.days,
    date: params.predictDate, destination: params.destination,
    prediction: {
      point_estimate: pred.point_estimate,
      p10: pred.p10, p90: pred.p90,
      prob_ge15: pred.prob_ge15,
      prediction_date: data.prediction_date || null,
    },
    actual_days: (Array.isArray(data.recent) ? data.recent : []).map(function (r) {
      return { date: r.date, end_delay: r.end_delay != null ? r.end_delay : null };
    }),
  });
}

// Python json.dumps 默认输出 NaN/Infinity（非法 JSON），JS parse 抛错。
// 在解析前把 NaN/±Infinity 替换为 null（保留 JSON 兼容性）。
function safeJsonParse(text) {
  const cleaned = String(text)
    .replace(/-Infinity\b/g, "null")
    .replace(/\bInfinity\b/g, "null")
    .replace(/\bNaN\b/g, "null");
  return JSON.parse(cleaned);
}

// 行程页中转（2026-09-14）：bahnapp 用 CloudFront WAF 按来源 IP 封禁，
// 部署机 IP 被封时整站取不到（见 denied/blocked.html）。可在 Cloudflare Workers
// 上部署一个转发（见 bahnapp-worker/），用 CF 的 IP 去取。
//   ZUGFINDER_RELAY_URL   = https://<你的worker>.workers.dev/
//   ZUGFINDER_RELAY_TOKEN = 与 Worker 的 AUTH_TOKEN 一致
// 未配置时行为与从前完全一致（直连）。
const JOURNEY_RELAY_URL = (process.env.ZUGFINDER_RELAY_URL || "").trim();
const JOURNEY_RELAY_TOKEN = (process.env.ZUGFINDER_RELAY_TOKEN || "").trim();
// 校验通过才置 true；配错时自动回退直连，不让一个笔误把功能整个打死
let JOURNEY_RELAY_ON = false;
if (JOURNEY_RELAY_URL) {
  // 启动时校验，避免配错协议/地址后直到用户点分析才报错
  try {
    const _ru = new URL(JOURNEY_RELAY_URL);
    if (_ru.protocol !== "http:" && _ru.protocol !== "https:") {
      throw new Error("协议必须是 http/https");
    }
    JOURNEY_RELAY_ON = true;
    console.log("[relay] 行程中转已启用: " + _ru.origin + _ru.pathname +
                (JOURNEY_RELAY_TOKEN ? " (已带 token)" : " (无 token，不推荐)"));
  } catch (e) {
    console.error("[relay] ZUGFINDER_RELAY_URL 无效，已忽略并回退直连: " + e.message);
    console.error("[relay] 当前值: " + JOURNEY_RELAY_URL);
  }
}

// ── SOCKS5 直连通道（2026-09-16）─────────────────────────────
// 场景：部署机 IP 被封，中转服务（CF/Deno）的机房 IP 也被封，
//      唯一能出的是住宅/移动 IP。把 tailscale 的 userspace SOCKS5
//      （127.0.0.1:1080 —— 出口指向一台手机）当作通道即可。
//
//   ZUGFINDER_SOCKS5 = socks5h://127.0.0.1:1080
//
// 用 socks5h 让域名在代理解析（本机 DNS 可能被污染）。
// 未配置时行为与从前完全一致。
const JOURNEY_SOCKS5 = (process.env.ZUGFINDER_SOCKS5 || "").trim();
let JOURNEY_SOCKS5_HOST = null, JOURNEY_SOCKS5_PORT = 0;
if (JOURNEY_SOCKS5) {
  try {
    const _su = new URL(JOURNEY_SOCKS5);
    if (!/^socks5h?:$/.test(_su.protocol)) throw new Error("协议必须是 socks5: 或 socks5h:");
    JOURNEY_SOCKS5_HOST = _su.hostname;
    JOURNEY_SOCKS5_PORT = parseInt(_su.port, 10) || 1080;
    console.log("[socks5] 行程抓取走代理: " + JOURNEY_SOCKS5_HOST + ":" + JOURNEY_SOCKS5_PORT);
  } catch (e) {
    console.error("[socks5] ZUGFINDER_SOCKS5 无效，已忽略并回退直连: " + e.message);
  }
}

// 通过 SOCKS5 建立到 host:port 的 TCP 连接，然后交给 https.request 复用。
// 手写 SOCKS5 握手（无认证 + 域名寻址），避免引入第三方依赖。
function socks5Connect(host, port, cb) {
  const net = require("net");
  const sock = net.connect(JOURNEY_SOCKS5_PORT, JOURNEY_SOCKS5_HOST);
  let stage = 0;
  const fail = (msg) => { try { sock.destroy(); } catch (_) {} cb(new Error(msg)); };
  sock.setTimeout(15000, () => fail("SOCKS5 连接超时"));
  sock.on("error", (e) => cb(new Error("SOCKS5 连接失败: " + e.message)));
  sock.on("data", (buf) => {
    if (stage === 0) {
      // 服务端方法选择应答：VER=5, METHOD=0(无需认证)
      if (buf.length < 2 || buf[0] !== 0x05) return fail("SOCKS5 握手响应异常");
      if (buf[1] !== 0x00) return fail("SOCKS5 要求认证（本实现仅支持免认证）");
      stage = 1;
      // 域名寻址，让代理解析 DNS
      const hb = Buffer.from(host, "utf8");
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]);
      sock.write(req);
    } else if (stage === 1) {
      // 连接应答：VER=5, REP=0 成功；跳过 BND.ADDR/BND.PORT
      if (buf.length < 2 || buf[1] !== 0x00) {
        return fail("SOCKS5 代理拒绝连接 (REP=" + (buf[1] || "?") + ")");
      }
      stage = 2;
      sock.setTimeout(0);
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      sock.on("error", () => {});
      cb(null, sock);
    }
  });
  sock.write(Buffer.from([0x05, 0x01, 0x00]));
}

// 通过 SOCKS5 抓取页面（支持重定向，逻辑与直连路径一致）。
function fetchJourneyViaSocks(target, cb, redirects) {
  let parsed;
  try { parsed = new URL(target); } catch (_) { return cb(new Error("无效的行程链接")); }
  if (parsed.protocol !== "https:" || !["bahnapp.link", "bahnapp.online"].includes(parsed.hostname)) {
    return cb(new Error("仅支持 bahnapp.link 行程链接"));
  }
  const https = require("https");
  const tls = require("tls");
  socks5Connect(parsed.hostname, parsed.port || 443, (err, sock) => {
    if (err) return cb(err);
    // SOCKS5 只打通了 TCP；这里必须显式做 TLS 握手，
    // 直接把明文 socket 交给 https.request 会 socket hang up。
    const tlsSock = tls.connect({
      socket: sock,
      servername: parsed.hostname,
      rejectUnauthorized: true,
    }, () => {
      tlsSock.write(
        "GET " + parsed.pathname + parsed.search + " HTTP/1.1\r\n" +
        "Host: " + parsed.hostname + "\r\n" +
        "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1\r\n" +
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n" +
        "Accept-Language: de-DE,de;q=0.9,en;q=0.8\r\n" +
        "Accept-Encoding: identity\r\n" +
        "Connection: close\r\n\r\n"
      );
    });
    // 单次回调守卫：超时/错误/结束/超限 任一发生都不再重复回调。
    // 注意：只包裹 cb，不要复用同一个守卫去包裹 'end' 处理器——
    // 那会让 'end' 先吃掉令牌，导致后续 finish 静默失效（请求永久挂起）。
    let settled = false;
    const finish = (...args) => { if (!settled) { settled = true; return cb(...args); } };
    tlsSock.setTimeout(30000, () => { try { tlsSock.destroy(); } catch (_) {} finish(new Error("行程链接请求超时")); });

    // 全程用 Buffer 累积：HTTP 的 Content-Length / chunk-size 都是**字节**，
    // 若这里 setEncoding("utf8") 转成字符串再 slice，遇到德语变音符（ä/ö/ü/ß，
    // 2 字节但 1 字符）偏移就会漂移，chunk 边界解析出错导致页面被截断。
    let raw = Buffer.alloc(0);
    tlsSock.on("data", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
      raw = Buffer.concat([raw, buf]);
      if (raw.length > JOURNEY_FETCH_MAX_BYTES * 2) {
        try { tlsSock.destroy(); } catch (_) {}
        finish(new Error("行程页面过大"));
      }
    });
    tlsSock.on("error", (e) => finish(new Error("行程抓取失败: " + e.message)));
    tlsSock.on("end", () => {
      // 手动拆 HTTP 响应：状态行 + 头 + 空行 + body
      const sep = raw.indexOf(Buffer.from("\r\n\r\n"));
      if (sep < 0) return finish(new Error("行程响应格式异常"));
      const head = raw.slice(0, sep).toString("utf8");
      let body = raw.slice(sep + 4);
      const statusLine = head.split("\r\n")[0] || "";
      const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      const code = m ? parseInt(m[1], 10) : 0;
      const hdrs = {};
      for (const line of head.split("\r\n").slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      if (code >= 300 && code < 400 && hdrs.location && (redirects || 0) < 4) {
        const next = new URL(hdrs.location, parsed).toString();
        return fetchJourneyViaSocks(next, cb, (redirects || 0) + 1);
      }
      if (code < 200 || code >= 400) return finish(new Error("行程链接返回 HTTP " + code));
      // chunked 传送解码（按字节切片）
      if (String(hdrs["transfer-encoding"] || "").toLowerCase().includes("chunked")) {
        const parts = [];
        let i = 0;
        while (i < body.length) {
          const nl = body.indexOf(Buffer.from("\r\n"), i);
          if (nl < 0) break;
          // chunk-size 后可跟扩展（如 1a;name=value），需截掉
          let sizeLine = body.slice(i, nl).toString("utf8").trim();
          const semi = sizeLine.indexOf(";");
          if (semi >= 0) sizeLine = sizeLine.slice(0, semi).trim();
          const size = parseInt(sizeLine, 16);
          if (isNaN(size)) break;
          if (size === 0) break; // 终止块
          i = nl + 2;
          if (i + size > body.length) { parts.push(body.slice(i)); i = body.length; break; }
          parts.push(body.slice(i, i + size));
          i += size + 2;
        }
        body = Buffer.concat(parts);
      }
      const html = body.toString("utf8");
      if (/Zugriff verweigert|denied\/blocked\.html|Anfrage wurde blockiert/i.test(html)) {
        return finish(new Error("journey_source_blocked"));
      }
      if (process.env.JOURNEY_DEBUG) {
        const _cnt = (re) => (html.match(re) || []).length;
        console.log("[socks5-debug] 目标=" + target + "\n" +
          "[socks5-debug] HTTP=" + code + " 字节=" + Buffer.byteLength(html, "utf8") + "\n" +
          "[socks5-debug] SubTitle=" + _cnt(/SubTitle/g) +
          " RouteStop=" + _cnt(/RouteStop/g) +
          " stopList=" + _cnt(/stopList/g) +
          " denied=" + /Zugriff verweigert|denied\/blocked\.html/i.test(html));
        try { require("fs").writeFileSync("/tmp/soc_dump.html", html); } catch (_) {}
      }
      finish(null, html);
    });
  });
}

// 通过中转抓取。返回 { html } 或抛错。
function fetchJourneyViaRelay(target, cb) {
  let relayBase;
  try { relayBase = new URL(JOURNEY_RELAY_URL); } catch (_) {
    return cb(new Error("中转地址配置无效"));
  }
  const requestUrl = relayBase.toString().replace(/\/?$/, "/") +
    "?url=" + encodeURIComponent(target);
  const headers = { "User-Agent": "TrainDelay/1.0", "Accept-Encoding": "identity" };
  if (JOURNEY_RELAY_TOKEN) headers["X-Relay-Token"] = JOURNEY_RELAY_TOKEN;
  // 按中转地址自带的协议选择 http/https（线上是 https 的 Worker，
  // 但本地联调/内网反代会用 http；写死 https 会抛 ERR_INVALID_PROTOCOL）
  const lib = relayBase.protocol === "http:" ? require("http") : require("https");
  const req = lib.get(requestUrl, { headers, timeout: 20000 }, (r) => {
    if (r.statusCode === 401) { r.resume(); return cb(new Error("中转鉴权失败（token 不匹配）")); }
    if (r.statusCode < 200 || r.statusCode >= 400) {
      r.resume(); return cb(new Error("中转返回 HTTP " + r.statusCode));
    }
    // Worker 会带这个头标明「CF 也取到了拒绝页」——说明 bahnapp 连 CF 的 IP 也封了，
    // 与「链接本身失效」区分开，前端文案不同。
    if (r.headers["x-relay-blocked"] === "1") {
      r.resume(); return cb(new Error("journey_source_blocked"));
    }
    let body = "";
    const stream = String(r.headers["content-encoding"] || "").includes("gzip") ? r.pipe(zlib.createGunzip()) : r;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > JOURNEY_FETCH_MAX_BYTES) req.destroy(new Error("行程页面过大"));
    });
    stream.on("end", () => cb(null, body));
  });
  req.on("timeout", () => req.destroy(new Error("中转请求超时")));
  req.on("error", (e) => cb(new Error("中转请求失败: " + e.message)));
}

// Fetch a public BahnApp share page. The page is treated as untrusted text;
// only the allow-listed host is accepted and the response is size-limited.
function fetchJourneyPage(target, cb, redirects) {
  let parsed;
  try { parsed = new URL(target); } catch (_) { return cb(new Error("无效的行程链接")); }
  if (parsed.protocol !== "https:" || !["bahnapp.link", "bahnapp.online", "int.bahn.de"].includes(parsed.hostname)) {
    return cb(new Error("仅支持 bahnapp.link 行程链接"));
  }
  // 优先级：SOCKS5 通道（住宅 IP，最不容易被 WAF 认出来）
  //       > 中转服务（机房 IP，容易被封）
  //       > 直连（部署机 IP 被 WAF 封时基本拿不到）
  if (JOURNEY_SOCKS5_HOST) {
    return fetchJourneyViaSocks(parsed.toString(), cb, 0);
  }
  if (JOURNEY_RELAY_ON) {
    return fetchJourneyViaRelay(parsed.toString(), cb);
  }
  const https = require("https");
  const req = https.get(parsed, { headers: { "User-Agent": "TrainDelay/1.0", "Accept-Encoding": "identity" }, timeout: 15000 }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (redirects || 0) < 3) {
      r.resume();
      const next = new URL(r.headers.location, parsed).toString();
      return fetchJourneyPage(next, cb, (redirects || 0) + 1);
    }
    if (r.statusCode < 200 || r.statusCode >= 400) {
      r.resume(); return cb(new Error("行程链接返回 HTTP " + r.statusCode));
    }
    let body = "";
    const stream = String(r.headers["content-encoding"] || "").includes("gzip") ? r.pipe(zlib.createGunzip()) : r;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > JOURNEY_FETCH_MAX_BYTES) req.destroy(new Error("行程页面过大"));
    });
    stream.on("end", () => cb(null, body));
  });
  req.on("timeout", () => req.destroy(new Error("行程链接请求超时")));
  req.on("error", cb);
}

function journeyPageText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// DB Fahrplan links store the selected route in their hash. URL fragments are
// not sent to DB, so extract each §T record locally before any HTTP request.
function parseDbFahrplanJourney(target) {
  let parsed;
  try { parsed = new URL(target); } catch (_) { return null; }
  if (!/(^|\.)int\.bahn\.de$/i.test(parsed.hostname) || !parsed.hash) return null;
  const rawGh = new URLSearchParams(parsed.hash.slice(1)).get("gh");
  if (!rawGh) return null;
  return parseDbReconJourney(rawGh, "", extractDbKccServices(rawGh));
}

// The §KCC¶ segment of the DB fahrplan hash is a base64 table mapping internal
// train numbers to vehicle categories (DRB→RE, NRE→RE, ICE, ...). Without it
// regional trains appear as bare operating numbers.
function extractDbKccServices(hash) {
  let source = String(hash || "");
  try { source = decodeURIComponent(source); } catch (_) { /* keep raw */ }
  const marker = source.match(/[¶§]KCC[¶§]([^&]+)/);
  if (!marker) return {};
  try {
    const decoded = Buffer.from(decodeURIComponent(marker[1]), "base64").toString("utf8");
    const out = {};
    for (const record of decoded.split("#VN#").slice(1)) {
      const number = record.match(/#ZE#(\d+)/);
      const category = record.match(/#CA#([^#]+)/);
      if (number && category) out[number[1]] = category[1].toUpperCase();
    }
    return out;
  } catch (_) { return {}; }
}

function parseDbReconJourney(rawGh, dateHint, serviceMap) {
  if (!rawGh) return null;
  const legs = [];
  for (const record of rawGh.split(/[§¶]T/).slice(1)) {
    const stations = Array.from(record.matchAll(/(?:^|\$)A=1@O=([^@]+)@/g)).map((m) => m[1].trim());
    const times = record.match(/\$(\d{12})\$(\d{12})\$/);
    // The train number is the only numeric field directly followed by "$$".
    const train = record.match(/(\d+)\$\$/);
    if (stations.length < 2 || !times || !train) continue;
    const time = (value) => value.slice(8, 10) + ":" + value.slice(10, 12);
    const category = (serviceMap && serviceMap[train[1]]) || "";
    const prefix = { DRB: "RE", NRE: "RE", RE: "RE", RB: "RB", IC: "IC", ICE: "ICE", S: "S", BUS: "Bus" }[category] || category;
    legs.push({ service: prefix ? prefix + " " + train[1] : train[1], from: stations[0], dep: time(times[1]), to: stations[1], arr: time(times[2]) });
  }
  if (!legs.length) return null;
  const firstTime = rawGh.match(/\$(\d{12})\$/);
  return {
    source: "int.bahn.de",
    date: dateHint || (firstTime ? firstTime[1].slice(0, 4) + "-" + firstTime[1].slice(4, 6) + "-" + firstTime[1].slice(6, 8) : ""),
    legs,
  };
}

function parseJourneyText(text) {
  const source = String(text || "").replace(/\r/g, "").replace(/\u00a0/g, " ");
  const titleRe = /(?:^|\n)\s*((?:ICE|IC|EC|RE|RB|IR|S|U|TGV|NJ|FlixTrain)\s*\d+(?:\s*\([^\n)]*\))?)\s*(?=\n|$)/gim;
  const titles = Array.from(source.matchAll(titleRe));
  const station = (value) => value.replace(/,?\s*Platform\s*\S+\s*$/i, "").trim();
  const legs = [];
  for (let i = 0; i < titles.length; i++) {
    const start = titles[i].index + titles[i][0].lastIndexOf(titles[i][1]);
    const block = source.slice(start, titles[i + 1] ? titles[i + 1].index : source.length);
    // 两种格式都收（2026-09-14）：输入框提示语示范的是「单行 From … To …」，
    // 但旧正则要求 From/To 分行，用户照着提示写反而解析为空 —— 提示与实现互相打架。
    // 现在先按分行匹配（BahnApp 原始排版），不成再按单行匹配。
    let match = block.match(/From\s+(\d{1,2}:\d{2})\s+([^\n]+?)\s*\n\s*To\s+(\d{1,2}:\d{2})\s+([^\n]+)/i);
    if (!match) {
      // 单行：From 06:12 Köln Hbf To 07:50 Dortmund Hbf
      // 站名用「To + 时间」作右边界，避免把中间的 To 吃进站名。
      match = block.match(/From\s+(\d{1,2}:\d{2})\s+(.+?)\s+To\s+(\d{1,2}:\d{2})\s+(.+?)\s*$/im);
    }
    if (match) legs.push({ service: titles[i][1].replace(/\s+/g, " ").trim(), from: station(match[2]), dep: match[1], to: station(match[4]), arr: match[3] });
  }
  return legs;
}

function fetchDbVbid(vbid, cb) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(vbid || "")) {
    return cb(new Error("无效的 DB 行程分享链接"));
  }
  const https = require("https");
  const req = https.get("https://int.bahn.de/web/api/angebote/verbindung/" + vbid, {
    headers: { "User-Agent": "TrainDelay/1.0", Accept: "application/json", "Accept-Encoding": "gzip" }, timeout: 15000,
  }, (r) => {
    if (r.statusCode < 200 || r.statusCode >= 400) {
      r.resume(); return cb(new Error(r.statusCode === 403 ? "journey_db_link_open_required" : "DB 行程接口返回 HTTP " + r.statusCode));
    }
    let body = "";
    const stream = String(r.headers["content-encoding"] || "").includes("gzip") ? r.pipe(zlib.createGunzip()) : r;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > JOURNEY_FETCH_MAX_BYTES) req.destroy(new Error("DB 行程响应过大"));
    });
    stream.on("end", () => {
      try {
        const data = JSON.parse(body);
        const journey = parseDbReconJourney(data.hinfahrtRecon, data.hinfahrtDatum ? String(data.hinfahrtDatum).slice(0, 10) : "", extractDbKccServices(data.hinfahrtRecon));
        if (!journey) return cb(new Error("DB 行程数据无法解析"));
        cb(null, journey);
      } catch (_) { cb(new Error("DB 行程响应不是有效 JSON")); }
    });
  });
  req.on("timeout", () => req.destroy(new Error("DB 行程接口请求超时")));
  req.on("error", cb);
}

function parseBahnAppJourney(html) {
  const legs = [];
  const source = String(html || "");
  const simple = /<div class="SubTitle"><a[^>]*[?&]name=([^&"]+)[^>]*>[\s\S]*?<\/div>[\s\S]*?<refresh-container[^>]+data-id="stopList\d+"[\s\S]*?<\/refresh-container>/gi;
  let simpleMatch;
  while ((simpleMatch = simple.exec(source))) {
    const service = decodeURIComponent(simpleMatch[1].replace(/\+/g, " "));
    const stops = [];
    const stopBlocks = simpleMatch[0].split('<div class="RouteStop"').slice(1);
    for (const stop of stopBlocks) {
      const station = stop.match(/[?&]name=([^&"]+)/i);
      const dep = stop.match(/class="DepartureTime[^>]*>([^<]*)</i);
      const arr = stop.match(/class="ArrivalTime[^>]*>([^<]*)</i);
      if (station) stops.push({ station: decodeURIComponent(station[1].replace(/\+/g, " ")), dep: dep ? dep[1].trim() : "", arr: arr ? arr[1].trim() : "" });
    }
    if (stops.length >= 2) legs.push({ service, from: stops[0].station, dep: stops[0].dep || stops[0].arr, to: stops[stops.length - 1].station, arr: stops[stops.length - 1].arr || stops[stops.length - 1].dep });
  }
  if (legs.length) return legs;
  const headRe = /<div class="SegmentDetails"[\s\S]*?<\/refresh-container>/gi;
  const heads = source.match(headRe) || [];
  const lists = source.match(/<refresh-container[^>]+data-id="stopList\d+"[\s\S]*?<\/refresh-container>/gi) || [];
  for (let i = 0; i < Math.min(heads.length, lists.length); i++) {
    const nameMatch = heads[i].match(/[?&]name=([^&"]+)/i);
    const service = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g, " ")) : "";
    const stops = [];
    const stationNames = Array.from(lists[i].matchAll(/[?&]name=([^&"]+)/gi)).map((x) => decodeURIComponent(x[1].replace(/\+/g, " "))).filter((x, n, a) => n === 0 || x !== a[n - 1]);
    const arrivals = Array.from(lists[i].matchAll(/class="ArrivalTime[^>]*>([^<]*)</gi)).map((x) => x[1].trim());
    const departures = Array.from(lists[i].matchAll(/class="DepartureTime[^>]*>([^<]*)</gi)).map((x) => x[1].trim());
    for (let si = 0; si < stationNames.length; si++) stops.push({ station: stationNames[si], arr: arrivals[si] || "", dep: departures[si] || "" });
    /* Keep the block parser below for pages with interleaved markup. */
    const stopBlocks = lists[i].split('<div class="RouteStop"').slice(1).map((part) => part.split('</div></refresh-container>')[0]);
    for (const stop of stopBlocks) {
      const arrMatch = stop.match(/class="ArrivalTime[^>]*>([^<]*)</i);
      const depMatch = stop.match(/class="DepartureTime[^>]*>([^<]*)</i);
      const stationMatch = stop.match(/[?&]name=([^&"]+)/i);
      if (!stationNames.length && stationMatch) stops.push({ arr: arrMatch ? arrMatch[1].trim() : "", dep: depMatch ? depMatch[1].trim() : "", station: decodeURIComponent(stationMatch[1].replace(/\+/g, " ")) });
    }
    if (service && stops.length >= 2) legs.push({ service, from: stops[0].station, dep: stops[0].dep || stops[0].arr, to: stops[stops.length - 1].station, arr: stops[stops.length - 1].arr || stops[stops.length - 1].dep });
  }
  if (legs.length) return legs;
  const starts = [];
  /* Legacy fallback for alternate BahnApp markup. */
  const legacyHeadRe = /<div class="SegmentDetails"/gi;
  let hm;
  while ((hm = legacyHeadRe.exec(source))) starts.push(hm.index);
  const blocks = starts.map((start, i) => source.slice(start, starts[i + 1] || source.length));
  for (const block of blocks) {
    const nameMatch = block.match(/\/journey\/[^>]+[?&]name=([^&"]+)/i);
    const service = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g, " ")) : "";
    const stops = [];
    const stopBlocks = block.match(/<div class="RouteStop"[\s\S]*?(?=<div class="RouteStop"|$)/gi) || [];
    for (const stop of stopBlocks) {
      const arrMatch = stop.match(/class="ArrivalTime[^>]*>([^<]*)</i);
      const depMatch = stop.match(/class="DepartureTime[^>]*>([^<]*)</i);
      const stationMatch = stop.match(/[?&]name=([^&"]+)/i);
      if (stationMatch) stops.push({ arr: arrMatch ? arrMatch[1].trim() : "", dep: depMatch ? depMatch[1].trim() : "", station: decodeURIComponent(stationMatch[1].replace(/\+/g, " ")) });
    }
    if (service && stops.length >= 2) {
      legs.push({ service, from: stops[0].station, dep: stops[0].dep || stops[0].arr, to: stops[stops.length - 1].station, arr: stops[stops.length - 1].arr || stops[stops.length - 1].dep });
    }
  }
  return legs;
}

// ---------- 影响分析数据（CSV → JSON，零依赖） ----------
function parseCSVLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const header = parseCSVLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = (cols[idx] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function loadImpactData() {
  const causes = parseCSV(IMPACT_SRC.causes);
  const subs = parseCSV(IMPACT_SRC.sub);
  const weather = parseCSV(IMPACT_SRC.weather);
  const incidents = parseCSV(IMPACT_SRC.incidents);
  const total = Number((causes[0] || {}).total_remarks) || 0;
  const causeRows = causes.map((c) => ({
    rank: Number(c.rank), category: c.cause_category,
    cn: c.cause_category_cn, count: Number(c.remark_count) || 0,
    percent: Number(c.percent) || 0,
  }));
  const bau = causeRows.find((c) => c.category === "bau") || null;
  const wetter = causeRows.find((c) => c.category === "wetter") || null;
  const bauSubs = subs.filter((s) => s.cause_category === "bau").map((s) => ({
    subcategory: s.subcategory, cn: s.subcategory_cn,
    count: Number(s.remark_count) || 0,
    pct_cat: Number(s.percent_of_category) || 0,
  })).sort((a, b) => b.count - a.count);
  // 天气区域汇总
  const regionAgg = {};
  let riskDays = 0, maxDelay = 0;
  for (const w of weather) {
    const d = Number(w.weather_delay_min) || 0;
    const reg = w.region || "?";
    if (d > 0) riskDays++;
    if (d > maxDelay) maxDelay = d;
    const r = regionAgg[reg] || { sum: 0, max: 0, days: 0, count: 0 };
    r.sum += d; r.count++;
    if (d > r.max) r.max = d;
    if (d > 0) r.days++;
    regionAgg[reg] = r;
  }
  const byRegion = Object.keys(regionAgg).map((region) => ({
    region,
    avg: +(regionAgg[region].sum / regionAgg[region].count).toFixed(2),
    sum: +regionAgg[region].sum.toFixed(2),
    max: regionAgg[region].max,
    delay_days: regionAgg[region].days,
  }));
  const inc = incidents.map((x) => ({
    region: x.region, start_date: x.start_date, end_date: x.end_date,
    incident_type: x.incident_type, cause: x.cause, severity: x.severity,
    delay_min: Number(x.delay_min) || null,
  }));
  return {
    generated_at: new Date().toISOString(),
    total_remarks: total,
    causes: causeRows,
    bau: bau ? { count: bau.count, percent: bau.percent, subcategories: bauSubs } : null,
    weather: wetter ? { count: wetter.count, percent: wetter.percent, risk_days: riskDays, max_delay_min: maxDelay, by_region: byRegion } : null,
    incidents: inc,
  };
}

// ---- 区间预测（segment）：用 station_days 中历史各日的目的站延迟分位 ----
function segmentStationKey(name) {
  // station_days 的 key 是原始站名（与 today_stations.bhf 一致）
  return String(name || "").trim();
}
function medianSorted(arr) {
  const n = arr.length;
  return n ? (n % 2 ? arr[(n - 1) >> 1] : (arr[n / 2 - 1] + arr[n / 2]) / 2) : 0;
}
function quantileSorted(arr, q) {
  if (!arr.length) return 0;
  const pos = (arr.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}
function computeSegment(trainData, fromName, toName) {
  if (!fromName || !toName) return null;
  const fromKey = segmentStationKey(fromName);
  const toKey = segmentStationKey(toName);
  const stations = Array.isArray(trainData && trainData.stations) ? trainData.stations : [];
  const norm = (s) => segmentStationKey(s);
  if (!stations.some((s) => norm(s) === fromKey)) {
    return { from: fromName, to: toName, error: "from_not_in_route" };
  }
  if (!stations.some((s) => norm(s) === toKey)) {
    return { from: fromName, to: toName, error: "to_not_in_route" };
  }
  const days = Array.isArray(trainData && trainData.station_days) ? trainData.station_days : [];
  const samples = [];
  const byDay = [];
  let canceled = 0;
  for (const d of days) {
    const delays = (d && d.delays) || {};
    const v = delays[toKey];
    if (v == null) continue;
    if (v < 0) { canceled++; continue; } // -1 = 整班取消
    samples.push(Number(v));
    byDay.push({ date: d.date, delay: Number(v) }); // 按日期序（未排序），供区间柱状图
  }
  if (!samples.length && !canceled) {
    return { from: fromName, to: toName, error: "no_segment_data" };
  }
  samples.sort((a, b) => a - b);
  const point = +medianSorted(samples).toFixed(2);
  const p10 = +quantileSorted(samples, 0.1).toFixed(2);
  const p90 = +quantileSorted(samples, 0.9).toFixed(2);
  const prob_ge15 = samples.length ? samples.filter((x) => x >= 15).length / samples.length : 0;
  return {
    from: fromName,
    to: toName,
    n_days: samples.length,
    canceled_days: canceled,
    samples: samples,
    by_day: byDay,
    point_estimate: point,
    p10: p10,
    p90: p90,
    prob_ge15: +prob_ge15.toFixed(4),
  };
}

// ---- 预测成分拆解（breakdown）：历史基线分配 + 当日区域天气/施工叠加 ----
let _BD_CACHE = null;
function loadBreakdownCache() {
  if (_BD_CACHE) return _BD_CACHE;
  try {
    // 1) 历史主因占比
    const causes = parseCSV(IMPACT_SRC.causes).map((c) => ({
      category: c.cause_category,
      cn: c.cause_category_cn,
      share_pct: Number(c.percent) || 0,
      count: Number(c.remark_count) || 0,
    }));
    // 2) 官方事件
    const incidents = parseCSV(IMPACT_SRC.incidents).map((x) => ({
      region: x.region,
      start_date: x.start_date,
      end_date: x.end_date,
      cause: x.cause,
      severity: x.severity,
      delay_min: Number(x.delay_min) || 0,
    }));
    // 3) 天气特征按 (region, date) 索引（同时记录覆盖范围）
    const weatherArr = parseCSV(IMPACT_SRC.weather);
    const weatherIdx = {};
    let weatherMinDate = null, weatherMaxDate = null;
    for (const w of weatherArr) {
      if (w.region && w.date) {
        weatherIdx[w.region + "|" + w.date] = Number(w.weather_delay_min) || 0;
        if (!weatherMinDate || w.date < weatherMinDate) weatherMinDate = w.date;
        if (!weatherMaxDate || w.date > weatherMaxDate) weatherMaxDate = w.date;
      }
    }
    // 4) 原因画像（raw_data 直算，含实测延误/取消率；可选，缺失不致命）
    const reasonProfile = readJSON(IMPACT_SRC.reasonProfile, null);
    // 5) zugfinder 730 天原因统计（德文正文）
    const zfReasons = readJSON(IMPACT_SRC.zfReasons, null);
    // 6) 分车型原因倍率（全量归档计算；缺失时回退全局权重，不致命）
    const zfByType = readJSON(IMPACT_SRC.zfByType, null);
    _BD_CACHE = { causes, incidents, weatherIdx, weatherMinDate, weatherMaxDate,
                  stationToRegion: {}, reasonProfile, zfReasons, zfByType };
    return _BD_CACHE;
  } catch (e) {
    // 影响分析数据缺失/损坏 → 降级为空缓存，避免 /api/train 整体 500
    console.error("[breakdown] 影响分析数据缺失，降级为空缓存:", e.message);
    _BD_CACHE = { causes: [], incidents: [], weatherIdx: {}, weatherMinDate: null, weatherMaxDate: null, stationToRegion: {}, reasonProfile: null, zfReasons: null, zfByType: null };
    return _BD_CACHE;
  }
}

// station_anchor_map 是 parquet 二进制，无法用 parseCSV；spawn python 一次性导出 (name → region) JSON
let _stationToRegionCache = null;
function getStationToRegion() {
  if (_stationToRegionCache) return _stationToRegionCache;
  const cache = loadBreakdownCache();
  if (cache.stationToRegion && Object.keys(cache.stationToRegion).length) {
    _stationToRegionCache = cache.stationToRegion;
    return _stationToRegionCache;
  }
  const stationMapPath = JSON.stringify(IMPACT_SRC.stationMap);
  const script = [
    "import pandas as pd, json, sys",
    `m = pd.read_parquet(${stationMapPath})`,
    // 站名变体：压缩多空白 + 连字符↔空格 + 去括号。
    // 数据源写法与 parquet 常不一致（如 'Oberhausen  Sterkrade' 双空格 vs
    // 'Oberhausen-Sterkrade' 连字符；'Sinzig(Rhein)' vs 'Sinzig (Rhein)'），
    // 缺少变体会导致 region 查不到 → 天气信号缺失。
    // 带括号名额外生成"去括号、保留内容"键：'Neustadt (Dosse)' → 'neustadt dosse'，
    // 保证与 'Neustadt(Dosse)'（无空格写法）互配，且不会与 'Neustadt (Weinstraße)'
    // 等同名异站混淆。截断键（'neustadt'）仅供裸名查询使用。
    "def norm_keys(s):",
    "    base = ' '.join(str(s).strip().lower().split())",
    "    outs = set()",
    "    for v in (base, base.replace('-', ' '), base.replace(' ', '-')):",
    "        v = ' '.join(v.split())",
    "        if v:",
    "            outs.add(v)",
    "        if '(' in v:",
    "            bl = ' '.join(v.replace('(', ' ').replace(')', ' ').split())",
    "            if bl:",
    "                outs.add(bl)",
    "            b = v.split('(')[0].strip()",
    "            if b:",
    "                outs.add(b)",
    "    return outs",
    "out = {}",
    "for _, r in m.iterrows():",
    "    region = str(r.get('region') or '').strip()",
    "    if not region or region == 'miss':",
    "        continue",
    "    name = str(r['station_name']).strip().lower()",
    "    if name:",
    "        out[name] = region",
    "    for k in norm_keys(r['station_name']):",
    "        out.setdefault(k, region)",
    "sys.stdout.write(json.dumps(out, ensure_ascii=False))",
  ].join("\n");
  try {
    const py = process.env.PYTHON_BIN ||
      (process.platform === "win32"
        ? "C:/Users/hh/.workbuddy/binaries/python/envs/lgb/Scripts/python.exe"
        : "python3");
    const out = require("child_process").execFileSync(py, ["-c", script], {
      timeout: 20000,
      encoding: "utf-8",
    });
    const map = JSON.parse(out);
    cache.stationToRegion = map;
    _stationToRegionCache = map;
    console.log("station_to_region 加载: " + Object.keys(map).length + " 站");
    return map;
  } catch (e) {
    console.error("station_to_region export failed:", String(e.message || e).slice(0, 200));
    return cache.stationToRegion || {};
  }
}

// 站名查表键变体（与 getStationToRegion 建表时的 norm_keys 保持一致）：
// 原样 / 压缩多空白 / 连字符↔空格；
// 带括号的查询名额外生成"去括号、保留内容"键（'Neustadt(Dosse)' → 'neustadt dosse'），
// 但**不生成丢括号内容的截断键**——否则 'Neustadt(Dosse)' 会误命中
// 'Neustadt (Weinstraße)' 的截断键（跨站误配 → 天气区域错误）。
// 截断键只存在于建表侧，供不带括号的裸名（'Sinzig'）查询。
function stationKeys(name) {
  const base = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  const out = new Set();
  if (!base) return out;
  out.add(base);
  const hyph = base.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  if (hyph) out.add(hyph);
  const joined = base.replace(/ /g, "-").replace(/-+/g, "-").trim();
  if (joined) out.add(joined);
  if (base.indexOf("(") >= 0) {
    const bl = base.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    if (bl) out.add(bl);
  }
  return out;
}
function lookupStationRegion(map, name) {
  for (const k of stationKeys(name)) {
    const r = map[k];
    if (r) return r;
  }
  return "";
}

// ---- 按线路原因画像 / 延误特征（方案 C：用 parquet 真实统计 + 地理推断，替代全线统一的全局占比）----
let _LINE_BD_CACHE = null;   // { "RE8": {profile:{...}, based_on}, ... }
let _LINE_STATS_CACHE = null; // { "RE8": {n_rides, avg_delay, ...}, ... }
function loadLineBreakdowns() {
  if (_LINE_BD_CACHE) return _LINE_BD_CACHE;
  try {
    _LINE_BD_CACHE = JSON.parse(fs.readFileSync(
      path.join(IMPACT_DATA_DIR, "line_breakdowns.json"), "utf-8"));
  } catch (e) {
    console.error("[line-breakdown] 线路原因画像缺失，降级为空:", e.message);
    _LINE_BD_CACHE = {};
  }
  return _LINE_BD_CACHE;
}
function loadLineStats() {
  if (_LINE_STATS_CACHE) return _LINE_STATS_CACHE;
  try {
    _LINE_STATS_CACHE = JSON.parse(fs.readFileSync(
      path.join(IMPACT_DATA_DIR, "line_delay_stats.json"), "utf-8"));
  } catch (e) {
    console.error("[line-stats] 线路延误统计缺失，降级为空:", e.message);
    _LINE_STATS_CACHE = {};
  }
  return _LINE_STATS_CACHE;
}
// 从 train 参数（"RE 8" / "RE 62037"）析出线路键（"RE8"），与 parquet line_number 对齐
function lineKeyOf(train) {
  if (!train) return "";
  const m = String(train).trim().match(/^([A-Za-z]+)\s*(\d+)/);
  if (!m) return "";
  return (m[1] + m[2]).toUpperCase(); // RE 8 → RE8, RE 62037 → RE8
}

function computeBreakdown(trainData, destinationHint, lineKey, trainRef) {
  const cache = loadBreakdownCache();
  const stationToRegion = getStationToRegion();
  const point = (trainData && trainData.prediction && trainData.prediction.point_estimate) || 0;
  const date = ((trainData && trainData.prediction_date) || "").slice(0, 10);
  // 1) 历史基线分配：优先用「按线路原因画像」，没有才 fallback 到全网全局占比
  const lineBd = lineKey && loadLineBreakdowns()[lineKey];
  const lineProfile = lineBd && lineBd.profile;
  let historical;
  if (lineProfile) {
    historical = Object.keys(lineProfile).map((cat) => ({
      category: cat,
      cn: "", // 前端用 BREAKDOWN_LABELS 翻译，无需后端 cn
      share_pct: +lineProfile[cat].toFixed(2),
      minutes: +(point * lineProfile[cat] / 100).toFixed(2),
      count: 0,
    })).sort((a, b) => b.share_pct - a.share_pct);
  } else {
    historical = cache.causes.map((c) => ({
      category: c.category,
      cn: c.cn,
      share_pct: c.share_pct,
      minutes: +(point * c.share_pct / 100).toFixed(2),
      count: c.count,
    }));
  }
  // 1b) 附上该线路真实延误特征（方案 C·B 部分，来自 parquet 实测）
  const lineStats = lineKey && loadLineStats()[lineKey];
  // 2) 目标站 → 区域（用户传入 > 模型数据 stations 最后站）
  let dest = String(destinationHint || "").trim();
  if (!dest && Array.isArray(trainData && trainData.stations)) {
    dest = trainData.stations[trainData.stations.length - 1] || "";
  }
  let region = lookupStationRegion(stationToRegion, dest);
  // 终点站查不到天气锚点（小站不在锚点表 / 写法差异）时，沿线路自后向前
  // 找最近一个有锚点的站兜底——同一条线路终点附近必然同天气区。
  if (!region && Array.isArray(trainData && trainData.stations)) {
    const st = trainData.stations;
    for (let k = st.length - 1; k >= 0; k--) {
      region = lookupStationRegion(stationToRegion, st[k]);
      if (region) break;
    }
  }
  // 3) 当日天气延误（按区域 + 日期覆盖检查：null=数据缺失，0=有数据但无延误）
  let weatherMin = null, weatherNoData = false;
  if (date && region) {
    if (date < cache.weatherMinDate || date > cache.weatherMaxDate) {
      weatherNoData = true;
    } else {
      weatherMin = cache.weatherIdx[region + "|" + date];
      if (weatherMin == null) weatherNoData = true;
    }
  } else if (!region) {
    weatherNoData = true;
  }
  // 4) 当日施工/天气事件（区域匹配 + 日期区间包含预测日）
  const todayIncidents = (date && region ? cache.incidents.filter((x) =>
    x.region === region && date >= x.start_date && date <= x.end_date
  ) : []);
  // 5) 原因编码实测画像（raw_data 直算：每个 DB 延误编码的实测延误/取消率）
  const rp = cache.reasonProfile;
  const topCodes = (rp && Array.isArray(rp.codes))
    ? rp.codes.slice(0, 8).map((c) => ({
        code: c.code, cat: c.cat, n: c.n,
        avg_delay: c.avg_delay != null ? c.avg_delay : null,
        cancel_pct: c.cancel_pct != null ? c.cancel_pct : null,
      }))
    : null;
  // 6) zugfinder 原因正文（可读；含每类的实测延误强度）
  const zf = cache.zfReasons;
  // 严重度加权：单纯记录占比会低估「线路障碍」（3% 记录但 36min 均值），
  // 这里同时给出「延误分钟贡献占比」—— n * avg_delay 的归一化份额，
  // 更能反映各类原因对总延误的实际影响。
  //
  // 车型感知：车次以 <TYPE>_<NUM> 形式传入（如 RE_49127）。
  // 车型间差异极大（remark 率 IC 0.72% vs ICE 36.36%；有/无 remark 延误差
  // ICE 2.00x vs IC 8.26x），故优先使用该车型的实测倍率，
  // 无车型或无该车型数据时回退全局权重。
  let zfCats = null;
  let zfTypeCtx = null;   // 车型上下文（阵列外的独立对象，避免被 JSON 丢弃）
  if (zf && Array.isArray(zf.categories)) {
    const sev = zf.severity || {};
    // 兼容 'RE 49127'（空格，归一化后）与 'RE_49127'（下划线，旧调用方）
    const typeMatch = /^([A-Z]{1,5})[_\s]/.exec(String(trainRef || "").toUpperCase());
    const trainType = typeMatch ? typeMatch[1] : null;
    const typeEntry = (trainType && cache.zfByType
                       && cache.zfByType.types
                       && cache.zfByType.types[trainType]) || null;
    const typeCats = (typeEntry && typeEntry.categories) || null;
    const enriched = zf.categories.map((c) => {
      const n = c.n || 0;
      const avg = c.avg_delay != null ? c.avg_delay : 0;
      const tc = typeCats ? typeCats[c.key] : null;
      return {
        key: c.key, cn: c.cn, n, pct: c.pct,
        avg_delay: c.avg_delay != null ? c.avg_delay : null,
        max_delay: c.max_delay != null ? c.max_delay : null,
        severity: sev[c.key] != null ? sev[c.key] : 2,
        delay_min_total: Math.round(n * avg),  // 该类贡献的总延误分钟
        // 该车型下的记录/延误份额（无车型数据时为 null）
        type_rec_pct: tc ? tc.rec_pct : null,
        type_delay_pct: tc ? tc.delay_pct : null,
        type_impact_ratio: tc ? tc.impact_ratio : null,
      };
    });
    const sumTotal = enriched.reduce((s, c) => s + c.delay_min_total, 0) || 1;
    enriched.forEach((c) => {
      c.delay_share_pct = +(100 * c.delay_min_total / sumTotal).toFixed(2);
      // 影响倍率 = 延误份额 / 记录份额（>1 表示「少而重」）
      // 优先用车型级倍率（更准），缺省回退全局比值
      c.impact_ratio = c.type_impact_ratio != null
        ? c.type_impact_ratio
        : (c.pct > 0 ? +(c.delay_share_pct / c.pct).toFixed(2) : null);
    });
    zfCats = enriched.slice(0, 10);
    // 车型上下文单独保存（挂在数组上会被 JSON.stringify 丢弃）
    zfTypeCtx = trainType ? {
      train_type: trainType,
      type_source: typeCats ? "by_type" : "global",
      type_base: (typeEntry && typeEntry.base) ? {
        remark_rate_pct: typeEntry.base.remark_rate_pct,
        remark_signal_ratio: typeEntry.base.remark_signal_ratio,
        days: typeEntry.base.days,
      } : null,
    } : null;
  }
  // 7) 逐车次原因实测（三级降级：本车次实测 → 线路画像 → 全网基线）
  //    数据源：parquet delay_codes（逐站 DB 编码）+ msg_cats（逐站消息分类）
  const tb = loadTrainBreakdowns();
  const tbTrain = trainRef ? findTrainBreakdown(trainRef) : null;
  const MIN_CODED = 8;  // 少于该编码站次视为样本不足，降级线路画像
  let trainCats = null, trainSrc = null, trainSample = null;
  if (tbTrain && tbTrain.stops_with_code >= MIN_CODED) {
    trainCats = tbTrain.cats;
    trainSrc = "train";                        // 一级：本车次实测
    trainSample = {
      days: tbTrain.days, stops: tbTrain.stops,
      coded: tbTrain.stops_with_code, with_msg: tbTrain.stops_with_msg,
      avg_delay: tbTrain.avg_delay, cancel_pct: tbTrain.cancel_pct,
      max_delay: tbTrain.max_delay,
      window: (tb && tb.window) || null,
    };
  } else if (lineProfile) {
    trainCats = {};                            // 二级：线路画像（去掉 ausfall 等派生键）
    Object.keys(lineProfile).forEach((k) => {
      if (CAT_KEYS.has(k)) trainCats[k] = lineProfile[k];
    });
    trainSrc = "line";
    trainSample = { based_on: (lineBd && lineBd.based_on) || null,
                    line_key: lineKey || null };
  } else if (tb && tb.baseline) {
    trainCats = tb.baseline;                   // 三级：全网基线
    trainSrc = "global";
    trainSample = { window: (tb && tb.window) || null,
                    n_stops: (tb && tb.total_coded_stops) || null };
  }
  // 组装成分数组（占比 + 折算分钟），按占比降序
  let trainComposition = null;
  if (trainCats && Object.keys(trainCats).length) {
    const avgForMin = (trainSrc === "train" && tbTrain)
      ? (tbTrain.avg_delay || 0)
      : (point || 0);                          // 线路/全网降级用点估计折算
    const cm = (trainSrc === "train" && tbTrain && tbTrain.cat_minutes) || null;
    trainComposition = Object.keys(trainCats).map((k) => {
      const pct = Number(trainCats[k]) || 0;
      return {
        category: k,
        share_pct: +pct.toFixed(2),
        minutes: cm && cm[k] != null ? cm[k] : +(avgForMin * pct / 100).toFixed(2),
      };
    }).sort((a, b) => b.share_pct - a.share_pct);
  }
  const trainMeta = (tbTrain && trainSrc === "train") ? {
    codes: tbTrain.codes || null,
    msgcats: tbTrain.msgcats || null,
    lines: tbTrain.lines || null,
  } : null;

  return {
    point_estimate: point,
    prediction_date: date,
    destination: dest || null,
    region: region || null,
    historical,
    line_key: lineKey || null,
    line_profile_based_on: (lineBd && lineBd.based_on) || null,
    line_stats: lineStats || null, // 方案 C·B：该线路 parquet 实测延误特征
    top_codes: topCodes,           // raw_data 原因编码实测（延误/取消率）
    reason_window: (rp && rp.date_range) ? rp.date_range : null,
    train_composition: trainComposition,  // 本车次原因成分（百分比+分钟）
    train_composition_src: trainSrc,      // train | line | global
    train_composition_sample: trainSample,// 样本规模，前端标注用
    train_meta: trainMeta,                // 编码明细/消息分类（仅一级有）
    zf_cats: zfCats,               // zugfinder 原因正文分类（730 天，含严重度加权）
    zf_meta: zf ? {
      records: zf.records, with_remark: zf.with_remark, remark_pct: zf.remark_pct,
      unique_remarks: zf.unique_remarks,
      avg_with: zf.avg_delay_with_remark, avg_without: zf.avg_delay_without_remark,
      severity: zf.severity || null,
      // 车型上下文：倍率是「该车型实测」还是「全局回退」
      train_type: zfTypeCtx ? zfTypeCtx.train_type : null,
      type_source: zfTypeCtx ? zfTypeCtx.type_source : null,
      type_base: zfTypeCtx ? zfTypeCtx.type_base : null,
    } : null,
    today: {
      weather_delay_min: weatherMin,
      weather_no_data: weatherNoData,
      weather_min_date: cache.weatherMinDate,
      weather_max_date: cache.weatherMaxDate,
      incidents: todayIncidents,
    },
  };
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  // 防目录穿越
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      applySecurityHeaders(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    applySecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // Frontend files are deployed in place; revalidate them so a new HTML
      // structure cannot be paired with a stale app.js in the browser cache.
      "Cache-Control": [".html", ".js", ".css"].includes(ext) ? "no-cache" : "public, max-age=86400",
    });
    res.end(data);
  });
}

// ---- 时刻表索引（五车型站对站查询）----
let timetable = null;
let stationNames = [];
let stationSet = new Set();
let stationByLetter = {}; // A-Z → 站名数组（按字母选站）

const FIVE_TYPES = ["RE", "RB", "IC", "ICE", "FLX"];

function loadTimetable() {
  try {
    const raw = fs.readFileSync(TIMETABLE, "utf-8");
    timetable = JSON.parse(raw);
    for (const t of timetable) {
      // 预计算每班次站名 set（加速匹配）
      t._set = new Set(t.stations);
      for (const s of t.stations) {
        if (!s || stationSet.has(s)) continue;
        stationSet.add(s);
        const letter = s.trim().charAt(0).toUpperCase();
        if (/[A-Z]/.test(letter)) {
          (stationByLetter[letter] = stationByLetter[letter] || []).push(s);
        } else {
          (stationByLetter["#"] = stationByLetter["#"] || []).push(s);
        }
      }
    }
    stationNames = Array.from(stationSet).sort();
    console.log(`时刻表已加载: ${timetable.length} 班次, ${stationNames.length} 站`);
  } catch (e) {
    timetable = null;
    console.error("时刻表加载失败:", e.message);
  }
}

// 站 → 州 映射（端点投票，启动时构建一次）。
// 背景（2026-09-09 用户报告「RE 8 筛 Berlin 只剩清晨/深夜碎片」）：timetable
// 条目的 region 只标起点州——穿越多州的长途班次（RE 8 Wismar→Baruth 标
// MV/Brandenburg）在「按州筛选」下会整体消失，只剩起终点都在该州的市内碎片。
// 用全表端点证据投票出每站所属州（某站作为起/终点出现时所在条目的 region），
// 班次的途经州 = 站序各站州的并集 → 州筛选按「途经」匹配。
const _stationRegion = new Map();
function buildStationRegionMap() {
  if (!timetable) return;
  const votes = new Map();
  for (const t of timetable) {
    const sts = t.stations || [];
    if (!sts.length || !t.region) continue;
    for (const s of new Set([sts[0], sts[sts.length - 1]])) {
      if (!s) continue;
      let m = votes.get(s);
      if (!m) { m = new Map(); votes.set(s, m); }
      m.set(t.region, (m.get(t.region) || 0) + 1);
    }
  }
  for (const [s, m] of votes) {
    let best = "", bestN = -1;
    for (const [r, n] of m) if (n > bestN) { best = r; bestN = n; }
    _stationRegion.set(s, best);
  }
  console.log(`站→州映射已构建: ${_stationRegion.size} 站`);
}
function serviceRegions(sts, fallback) {
  const out = [];
  for (const s of sts || []) {
    const r = _stationRegion.get(s) || fallback;
    if (r && out.indexOf(r) < 0) out.push(r);
  }
  if (fallback && out.indexOf(fallback) < 0) out.push(fallback);
  return out;
}

// 站名匹配（不区分大小写包含）
// 站名归一化："Hamm (Westf) Hbf" / "Hamm(Westf)Hbf" / "hamm westf hbf" → "hammwestfhbf"
function normStationKey(s) {
  return String(s || "").trim().toLowerCase().replace(/[\s\-–—.(),&+/]/g, "");
}

function matchStation(q) {
  if (!q) return [];
  const key = normStationKey(q);
  if (!key) return [];
  return stationNames.filter((s) => normStationKey(s).includes(key)).slice(0, 20);
}

// 按字母取站
function stationsByLetter(letter) {
  const L = String(letter || "").trim().toUpperCase();
  if (!L) return [];
  if (L.length === 1) return (stationByLetter[L] || []).slice(0, 100);
  return stationByLetter[L.charAt(0)].filter((s) =>
    s.toLowerCase().startsWith(L.toLowerCase())).slice(0, 100);
}

// 时间字符串 "HH:MM" → 分钟数
function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 站对站匹配班次（支持 types 过滤）
function findRoutes(fromQ, toQ, timeQ, limitQ, typesQ) {
  const fromMatch = matchStation(fromQ);
  const toMatch = matchStation(toQ);
  if (!fromMatch.length || !toMatch.length) {
    return { error: fromMatch.length ? "目的站未找到" : "起点站未找到",
             from_candidates: fromMatch, to_candidates: toMatch, routes: [] };
  }
  const fromSet = new Set(fromMatch.map(normStationKey));
  const toSet = new Set(toMatch.map(normStationKey));
  const types = (typesQ || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const typeSet = types.length ? new Set(types) : null;
  const timeMin = toMin(timeQ);
  const limit = Math.min(Math.max(parseInt(limitQ, 10) || 20, 1), 50);
  const out = [];
  for (const t of timetable) {
    if (typeSet && !typeSet.has(t.train_type)) continue;
    const sts = t.stations;
    let fi = -1, ti = -1;
    for (let i = 0; i < sts.length; i++) {
      if (fromSet.has(normStationKey(sts[i]))) { fi = i; break; }
    }
    if (fi < 0) continue;
    for (let i = fi + 1; i < sts.length; i++) {
      if (toSet.has(normStationKey(sts[i]))) { ti = i; break; }
    }
    if (ti < 0) continue;
    const depMin = toMin(t.planned_times[fi]);
    if (depMin < 0) continue;
    if (timeMin >= 0 && depMin < timeMin) continue;
    const dur = toMin(t.planned_times[ti]) - depMin;
    // NaT/非 HH:MM 的到站时刻（如"未计划停靠"）→ null（前端显示"—"）
    const arrTimeRaw = t.planned_times[ti];
    const arrTimeSafe = (typeof arrTimeRaw === "string" && /^\d{1,2}:\d{2}$/.test(arrTimeRaw))
      ? arrTimeRaw : null;
    out.push({
      line_number: t.line_number,
      train_type: t.train_type,
      from_station: sts[fi],
      to_station: sts[ti],
      dep_time: t.planned_times[fi],
      arr_time: arrTimeSafe,
      duration_min: dur > 0 ? dur : null,
      n_stops: ti - fi,
      n_days: t.n_days,
      region: t.region,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.dep_time.localeCompare(b.dep_time));
  return { routes: out, from_candidates: fromMatch, to_candidates: toMatch };
}

// 线路归一（"RE 11" / "RE11" / "re11" → "RE11"）
function normalizeLine(s) {
  // 把 "RE 11" / "RE11" / "RE-FEX" / "ICE 847" 都归一为大写无分隔符
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "");
}

// 评论归属键（"ICE 847"/"ICE_847" → "ICE_847"；空 → ""=首页/全局）
function normalizeTrainKey(s) {
  return String(s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

// 提取 type + 号码（type 部分用于前端分组，号码用于 timetable 匹配）
function splitTrainLine(s) {
  const n = normalizeLine(s);
  // 优先匹配长前缀：ICE 在 IC 前
  for (const pre of ["ICE", "FLX", "RE", "RB", "IC"]) {
    if (n.startsWith(pre)) {
      return { type: pre, num: n.slice(pre.length) };
    }
  }
  return { type: "", num: n };
}

// 查询某线路的所有班次（按 line_number 聚合）
function findServices(lineQ, timeQ, typesQ) {
  const ln = normalizeLine(lineQ);
  if (!ln) return { error: "缺少参数 line" };
  const timeMin = toMin(timeQ);
  const types = (typesQ || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const typeSet = types.length ? new Set(types) : null;
  // 聚合：line_number + from + to + dep_time 唯一化（去重取 n_days 最大）
  // 用户可能输 "RE 11" / "RE11" / "11"——一律按"号码 + type"匹配
  const { type: qType, num: qNum } = splitTrainLine(lineQ);
  if (!qNum) return { error: "缺少参数 line" };
  const seen = new Map();
  for (const t of timetable) {
    const { type: tType, num: tNum } = splitTrainLine(t.line_number);
    if (tNum !== qNum) continue;
    if (qType && tType && qType !== tType) continue; // 用户指定了类型，必须匹配
    if (typeSet && !typeSet.has(t.train_type)) continue;
    const sts = t.stations;
    const dep_t = t.planned_times[0];
    const depMin = toMin(dep_t);
    if (depMin < 0) continue;
    if (timeMin >= 0 && depMin < timeMin) continue;
    const key = sts[0] + "→" + sts[sts.length - 1] + "@" + dep_t;
    const cur = seen.get(key);
    if (!cur || t.n_days > cur.n_days) {
      // 拼出 "RE 11" 风格：先按 tType（号码拆分出的类型），若空则用 train_type 兜底
      const prefix = tType || (["RE","RB","ICE","IC","FLX"].includes(String(t.train_type).toUpperCase()) ? String(t.train_type).toUpperCase() : "");
      const lnFmt = prefix ? (prefix + " " + tNum) : t.line_number;
      seen.set(key, {
        line_number: lnFmt,
        train_type: t.train_type,
        from_station: sts[0],
        to_station: sts[sts.length - 1],
        dep_time: dep_t,
        n_stops: sts.length,
        n_days: t.n_days,
        region: t.region,
        regions: serviceRegions(sts, t.region), // 途经州集合（州筛选按途经匹配）
        all_stations: sts,  // 完整站序（前端 datalist 用）
      });
    }
  }
  const out = Array.from(seen.values()).sort((a, b) => a.dep_time.localeCompare(b.dep_time));
  // 回显保留「单空格」格式（"RE 11"），与 services[].line_number 风格一致；
  // 仅影响展示与前端 key 一致性，不影响上面的匹配逻辑（匹配走 splitTrainLine 抽号码）。
  const lineEcho = String(lineQ || "").trim().toUpperCase()
    .replace(/_/g, " ").replace(/\s+/g, " ");
  return { line: lineEcho || ln, count: out.length, services: out };
}

// ===================== 班次号列表（查车次卡片展示「RE 62037」用） =====================
// 号源 = PieBro parquet 的 train_number（每班次唯一）。train_insight.py 的
// TRAIN_LIST_RIDES 模式只扫 parquet，不登录 zugfinder，首查约 3~10s，
// 内存缓存后毫秒级。前端拿列表按「起点站+发车时刻」自行匹配卡片。
const rideNumCache = new Map(); // 线路归一键 → { ts, numbers, waiters }
const RIDE_NUM_TTL = 24 * 3600 * 1000;
function getRideNumbers(lineQ, cb) {
  const key = String(lineQ || "").toUpperCase().replace(/\s+/g, "");
  if (!key) return cb(new Error("缺少参数 line"));
  const hit = rideNumCache.get(key);
  if (hit) {
    if (hit.numbers && Date.now() - hit.ts < RIDE_NUM_TTL) return cb(null, hit.numbers);
    if (hit.waiters) { hit.waiters.push(cb); return; } // 进行中：排队等同一次 spawn
  }
  const entry = { numbers: null, ts: 0, waiters: [cb] };
  rideNumCache.set(key, entry);
  const env = Object.assign({}, process.env, { TRAIN_LIST_RIDES: "1" });
  if (LOCAL_PRO_DIR && !env.ZUGFINDER_PRO_DIR) env.ZUGFINDER_PRO_DIR = LOCAL_PRO_DIR;
  const child = spawn(PYTHON_BIN, [INSIGHT_SCRIPT, lineQ], { env, windowsHide: true });
  let stdout = "", stderr = "", timedOut = false, settled = false;
  const killTimer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const finish = (err, numbers) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    const ws = entry.waiters || [];
    entry.waiters = [];
    if (err) { rideNumCache.delete(key); ws.forEach((w) => w(err)); }
    else ws.forEach((w) => w(null, numbers));
  };
  child.on("error", (err) => finish(new Error("班次号服务异常: " + err.message)));
  child.on("close", (code) => {
    if (timedOut) return finish(new Error("班次号查询超时"));
    if (code !== 0) return finish(new Error("班次号服务异常(exit " + code + "): " + (stderr || "").slice(0, 200)));
    try {
      const d = JSON.parse(stdout);
      entry.numbers = Array.isArray(d.numbers) ? d.numbers : [];
      entry.ts = Date.now();
      finish(null, entry.numbers);
    } catch (e) {
      finish(new Error("班次号输出解析失败"));
    }
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // —— 全局兜底（2026-09-18）：绝不让任何 handler 异常冒泡到进程层 ——
  // 2026-09-17 全站宕机的机制就是「一个写操作抛异常 → 未捕获 → 进程挂死」。
  // 这里捕获同步抛出与 Promise 拒绝，保证最坏情况只挂一个请求，不挂整站。
  try {
    return handleRequest(req, res, parsed, pathname);
  } catch (e) {
    return failSafe(res, e);
  }
});

function handleRequest(req, res, parsed, pathname) {
  // —— 健康检查（2026-09-18 新增）——
  // 2026-09-17 全站宕机时没有任何可用的自检端点，只能靠人工 curl 首页判断。
  // 这里给出结构化的就绪状态：存储可写性、时刻表、预测 worker、行程代理。
  if (pathname === "/api/health") {
    const out = { status: "ok", time: new Date().toISOString(), checks: {} };
    // 1) 存储可写性（关键：只读会拖垮写操作）
    // 逐个子目录探测：只读可能只发生在 shares/ 或 comment_images/ 这类
    // 单独挂载点上，只探 data/ 根目录会漏报（2026-09-18 实测踩到）。
    const _probeTargets = [
      ["data", path.join(ROOT, "data", ".health-write-probe")],
      ["shares", path.join(SHARES_DIR, ".health-write-probe")],
      ["comment_images", path.join(COMMENT_IMG_DIR, ".health-write-probe")],
    ];
    const _roParts = [];
    let writable = true, werr = "";
    for (const [label, probe] of _probeTargets) {
      try {
        fs.mkdirSync(path.dirname(probe), { recursive: true });
        fs.writeFileSync(probe, String(Date.now()));
        fs.unlinkSync(probe);
      } catch (e) {
        writable = false;
        _roParts.push(label + "(" + (e.code || e.message) + ")");
        werr = e.code || e.message;
      }
    }
    _storageReadonly = !writable;
    out.checks.storage = {
      ok: writable,
      detail: writable ? "data/ 全部可写" : ("不可写: " + _roParts.join(", ")),
    };
    out.checks.storage_readonly_flag = { ok: !_storageReadonly, detail: String(_storageReadonly) };
    // 2) 时刻表
    out.checks.timetable = { ok: !!timetable, detail: timetable ? (timetable.length + " 班次") : "未加载" };
    // 3) 预测 worker（决定 /api/train 冷查询是 12s 还是 60s+）
    out.checks.predictor_worker = { ok: null, detail: "未探测（见 /api/health?deep=1）" };
    // 4) 行程抓取代理
    out.checks.journey_proxy = {
      ok: !!JOURNEY_SOCKS5_HOST,
      detail: JOURNEY_SOCKS5_HOST ? (JOURNEY_SOCKS5_HOST + ":" + JOURNEY_SOCKS5_PORT) : "未配置（直连，bahnapp WAF 可能拦截）",
    };
    if (!writable) { out.status = "degraded"; }
    // ?deep=1 时同步探测 worker 端口，供运维/守护脚本快速判断
    if (parsed.query.deep === "1") {
      try {
        const cp = require("child_process");
        const r = cp.execSync("ss -tlnp 2>/dev/null | grep -c ':" + (process.env.PREDICTOR_WORKER_PORT || 5099) + "\\b'", { encoding: "utf8", timeout: 3000 });
        const n = parseInt(String(r).trim(), 10) || 0;
        out.checks.predictor_worker = { ok: n > 0, detail: n > 0 ? "监听中" : "未监听（冷查询将走 spawn 慢路径）" };
        if (!n) out.status = "degraded";
      } catch (e) {
        out.checks.predictor_worker = { ok: false, detail: "探测失败: " + e.message };
      }
    }
    return sendJSON(res, out.status === "ok" ? 200 : 503, out);
  }

  if (pathname === "/api/delay") {
    const train = parsed.query.train || "";
    const limitRaw = parseInt(parsed.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 0;
    if (!train) {
      return sendJSON(res, 400, { error: "缺少参数 train" });
    }
    try {
      const result = queryDelay(train, limit);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // 真实预测：调 python train_insight.py（登录 zugfinder Pro + 近 N 天逐站 + 明日预测）
  if (pathname === "/api/train") {
    const respond = observeRequest(req, res, pathname);
    const train = (parsed.query.train || "").trim();
    const days = Math.min(Math.max(parseInt(parsed.query.days, 10) || 8, 3), 8);
    const destination = (parsed.query.destination || "").trim();
    const predictDate = (parsed.query.date || "").trim();
    const rideFrom = (parsed.query.ride_from || "").trim();
    const rideTo = (parsed.query.ride_to || "").trim();
    const rideTime = (parsed.query.ride_time || "").trim();
    if (!train) {
      return respond(400, { error: "缺少参数 train" }, { reason: "missing_train" });
    }
    const cacheParams = { train, days, predictDate, destination, rideFrom, rideTo, rideTime };
    const cacheKey = predictionCacheKey(cacheParams);
    const respondTrain = (data, extra) => {
      // 内存 + 磁盘两级都记：/api/breakdown 懒加载时要按同一 cacheKey 取回 python 数据
      memoTrainData(cacheKey, train, destination, data);
      return respond(200, data, extra);
    };
    // 1) 进程内缓存（同进程重复查询）
    const cachedData = getPredictionCache(cacheKey);
    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      recordPredictionHistory(req, cachedData, cacheParams);
      return respondTrain(cachedData, { cache_hit: true });
    }
    // 2) 磁盘缓存（跨用户/跨重启共享；仅当日有效，次日自动删除重算）
    const diskData = getTrainDiskCache(cacheKey);
    if (diskData) {
      res.setHeader("X-Cache", "DISK");
      setPredictionCache(cacheKey, diskData);
      recordPredictionHistory(req, diskData, cacheParams);
      return respondTrain(diskData, { cache_hit: true, cache_source: "disk" });
    }
    res.setHeader("X-Cache", "MISS");
    // ── 并发合并（request coalescing，2026-09-14 压测发现）────────────────
    // 缺口：N 个用户同时查同一冷车次 → spawn N 个 python，做 N 遍完全相同的
    //   计算（单进程峰值 RSS 3.4GB），在 4 核配额下全部撞上超时 → N 人一起 502。
    //   实测 20 并发同车次 = 20 个进程 + 20 个 502（平均 172s）。
    // 方案：同 cacheKey 的在途请求排队，共用一次 spawn。首个请求真正 spawn，
    //   其余挂 waiters 等结果（成功后共享，失败则各自重放一次错误）。
    const inflightKey = cacheKey;
    let inFlight = trainInflight.get(inflightKey);
    if (inFlight && inFlight.waiters) {
      // 记住本请求自己的 respond：领导者失败时要能原样给排队者返回同样的
      // 状态码（502/503），只推 respondTrain 会导致它们拿到 200 包错误体。
      inFlight.waiters.push({ ok: respondTrain, fail: respond });
      inFlight.n++;
      res.setHeader("X-Coalesce", "joined:" + inFlight.n);
      return; // 等首个请求完成后统一回调
    }
    const entry = { n: 1, waiters: [], settle: null };
    trainInflight.set(inflightKey, entry);
    // 统一收口：成功/失败都把结果广播给所有排队者
    const _origRespondTrain = respondTrain;
    const broadcast = function () {
      return function (data, extra) {
        const st = trainInflight.get(inflightKey);
        if (st) {
          const ws = st.waiters || [];
          st.waiters = [];
          ws.forEach(function (w) {
            try { (w && w.ok) ? w.ok(data, extra) : w(data, extra); } catch (_) {}
          });
          trainInflight.delete(inflightKey);
        }
        return _origRespondTrain(data, extra);
      };
    }();
    const respondTrain2 = broadcast;
    // 失败收口：任何错误分支都必须清掉 in-flight 登记，否则排队的并发请求
    // 会永远挂起（等到浏览器超时）。必须声明在 handler 作用域而非 spawnPredict
    // 内部，否则 worker 路径引用不到 —— 那里一旦 ReferenceError，会被下面的
    // .catch 捕获并错误地降级 spawn，把「车次不存在」拖成 85s 才返回。
    const _clearInflight = function () {
      const st = trainInflight.get(inflightKey);
      if (st) { st.waiters = []; trainInflight.delete(inflightKey); }
    };
    // 失败广播：领导者出错时，排队者必须拿到同样的状态码。之前只给领导者回错
    // 误、waiters 被静默丢弃 → 它们在压测里表现为「无响应直到浏览器超时」，
    // 比明确报错难排查得多，生产环境也是实打实的白等。
    const _failAll = function (code, payload, extra) {
      const st = trainInflight.get(inflightKey);
      const ws = (st && st.waiters) || [];
      _clearInflight();
      ws.forEach(function (w) {
        try {
          if (w && w.fail) w.fail(code, payload, extra);
          else if (w && w.ok) w.ok(payload, extra);
          else if (typeof w === "function") w(payload, extra);
        } catch (_) {}
      });
      return respond(code, payload, extra);
    };

    // ── 成功后的统一后处理（常驻 worker 与 spawn 降级两条路径共用）──────
    // 抽出来是为了保证两条路径产出的对象结构 100% 一致（含 _query 回显、
    // 区间计算、走向防御标注、两级缓存写入），避免「走 worker 就少了字段」。
    const finishPrediction = function (data, extra) {
      // 2026-09-11：成分拆解（breakdown）从同步链路拆出 → 独立懒加载端点
      // /api/breakdown。python 预测本身 10~40s，之前的 breakdown 计算（首次含
      // 19.9MB JSON 解析 + spawn station_to_region）叠在后面拖慢出结果；
      // 且用户明确要求「展开看时再加载」。这里只缓存 python 数据供复用。
      // 回显规范查询参数（磁盘缓存序列化发生在 respondTrain 前，必须提前注入）
      data._query = { train, days, date: predictDate || "",
                      destination, ride_from: rideFrom, ride_to: rideTo, ride_time: rideTime };
      // 区间预测：用户传入 ride_from + ride_to（直达卡片）时，从 station_days 算段延迟
      if (rideFrom && rideTo) {
        data.segment = computeSegment(data, rideFrom, rideTo);
      }
      // 走向防御（2026-09-10 RE 1 随机回归发现）：请求了区间（ride_from→ride_to）
      // 但返回站序不覆盖该方向——复用号线路级查询可能落到全国同名线的另一个州
      // 变体（RE 1 Dresden→Görlitz 段在 zugfinder z=RE_1 下只有 Saarlouis 变体）。
      // 不隐藏数据，但显式标注，前端展示「数据可能不属于该区间」而非假装正确。
      if (rideFrom && rideTo && data && Array.isArray(data.stations) && data.stations.length > 1) {
        const _nrm = (s) => String(s || "").toLowerCase()
          .replace(/hauptbahnhof|flughafen|bahnhof|hbf|bhf/g, "")
          .replace(/[^a-z0-9äöüß]/g, "");
        const _sts = data.stations.map(_nrm);
        const _fi = _sts.indexOf(_nrm(rideFrom));
        const _ti = _sts.indexOf(_nrm(rideTo));
        if (_fi < 0 || _ti < 0 || _fi >= _ti) {
          data.interval_warning = { from: rideFrom, to: rideTo };
        }
      }
      recordPredictionHistory(req, data, cacheParams);
      setPredictionCache(cacheKey, data);
      setTrainDiskCache(cacheKey, data);
      // 走 broadcast：把结果同时派发给所有排队的并发请求
      return respondTrain2(data, Object.assign({ cache_hit: false }, extra || {}));
    };

    // ══ 路径 A：常驻 worker（2026-09-14 主路径）════════════════════════
    // 原 spawn-per-request 每个请求都要重跑 ProductionPredictor 构造 =
    // joblib.load(21MB) + read_parquet(131MB 等 4 张表) ≈ 72.4s / 3.29GB，
    // 而真推理只要 0.91s → 82s 冷启动里 88% 是重复加载。
    // worker 常驻后复用同一进程内的单例，实测 82s → 8.3s，且不再有
    // 「N 并发 = N 份 3.3GB」的内存放大。
    if (PREDICTOR_WORKER_URL) {
      // 回调本身不是 async（避免改动整个 handler 的错误处理语义），这里用
      // Promise 链：worker 成功就收尾返回，失败/超时则回落到下面的 spawn 路径。
      callPredictorWorker({ train, days, date: predictDate,
                            destination, rideFrom, rideTo, rideTime })
        .then(function (w) {
          if (w && !w.error) {
            finishPrediction(w, { source: "worker" });
            return true;
          }
          // worker 明确返回业务错误（车次不存在 / days 超限等）：直接透传。
          // 不再降级 spawn —— 这类错误 spawn 也是同样结果，重试只白白翻倍耗时。
          return _failAll(502, { error: (w && w.error) || "worker 返回空结果" },
                  { source: "worker", reason: "child_business_error" });
        })
        .catch(function (e) {
          // worker 并发闸门满（503 worker_busy）→ 明确告知繁忙并让客户端重试。
          // 绝不降级 spawn：高峰期一批请求各自 fork 3.4GB 的 python 会直接
          // 把整机拖进 OOM（这正是旧架构 100 并发全 502 的根因）。
          if (e && e.status === 503) {
            res.setHeader("Retry-After", "5");
            return _failAll(503, { error: "预测服务繁忙，请稍后重试", retryable: true },
                    { source: "worker", reason: "worker_busy" });
          }
          // worker 明确返回业务错误（HTTP 502 + error 字段：车次不存在 / days 超限
          // 等）→ 原样透传，不降级 spawn。spawn 跑一遍还是同样的结果，只会白白翻倍耗时。
          if (e && e.status === 502 && e.body && e.body.error) {
            return _failAll(502, { error: e.body.error },
                    { source: "worker", reason: "child_business_error" });
          }
          // worker 不可达 / 超时 / 非 JSON → 降级 spawn，保证可用性不回退。
          // 但必须过闸门：并发降级 = 并发 fork 3.4GB，实测 4 个就 OOM 清场。
          if (_spawnActive >= SPAWN_MAX_CONCURRENCY) {
            res.setHeader("Retry-After", "10");
            console.warn("[worker] 降级被闸门拦截 (spawn 在途 " + _spawnActive
              + "/" + SPAWN_MAX_CONCURRENCY + "):", train, e.message);
            return _failAll(503, { error: "预测服务繁忙，请稍后重试", retryable: true },
                    { source: "worker", reason: "spawn_gate_full" });
          }
          console.warn("[worker] 调用失败，降级 spawn:", train, e.message);
          spawnPredict();
        });
      return; // worker 路径接管；降级由 catch 内的 spawnPredict() 执行
    }
    spawnPredict();
    return;

    function spawnPredict() {
    if (_spawnActive >= SPAWN_MAX_CONCURRENCY) {
      res.setHeader("Retry-After", "10");
      return _failAll(503, { error: "预测服务繁忙，请稍后重试", retryable: true },
              { reason: "spawn_gate_full" });
    }
    _spawnActive++;
    const _releaseSpawn = function () {
      _spawnActive = Math.max(0, _spawnActive - 1);
    };
    const args = [INSIGHT_SCRIPT, train, "--days", String(days)];
    if (predictDate) args.push("--date", predictDate);
    // destination 含空格，走环境变量避免 Windows spawn 参数引用问题
    const env = Object.assign({}, process.env);
    if (LOCAL_PRO_DIR && !env.ZUGFINDER_PRO_DIR) env.ZUGFINDER_PRO_DIR = LOCAL_PRO_DIR;
    if (destination) env.TRAIN_DESTINATION = destination;
    if (rideFrom) env.TRAIN_RIDE_FROM = rideFrom;
    if (rideTo) env.TRAIN_RIDE_TO = rideTo;
    if (rideTime) env.TRAIN_RIDE_TIME = rideTime;
    // spawn 正确处理含空格参数（Windows CreateProcess）
    const child = spawn(PYTHON_BIN, args, {
      env, windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // 超时预算：python 冷启动需重载 21MB 模型 + 131MB 历史表 + 逐天抓取
    // （8 天 × DEFAULT_DELAY 2s ≈ 16s）+ 未命中时整线再抓一次。实测 85s 属正常，
    // 90s 会在慢网络下误杀（child_timeout）。放宽到 150s（可用 PYTHON_TIMEOUT_MS 覆盖）。
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PYTHON_TIMEOUT_MS);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    // _clearInflight 已提升到 handler 作用域（见上），此处不再重复声明
    child.on("error", (err) => {
      clearTimeout(killTimer);
      _releaseSpawn();
      console.error("train_insight spawn err:", err.message, stderr || "");
      return _failAll(502, { error: "预测服务异常: " + err.message }, {
        child_exit_code: null,
        child_timeout: timedOut,
        reason: "spawn_error",
      });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      _releaseSpawn();
      if (code !== 0) {
        console.error("train_insight exit:", code, stderr || "");
        return _failAll(502, { error: "预测服务异常(exit " + code + "): " + (stderr || "").slice(0, 300) }, {
          child_exit_code: code,
          child_timeout: timedOut,
          reason: timedOut ? "child_timeout" : "child_exit",
        });
      }
      try {
        const data = safeJsonParse(stdout);
        if (data && data.error) {
          return _failAll(502, { error: data.error }, {
            child_exit_code: code,
            child_timeout: false,
            reason: "child_business_error",
          });
        }
        // 后处理逻辑已抽到 finishPrediction（与 worker 路径共用，保证结构一致）
        return finishPrediction(data, {
          child_exit_code: code, child_timeout: false, source: "spawn",
        });
      } catch (e) {
        return _failAll(502, { error: "预测输出解析失败" }, {
          child_exit_code: code,
          child_timeout: false,
          reason: "invalid_child_json",
        });
      }
    });
    } // end spawnPredict
  }

  // ---- 晚点成分拆解（懒加载）：前端展开「晚点成分构成」面板时才调用 ----
  // 复用 /api/train 已取回的 python 数据（内存 memo → 磁盘缓存），现场计算 breakdown。
  // 找不到数据（服务重启且当日缓存已清）→ 410，前端提示重新查询。
  if (pathname === "/api/breakdown" && req.method === "GET") {
    const respond = observeRequest(req, res, pathname);
    // 归一化：'RE_49127' → 'RE 49127'（与 /api/train 的 key 和车型匹配保持一致）
    const train = (parsed.query.train || "").trim()
      .replace(/_/g, " ").replace(/\s+/g, " ");
    if (!train) return respond(400, { error: "缺少参数 train" });
    const cacheParams = {
      train,
      days: Math.min(Math.max(parseInt(parsed.query.days, 10) || 8, 3), 8),
      predictDate: (parsed.query.date || "").trim(),
      destination: (parsed.query.destination || "").trim(),
      rideFrom: (parsed.query.ride_from || "").trim(),
      rideTo: (parsed.query.ride_to || "").trim(),
      rideTime: (parsed.query.ride_time || "").trim(),
    };
    const cacheKey = predictionCacheKey(cacheParams);
    let memo = takeMemoTrainData(cacheKey);
    if (!memo) {
      // 进程重启 / 跨进程：试磁盘缓存（当日有效）
      const diskData = getTrainDiskCache(cacheKey);
      if (diskData) {
        memoTrainData(cacheKey, train, cacheParams.destination, diskData);
        memo = takeMemoTrainData(cacheKey);
      }
    }
    if (!memo) {
      // 兜底：按「同车次 + 同区间」模糊匹配最近的 memo（key 形式差异容错）
      const fz = findMemoFuzzy(train, cacheParams);
      if (fz) memo = fz;
    }
    if (!memo) {
      // 410 语义：该车次的 python 预测数据尚未生成（/api/train 未成功跑过）。
      // 带 hint 供前端给出可执行指引，而非只甩错误码。
      return respond(410, {
        error: "breakdown_no_train_data",
        hint: "请先查询该车次的预测，再查看晚点成分构成",
      }, { reason: "memo_miss" });
    }
    try {
      const bd = computeBreakdown(memo.data, memo.destination, lineKeyOf(memo.train), memo.train);
      return respond(200, { train: memo.train, breakdown: bd }, { cache_hit: true });
    } catch (e) {
      console.error("[breakdown] compute err:", e.message);
      return respond(500, { error: "breakdown_compute_failed" });
    }
  }

  // Parse a public BahnApp route into the train legs visible on its page.
  if (pathname === "/api/journey/parse" && req.method === "GET") {
    if (rateLimited(res, "journey_parse", req)) return;
    const target = (parsed.query.url || "").trim();
    if (!target) return sendJSON(res, 400, { error: "缺少参数 url" });
    const dbJourney = parseDbFahrplanJourney(target);
    if (dbJourney) return sendJSON(res, 200, dbJourney);
    let dbUrl;
    try { dbUrl = new URL(target); } catch (_) { dbUrl = null; }
    if (dbUrl && /(^|\.)int\.bahn\.de$/i.test(dbUrl.hostname) && /^\/[^/]*\/buchung\/start$/i.test(dbUrl.pathname) && dbUrl.searchParams.get("vbid")) {
      return fetchDbVbid(dbUrl.searchParams.get("vbid"), (err, journey) => {
        if (err) return sendJSON(res, 502, { error: err.message });
        return sendJSON(res, 200, journey);
      });
    }
    fetchJourneyPage(target, (err, html) => {
      if (err) {
        // 中转检测到上游仍是拒绝页 → 与下面的 _denied 分支同样按 422 返回，
        // 让前端走 journey_source_blocked 的专用文案（含改用文本粘贴的引导）。
        if (err.message === "journey_source_blocked") {
          return sendJSON(res, 422, { error: "journey_source_blocked" });
        }
        return sendJSON(res, 502, { error: err.message });
      }
      const text = journeyPageText(html);
      if (process.env.JOURNEY_DEBUG) {
        console.log("[journey-debug] html字节=" + Buffer.byteLength(String(html || ""), "utf8") +
          "  text字节=" + Buffer.byteLength(String(text || ""), "utf8"));
        console.log("[journey-debug] html前160=" + JSON.stringify(String(html || "").slice(0, 160)));
      }
      // 2026-09-14：先判别「页面本身就不是行程页」。
      // bahnapp.link 会按来源 IP/风控把抓取请求重定向到 denied/blocked.html
      // （返回 HTTP 200 + "Zugriff verweigert"），此时 HTML 里没有任何行程结构。
      // 旧代码会一路走到最后的 journey_parse_failed，让用户以为是自己链接有问题，
      // 反复重试或改用文本粘贴 —— 实际是网站侧拒绝了服务器，与用户无关。
      const _denied = /Zugriff verweigert|denied\/blocked\.html|Anfrage wurde blockiert/i.test(html);
      if (_denied) {
        return sendJSON(res, 422, { error: "journey_source_blocked" });
      }
      const legs = parseBahnAppJourney(html);
      // 2026-09-18：区分「链接失效」与「解析失败」。
      // bahnapp 的短码（/vUS2）是分享者本地会话的临时路由，重定向链为
      //   bahnapp.link/vUS2 →302→ bahnapp.online/vUS2 →302→ bahnapp.online/route
      // 最终落到**空白搜索页**（只有 UI 文案，无任何行程结构），解析必然失败。
      // 旧代码一律返回 journey_parse_failed，让用户以为是自己的操作/网站 bug，
      // 实际是链接过期 —— 必须区分，否则用户会反复重试无效链接。
      const _emptyRoute = !legs.length && /Gib einen Startbahnhof ein|Route suchen|Verbindung suchen/i.test(text)
                                   && text.length < 4000;
      if (_emptyRoute) {
        return sendJSON(res, 422, { error: "journey_link_expired" });
      }
      // BahnApp exposes each leg as: service, origin time/station, destination time/station.
      const re = /\b((?:ICE|IC|EC|RE|RB|IR|S|U|TGV|NJ|FlixTrain)\s*\d*(?:\s*\([^)]*\))?)\s+(?:To\s+[^0-9]+?\s+)?From\s+(\d{1,2}:\d{2})\s+(.+?)\s+To\s+(\d{1,2}:\d{2})\s+(.+?)(?=\s+(?:ICE|IC|EC|RE|RB|IR|S|U|TGV|NJ|FlixTrain)\b|\s+View journey|$)/gi;
      let m;
      while (!legs.length && (m = re.exec(text))) {
        const service = m[1].replace(/\s+/g, " ").trim();
        const from = m[3].replace(/\s+/g, " ").trim();
        const to = m[5].replace(/\s+/g, " ").trim();
        if (from && to && service) legs.push({ service, from, dep: m[2], to, arr: m[4] });
      }
      if (!legs.length) {
        const dbBooking = /(^|\.)int\.bahn\.de$/i.test(new URL(target).hostname);
        return sendJSON(res, 422, { error: dbBooking ? "journey_db_link_requires_text" : "journey_parse_failed" });
      }
      const dateMatch = text.match(/\b20\d{2}-\d{2}-\d{2}\b/);
      return sendJSON(res, 200, { source: "bahnapp.link", text, date: dateMatch ? dateMatch[0] : "", legs });
    });
    return;
  }

  // 影响分析：施工 / 天气对晚点的影响（聚合 ZUGVORHERSAGEN 分析数据）
  if (pathname === "/api/impact") {
    // 数据文件未部署（如新环境未上传 impact CSV）→ 明确返回缺失清单，而非笼统 502
    try {
      const missing = Object.keys(IMPACT_SRC).filter((k) => !fs.existsSync(IMPACT_SRC[k]));
      if (missing.length) {
        return sendJSON(res, 200, {
          available: false,
          missing: missing.map((k) => path.basename(IMPACT_SRC[k])),
          dir: path.relative(ROOT, IMPACT_DATA_DIR) + path.sep,
        });
      }
      return sendJSON(res, 200, loadImpactData());
    } catch (e) {
      return sendJSON(res, 502, { error: "影响数据加载失败: " + e.message });
    }
  }

  // 站名建议 —— 优先 bahn.expert（DB 官方 IRIS），降级本地时刻表
  if (pathname === "/api/stations") {
    const q = (parsed.query.q || "").trim();
    const letter = (parsed.query.letter || "").trim();

    // 有搜索关键词 → 调 bahn.expert stopPlace.byTerm（DB 官方站名）
    if (q) {
      const STATION_SEARCH_SCRIPT = path.join(ROOT, "station_search.py");
      const child = spawn(PYTHON_BIN, [STATION_SEARCH_SCRIPT, q, "20"]);
      let stdout = "", stderr = "";
      let stationTimedOut = false;
      const stationTimer = setTimeout(() => {
        stationTimedOut = true;
        child.kill();
      }, 10000);
      child.stdout.on("data", d => stdout += d.toString());
      child.stderr.on("data", d => stderr += d.toString());
      child.on("close", function(code) {
        clearTimeout(stationTimer);
        if (stderr) console.warn("[stations] python stderr:", stderr.slice(0, 300));
        if (code === 0 && stdout.trim()) {
          try {
            const liveStations = JSON.parse(stdout);
            if (liveStations && liveStations.length) {
              return sendJSON(res, 200, { q, letter, count: liveStations.length,
                stations: liveStations, source: "bahn_expert" });
            }
          } catch (_) { /* parse fail → fallback */ }
        }
        console.warn("[stations] bahn.expert 搜索失败%s，降级本地", stationTimedOut ? "（超时）" : "");
        const fallback = matchStation(q);
        return sendJSON(res, 200, { q, letter, count: fallback.length,
          stations: fallback, source: "local" });
      });
      child.on("error", function(e) {
        clearTimeout(stationTimer);
        console.warn("[stations] bahn.expert spawn 失败:", e.message);
        const fallback = matchStation(q);
        return sendJSON(res, 200, { q, letter, count: fallback.length,
          stations: fallback, source: "local" });
      });
      return; // async response
    }

    // 无搜索词：按字母 / 默认列表 → 也走 bahn.expert（字母当作前缀搜索）
    if (letter) {
      // letter 当作前缀搜 bahn.expert（严格前缀匹配）
      const STATION_SEARCH_SCRIPT = path.join(ROOT, "station_search.py");
      const child2 = spawn(PYTHON_BIN, [STATION_SEARCH_SCRIPT, letter, "20"]);
      let out2 = "", err2 = "";
      child2.stdout.on("data", d => out2 += d.toString());
      child2.stderr.on("data", d => err2 += d.toString());
      child2.on("close", function(code) {
        if (err2) console.warn("[stations] python stderr:", err2.slice(0, 300));
        if (code === 0 && out2.trim()) {
          try {
            const live = JSON.parse(out2);
            if (live && live.length) {
              return sendJSON(res, 200, { q, letter, count: live.length,
                stations: live, source: "bahn_expert" });
            }
          } catch (_) {}
        }
        // 降级
        const localList = stationsByLetter(letter);
        return sendJSON(res, 200, { q, letter, count: localList.length,
          stations: localList, source: "local" });
      });
      child2.on("error", function() {
        const localList = stationsByLetter(letter);
        return sendJSON(res, 200, { q, letter, count: localList.length,
          stations: localList, source: "local" });
      });
      return; // async
    }
    // 完全无参数：返回热门站（也走 bahn.expert）
    const child3 = spawn(PYTHON_BIN, ["-c", [
      "import sys,json;",
      "sys.path.insert(0,'" + ROOT.replace(/\\/g,"/") + "');",
      "from db_bahn_expert import search_station;",
      "r=search_station('Hbf',30);",
      "print(json.dumps([s.get('name','') for s in r if s.get('name')]))"
    ].join("")], { timeout: 10000 });
    let out3 = "", err3 = "";
    child3.stdout.on("data", d => out3 += d.toString());
    child3.stderr.on("data", d => err3 += d.toString());
    child3.on("close", function(code) {
      if (code === 0 && out3.trim()) {
        try {
          const live = JSON.parse(out3);
          if (live && live.length) {
            return sendJSON(res, 200, { q, letter, count: live.length,
              stations: live.slice(0, 50), source: "bahn_expert" });
          }
        } catch (_) {}
      }
      return sendJSON(res, 200, { q, letter, count: stationNames.length,
        stations: stationNames.slice(0, 50), source: "local" });
    });
    child3.on("error", function() {
      return sendJSON(res, 200, { q, letter, count: stationNames.length,
        stations: stationNames.slice(0, 50), source: "local" });
    });
    return; // async
  }

  // 站对站：起点/目的/时间/车型 → 候选班次（纯本地时刻表，兼容旧前端）
  if (pathname === "/api/routes") {
    const respond = observeRequest(req, res, pathname);
    const from = (parsed.query.from || "").trim();
    const to = (parsed.query.to || "").trim();
    if (!from || !to) {
      return respond(400, { error: "缺少参数 from/to" }, { reason: "missing_route_stations" });
    }
    if (!timetable) {
      return respond(503, { error: "时刻表未加载（检查 data/timetable_re_rb.json）" }, { reason: "timetable_unavailable" });
    }
    try {
      const r = findRoutes(from, to, parsed.query.time, parsed.query.limit,
                           parsed.query.types);
      recordHistory(req, { type: "routes", from, to,
                           time: (parsed.query.time || "").trim() });
      return respond(200, r);
    } catch (e) {
      return respond(500, { error: "查询异常: " + e.message }, { reason: "route_exception" });
    }
  }

  // 站对站实时查询（接入 bahn.expert / IRIS 官方后端）
  const STATION_QUERY_SCRIPT = path.join(ROOT, "db_station_query.py");
  if (pathname === "/api/routes-live") {
    const respond = observeRequest(req, res, pathname);
    const from = (parsed.query.from || "").trim();
    const to = (parsed.query.to || "").trim();
    if (!from || !to) {
      return respond(400, { error: "缺少参数 from/to" }, { reason: "missing_route_stations" });
    }
    const timeQ = (parsed.query.time || "").trim();
    const typesQ = (parsed.query.types || "").trim();
    const limitQ = parsed.query.limit || "20";
    const args = [
      "--from", from, "--to", to,
      "--json-pretty",
      "--limit", limitQ,
    ];
    if (timeQ) args.push("--time", timeQ);
    if (typesQ) args.push("--types", typesQ);

    const child = spawn(PYTHON_BIN, [STATION_QUERY_SCRIPT, ...args], {
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    // 35s 上限：脚本内部并发 + deadline 兜底（Phase2 12s + Phase3 18s + 组装 5s），
    // 超过即视为卡死/限流，降级到本地时刻表
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 35000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      console.warn("[routes-live] spawn err:", err.message);
      // 降级到本地时刻表
      try {
        const fb = findRoutes(from, to, timeQ, limitQ, typesQ);
        fb._fallback = true;
        return respond(200, fb, {
          child_exit_code: null,
          child_timeout: timedOut,
          fallback: true,
          reason: "spawn_error",
        });
      } catch (e2) {
        return respond(502, { error: "实时查询异常: " + err.message }, {
          child_exit_code: null,
          child_timeout: timedOut,
          reason: "spawn_error",
        });
      }
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        console.warn("[routes-live] exit:", code, stderr.slice(0, 200));
        // bahn.expert 超时/不可用时降级到本地时刻表
        try {
          const fb = findRoutes(from, to, timeQ, limitQ, typesQ);
          fb._fallback = true;
          fb._fallback_reason = stderr.slice(0, 200);
          return respond(200, fb, {
            child_exit_code: code,
            child_timeout: timedOut,
            fallback: true,
            reason: timedOut ? "child_timeout" : "child_exit",
          });
        } catch (e2) {
          return respond(502, { error: "查询失败(exit " + code + "): " + (stderr || "").slice(0, 300) }, {
            child_exit_code: code,
            child_timeout: timedOut,
            reason: timedOut ? "child_timeout" : "child_exit",
          });
        }
      }
      try {
        const data = safeJsonParse(stdout);
        recordHistory(req, { type: "routes_live", from, to,
                             time: (parsed.query.time || "").trim() });
        return respond(200, data, { child_exit_code: code, child_timeout: false });
      } catch (e) {
        return respond(502, { error: "实时查询输出解析失败" }, {
          child_exit_code: code,
          child_timeout: false,
          reason: "invalid_child_json",
        });
      }
    });
    return;
  }

  // 车型 → 该车型所有线路号（如 RE → [RE1, RE2, RE3, RE11...]）
  if (pathname === "/api/lines") {
    const type = (parsed.query.type || "").trim().toUpperCase();
    if (!type) {
      return sendJSON(res, 400, { error: "缺少参数 type" });
    }
    if (!timetable) {
      return sendJSON(res, 503, { error: "时刻表未加载" });
    }
    const set = new Set();
    // 防御：timetable 里部分服务的 train_type 标注不准（如 IC17 的 type 存成 RE），
    // 对有前缀约定的车型（RE/RB/IC/ICE）额外校验 line_number 以该前缀开头。
    const needsPrefix = /^(RE|RB|IC|ICE|FLX|FEX)$/i.test(type);
    for (const t of timetable) {
      if (t.train_type === type) {
        const ln = (t.line_number || "").trim();
        if (!needsPrefix || ln.toUpperCase().startsWith(type)) {
          set.add(ln);
        }
      }
    }
    const lines = Array.from(set).sort();
    return sendJSON(res, 200, { type, count: lines.length, lines });
  }

  // ===================== 懒加载：实时原因/事件（IRIS / bahn.expert 消息） =====================
  // 方案：先出晚点预测（不阻塞），用户点「查看实时原因/事件」再发此请求。
  // 仅当目标日期为今天才查实时；bahn.expert 不可达/该车今日不运行 → 返回友好 error，不崩溃。
  if (pathname === "/api/train-incidents") {
    if (rateLimited(res, "train_incidents", req)) return;
    const respond = observeRequest(req, res, pathname);
    const train = (parsed.query.train || "").trim();
    const dateIso = (parsed.query.date || "").trim();
    const eva = (parsed.query.eva || "").trim();
    if (!train) {
      return respond(400, { error: "缺少参数 train" }, { reason: "missing_train" });
    }
    const child = spawn(PYTHON_BIN, [path.join(ROOT, "train_incidents.py"), train, dateIso, eva], {
      env: Object.assign({}, process.env),
      windowsHide: true,
    });
    let out = "", errOut = "", killed = false;
    const tOut = setTimeout(() => { killed = true; child.kill(); }, 25000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("close", (code) => {
      clearTimeout(tOut);
      if (killed) {
        return respond(504, { error: "实时事件查询超时（bahn.expert 响应过慢）" },
          { reason: "timeout" });
      }
      let data;
      try {
        data = JSON.parse(out);
      } catch (e) {
        return respond(502, { error: "实时事件解析失败", detail: errOut.slice(0, 200) },
          { reason: "parse_error" });
      }
      return respond(200, data, { child_exit_code: code });
    });
    return;
  }

  // 线路 → 该线路所有班次（RE 11 一次列出所有班次）
  if (pathname === "/api/services") {
    const line = (parsed.query.line || "").trim();
    if (!line) {
      return sendJSON(res, 400, { error: "缺少参数 line" });
    }
    if (!timetable) {
      return sendJSON(res, 503, { error: "时刻表未加载" });
    }
    try {
      const r = findServices(line, parsed.query.time, parsed.query.types);
      recordHistory(req, { type: "services", line,
                           time: (parsed.query.time || "").trim() });
      // 2026-09-18：空结果要给出**可行动的引导**，而不是让用户对着空面板发愣。
      // 背景：时刻表 data/timetable_re_rb.json 是离线快照，长途车次号会随时间变化
      // （例：同一走向的 ICE 线路，快照里叫 843，现在是 847），
      // 因此「按车次号精确匹配」必然有查不到的情况。此时应引导用户改用
      // 起终点/车次直达预测，而不是静默返回空数组。
      if (!r.routes || r.routes.length === 0) {
        const ln = normalizeLine(line);
        // 该号查不到时，反查「同类型车型的全部可用号」，给出近似建议
        let suggest = [];
        try {
          const { type: qType, num: qNum } = splitTrainLine(line);
          if (qType && qNum && timetable) {
            // 找出与该号「站序相似」的其他号（同一走廊线路，号段相近）
            const nNum = parseInt(qNum, 10);
            if (Number.isFinite(nNum)) {
              const near = new Set();
              for (const t of timetable) {
                const { type: tType, num: tNum } = splitTrainLine(t.line_number);
                if (tType !== qType) continue;
                const tn = parseInt(tNum, 10);
                if (!Number.isFinite(tn)) continue;
                // 号段 ±30 内视为同一走廊候选
                if (Math.abs(tn - nNum) <= 30) near.add(tType + " " + tNum);
              }
              suggest = Array.from(near).slice(0, 8);
            }
          }
        } catch (_) {}
        return sendJSON(res, 200, Object.assign({}, r, {
          hint: "本地时刻表快照中没有该车次（长途车次号会随时间调整）。"
              + "可直接用「车次预测」查询实时数据，或改用起终点搜索。",
          hint_code: "services_not_in_snapshot",
          similar_lines: suggest,
        }));
      }
      return sendJSON(res, 200, r);
    } catch (e) {
      return sendJSON(res, 500, { error: "查询异常: " + e.message });
    }
  }

  // ===================== 班次号列表（查车次卡片展示「RE 62037」用） =====================
  // 号源 = PieBro parquet 的 train_number（每班次唯一）。train_insight.py 的
  // TRAIN_LIST_RIDES 模式只扫 parquet，不登录 zugfinder，首查约 3~10s，
  // 内存缓存后毫秒级。前端拿列表按「起点站+发车时刻」自行匹配卡片。
  if (pathname === "/api/ride-numbers") {
    const line = (parsed.query.line || "").trim();
    if (!line) {
      return sendJSON(res, 400, { error: "缺少参数 line" });
    }
    getRideNumbers(line, (err, numbers) => {
      if (err) return sendJSON(res, 502, { error: err.message });
      return sendJSON(res, 200, { line, count: numbers.length, numbers });
    });
    return;
  }

  // ===================== 评论区（按车次隔离；无 train=首页/全局） =====================
  // 评论列表（公开；最新在前，最多 100 条展示）
  if (pathname === "/api/comments" && req.method === "GET") {
    const user = getUserByToken(getToken(req));
    const trainKey = normalizeTrainKey(parsed.query.train || "");
    const list = readJSON(COMMENTS_FILE, []);
    const filtered = trainKey
      ? list.filter((c) => (c.train || "") === trainKey)
      : list.filter((c) => !c.train);
    const view = filtered.slice(0, 100).map(function (c) {
      return {
        id: c.id, email: c.email, content: c.content, ts: c.ts, image: c.image || null,
        likes: c.likes || 0,
        liked: !!(c.likedBy && user && c.likedBy.indexOf(user.email) >= 0),
        replies: (c.replies || []).map(function (r) {
          return { id: r.id, email: r.email, content: r.content, ts: r.ts, image: r.image || null };
        }),
      };
    });
    return sendJSON(res, 200, { comments: view, total: filtered.length });
  }

  // 发布评论（需登录；body 可带 train，空=首页/全局）
  if (pathname === "/api/comments" && req.method === "POST") {
    if (rateLimited(res, "comment_post", req)) return;
    const user = getUserByToken(getToken(req));
    if (!user) return sendJSON(res, 401, { error: "请先登录再评论" });
    readBody(req, (body) => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch (e) {
        return sendWriteError(res, e);
      }
      if (payload && payload.__tooLarge) {
        return sendJSON(res, 413, { error: "内容过大：配图请控制在 3MB 以内（可稍后重试，客户端会自动压缩）" });
      }
      const text = String((payload && payload.content) || "").trim();
      const rawImage = payload && payload.image;

      // 落库（文本 + 图片 URL 都已就绪）
      const commit = function (imageUrl) {
        try {
          if (!text && !imageUrl) return sendJSON(res, 400, { error: "评论内容不能为空" });
          if (text.length > COMMENT_MAX_LEN) {
            return sendJSON(res, 400, { error: "评论最长 " + COMMENT_MAX_LEN + " 字" });
          }
          const trainKey = normalizeTrainKey(payload.train || "");
          const list = readJSON(COMMENTS_FILE, []);
          const rec = {
            id: crypto.randomBytes(4).toString("hex"),
            email: user.email,
            content: text,
            ts: new Date().toISOString(),
            train: trainKey || "",
            image: imageUrl,
            likes: 0,
            likedBy: [],
            replies: [],
          };
          list.unshift(rec);
          if (list.length > COMMENTS_LIMIT) list.length = COMMENTS_LIMIT;
          writeJSONAtomic(COMMENTS_FILE, list);
          return sendJSON(res, 200, {
            comment: { id: rec.id, email: rec.email,
                       content: rec.content, ts: rec.ts, image: rec.image || null,
                       likes: 0, liked: false, replies: [] },
          });
        } catch (e) {
          return sendWriteError(res, e);
        }
      };

      // 图片处理链（异步）：magic bytes 校验 → 剥离 EXIF/GPS → 落盘 → commit
      let img = null;
      try {
        img = parseCommentImage(rawImage);
      } catch (ie) {
        return sendJSON(res, 400, { error: ie.message });
      }
      if (!img) return commit("");

      stripExif(img.buf, img.ext, function (_e, cleaned) {
        let url = "";
        try {
          url = saveCommentImage({ ext: img.ext, buf: cleaned || img.buf });
        } catch (se) {
          return sendWriteError(res, se, "图片保存失败");
        }
        return commit(url);
      });
    }, COMMENT_BODY_MAX_BYTES);
    return;
  }


  // 删除评论（仅本人）
  if (pathname === "/api/comments" && req.method === "DELETE") {
    const user = getUserByToken(getToken(req));
    if (!user) return sendJSON(res, 401, { error: "未登录" });
    const id = parsed.query.id || "";
    if (!id) return sendJSON(res, 400, { error: "缺少参数 id" });
    const list = readJSON(COMMENTS_FILE, []);
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: "评论不存在" });
    if (list[idx].email !== user.email) {
      return sendJSON(res, 403, { error: "只能删除自己的评论" });
    }
    const removed = list[idx];
    if (removed && removed.image) {
      const fp = path.join(COMMENT_IMG_DIR, path.basename(removed.image));
      fs.unlink(fp, () => {});
    }
    if (removed && removed.replies) {
      removed.replies.forEach(function (r) {
        if (r.image) { try { fs.unlink(path.join(COMMENT_IMG_DIR, path.basename(r.image)), function () {}); } catch (e) {} }
      });
    }
    list.splice(idx, 1);
    writeJSONAtomic(COMMENTS_FILE, list);
    return sendJSON(res, 200, { ok: true });
  }

  // 删除某条回复（仅本人；路径 /api/comments/:cid/reply/:rid）
  {
    const m = pathname.match(/^\/api\/comments\/([^/]+)\/reply\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      const user = getUserByToken(getToken(req));
      if (!user) return sendJSON(res, 401, { error: "未登录" });
      const list = readJSON(COMMENTS_FILE, []);
      const idx = list.findIndex((c) => c.id === m[1]);
      if (idx < 0) return sendJSON(res, 404, { error: "评论不存在" });
      const c = list[idx];
      const ri = (c.replies || []).findIndex((r) => r.id === m[2]);
      if (ri < 0) return sendJSON(res, 404, { error: "回复不存在" });
      if (c.replies[ri].email !== user.email) {
        return sendJSON(res, 403, { error: "只能删除自己的回复" });
      }
      const removed = c.replies[ri];
      if (removed.image) {
        try { fs.unlink(path.join(COMMENT_IMG_DIR, path.basename(removed.image)), function () {}); } catch (e) {}
      }
      c.replies.splice(ri, 1);
      writeJSONAtomic(COMMENTS_FILE, list);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // 评论点赞 / 回复（路径 /api/comments/:id/like 或 /api/comments/:id/reply）
  {
    const m = pathname.match(/^\/api\/comments\/([^/]+)\/(like|reply)$/);
    if (m && req.method === "POST") {
      if (rateLimited(res, "comment_like", req)) return;
      const user = getUserByToken(getToken(req));
      if (!user) return sendJSON(res, 401, { error: "请先登录" });
      const list = readJSON(COMMENTS_FILE, []);
      const idx = list.findIndex((c) => c.id === m[1]);
      if (idx < 0) return sendJSON(res, 404, { error: "评论不存在" });
      const c = list[idx];
      if (m[2] === "like") {
        c.likedBy = c.likedBy || [];
        const i = c.likedBy.indexOf(user.email);
        if (i >= 0) { c.likedBy.splice(i, 1); c.likes = (c.likes || 0) - 1; }
        else { c.likedBy.push(user.email); c.likes = (c.likes || 0) + 1; }
        writeJSONAtomic(COMMENTS_FILE, list);
        return sendJSON(res, 200, { likes: c.likes, liked: c.likedBy.indexOf(user.email) >= 0 });
      }
      // 回复
      readBody(req, (body) => {
        let payload;
        try {
          payload = JSON.parse(body || "{}");
        } catch (e) {
          return sendWriteError(res, e);
        }
        if (payload && payload.__tooLarge) {
          return sendJSON(res, 413, { error: "内容过大：配图请控制在 3MB 以内" });
        }
        const text = String((payload && payload.content) || "").trim();
        const commitReply = function (imageUrl) {
          try {
            if (!text && !imageUrl) return sendJSON(res, 400, { error: "回复内容不能为空" });
            if (text.length > COMMENT_MAX_LEN) return sendJSON(res, 400, { error: "回复最长 " + COMMENT_MAX_LEN + " 字" });
            c.replies = c.replies || [];
            const reply = { id: crypto.randomBytes(4).toString("hex"), email: user.email, content: text, ts: new Date().toISOString(), image: imageUrl };
            c.replies.push(reply);
            writeJSONAtomic(COMMENTS_FILE, list);
            return sendJSON(res, 200, { replies: c.replies.map(function (r) {
              return { id: r.id, email: r.email, content: r.content, ts: r.ts, image: r.image || null };
            }) });
          } catch (e) {
            return sendWriteError(res, e);
          }
        };
        let img = null;
        try {
          img = parseCommentImage(payload && payload.image);
        } catch (ie) {
          return sendJSON(res, 400, { error: ie.message });
        }
        if (!img) return commitReply("");
        stripExif(img.buf, img.ext, function (_e, cleaned) {
          let url = "";
          try {
            url = saveCommentImage({ ext: img.ext, buf: cleaned || img.buf });
          } catch (se) {
            return sendWriteError(res, se, "图片保存失败");
          }
          return commitReply(url);
        });
      }, COMMENT_BODY_MAX_BYTES);
      return;
    }
  }

  // ===================== 用户认证 =====================
  // 注册（邮箱注册，无密码复杂度限制、无邮箱验证）
  if (pathname === "/api/register" && req.method === "POST") {
    if (rateLimited(res, "register", req)) return;
    readBody(req, (body) => {
      try {
        const { email, password } = JSON.parse(body || "{}");
        const em = String(email || "").trim().toLowerCase();
        if (!EMAIL_RE.test(em)) {
          return sendJSON(res, 400, { error: "邮箱格式不正确" });
        }
        if (password === undefined || password === null || String(password) === "") {
          return sendJSON(res, 400, { error: "密码不能为空" });
        }
        const users = loadUsers();
        if (users[em]) {
          return sendJSON(res, 409, { error: "该邮箱已注册，请直接登录" });
        }
        const salt = crypto.randomBytes(16).toString("hex");
        users[em] = {
          email: em,
          salt,
          hash: hashPassword(password, salt),
          created_at: new Date().toISOString(),
        };
        writeJSONAtomic(USERS_FILE, users);
        const token = crypto.randomBytes(24).toString("base64url");
        const sessions = loadSessions();
        sessions[token] = { email: em, created_at: new Date().toISOString() };
        writeJSONAtomic(SESSIONS_FILE, sessions);
        return sendJSON(res, 200, { token, user: { email: em, created_at: users[em].created_at } });
      } catch (e) {
        return sendWriteError(res, e);
      }
    });
    return;
  }

  // 登录
  if (pathname === "/api/login" && req.method === "POST") {
    if (rateLimited(res, "login", req)) return;
    readBody(req, (body) => {
      try {
        const { email, password } = JSON.parse(body || "{}");
        const em = String(email || "").trim().toLowerCase();
        const users = loadUsers();
        const u = users[em];
        if (!u || u.hash !== hashPassword(password || "", u.salt)) {
          return sendJSON(res, 401, { error: "邮箱或密码不正确" });
        }
        const token = crypto.randomBytes(24).toString("base64url");
        const sessions = loadSessions();
        sessions[token] = { email: em, created_at: new Date().toISOString() };
        writeJSONAtomic(SESSIONS_FILE, sessions);
        return sendJSON(res, 200, { token, user: { email: em, created_at: u.created_at } });
      } catch (e) {
        return sendWriteError(res, e);
      }
    });
    return;
  }

  // 登出
  if (pathname === "/api/logout" && req.method === "POST") {
    const token = getToken(req);
    if (token) {
      const sessions = loadSessions();
      delete sessions[token];
      writeJSONAtomic(SESSIONS_FILE, sessions);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // 当前用户
  if (pathname === "/api/me") {
    const user = getUserByToken(getToken(req));
    if (!user) return sendJSON(res, 401, { error: "未登录" });
    return sendJSON(res, 200, { user });
  }

  // 查询历史（登录后可见；train 记录附带预测 vs 实际对比）
  if (pathname === "/api/history" && req.method === "GET") {
    const user = getUserByToken(getToken(req));
    if (!user) return sendJSON(res, 401, { error: "未登录" });
    const list = (loadHistory()[user.email] || []).map(enrichHistory);
    return sendJSON(res, 200, { history: list });
  }

  // 回填某条车次预测历史的实际延误（懒回填：调 train_insight 拉近 8 天实际）
  if (pathname === "/api/history/backfill" && req.method === "POST") {
    const user = getUserByToken(getToken(req));
    if (!user) return sendJSON(res, 401, { error: "未登录" });
    readBody(req, (body) => {
      let id = "";
      try { id = String((JSON.parse(body || "{}").id) || ""); } catch (e) { id = ""; }
      if (!id) return sendJSON(res, 400, { error: "缺少参数 id" });
      const hist = loadHistory();
      const list = hist[user.email] || [];
      const idx = list.findIndex((r) => r.id === id);
      if (idx < 0) return sendJSON(res, 404, { error: "记录不存在" });
      const rec = list[idx];
      if (rec.type !== "train") {
        return sendJSON(res, 400, { error: "仅车次预测记录可回填实际延误" });
      }
      if (rec._backfilling) return sendJSON(res, 409, { error: "该条正在回填中" });
      rec._backfilling = true;
      writeJSONAtomic(HISTORY_FILE, hist);
      const child = spawn(PYTHON_BIN,
        [INSIGHT_SCRIPT, rec.train, "--days", "8"], { windowsHide: true });
      let stdout = "", stderr = "";
      const killTimer = setTimeout(() => child.kill(), 120000);
      const finish = (code, okData, errMsg) => {
        clearTimeout(killTimer);
        const h2 = loadHistory();
        const l2 = h2[user.email] || [];
        const i2 = l2.findIndex((r) => r.id === id);
        if (i2 >= 0) l2[i2]._backfilling = false;
        if (okData) {
          const days = (Array.isArray(okData.recent) ? okData.recent : []).map(function (r) {
            return { date: r.date,
                     end_delay: (r.end_delay != null ? r.end_delay : null) };
          });
          if (i2 >= 0) l2[i2].actual_days = days;
        }
        h2[user.email] = l2;
        writeJSONAtomic(HISTORY_FILE, h2);
        if (i2 >= 0) {
          return sendJSON(res, okData ? 200 : 502,
            okData ? { record: enrichHistory(l2[i2]) }
                   : { error: errMsg || ("回填失败(exit " + code + ")") });
        }
        return sendJSON(res, 404, { error: "记录不存在" });
      };
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("error", (err) => {
        finish(-1, null, "回填启动失败: " + err.message);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          return finish(code, null, "回填失败(exit " + code + "): " +
            (stderr || "").slice(0, 200));
        }
        try {
          const data = JSON.parse(stdout);
          if (data && data.error) return finish(code, null, data.error);
          return finish(code, data, "");
        } catch (e) {
          return finish(code, null, "回填输出解析失败");
        }
      });
    });
    return;
  }

  // 删除单条历史（?id=xxx）
  if (pathname === "/api/history" && req.method === "DELETE") {
    const user = getUserByToken(getToken(req));
    if (!user) return sendJSON(res, 401, { error: "未登录" });
    const id = parsed.query.id || "";
    if (!id) return sendJSON(res, 400, { error: "缺少参数 id" });
    const hist = loadHistory();
    const list = hist[user.email] || [];
    hist[user.email] = list.filter((r) => r.id !== id);
    writeJSONAtomic(HISTORY_FILE, hist);
    return sendJSON(res, 200, { ok: true });
  }

  // 访问人数统计：累计独立访客（按前端 visitorId 去重）
  if (pathname === "/api/visitors" && req.method === "GET") {
    return sendJSON(res, 200, { count: loadVisitors().count || 0 });
  }
  if (pathname === "/api/visitors" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const id = String((JSON.parse(body || "{}").id) || "").slice(0, 64).trim();
        if (!id) return sendJSON(res, 400, { error: "缺少 id" });
        const v = loadVisitors();
        const now = Date.now();
        const TTL = 365 * 86400000; // 仅用于限制 ids 体积，count 保持单调累计
        for (const k of Object.keys(v.ids)) {
          if (now - (v.ids[k] || 0) > TTL) delete v.ids[k];
        }
        if (!(id in v.ids)) {
          v.ids[id] = now;
          v.count = (v.count || 0) + 1;
        }
        saveVisitors(v);
        return sendJSON(res, 200, { count: v.count });
      } catch (e) {
        return sendWriteError(res, e);
      }
    });
    return;
  }

  // 保存预测快照（分享）
  if (pathname === "/api/share" && req.method === "POST") {
    if (rateLimited(res, "share_post", req)) return;
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2 * 1024 * 1024) req.destroy(); // 防超限
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const data = payload.data;
        if (!data || !data.train) {
          return sendJSON(res, 400, { error: "缺少预测数据 data.train" });
        }
        const rec = saveShare(data);
        return sendJSON(res, 200, {
          id: rec.id,
          url: `/?share=${rec.id}`,
          created_at: rec.created_at,
          train: rec.train,
        });
      } catch (e) {
        return sendWriteError(res, e);
      }
    });
    return;
  }

  // 读取预测快照（分享链接加载）
  if (pathname.startsWith("/api/share/")) {
    const id = pathname.slice("/api/share/".length);
    const rec = loadShare(id);
    if (!rec) {
      return sendJSON(res, 404, { error: "分享不存在或已过期" });
    }
    return sendJSON(res, 200, { id: rec.id, created_at: rec.created_at,
                                train: rec.train, data: rec.data });
  }

  // 评论配图静态服务：仅限 COMMENT_IMG_DIR 下、经服务端命名的安全文件名
  if (pathname.startsWith("/comment_images/")) {
    const file = pathname.slice("/comment_images/".length);
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes("..")) {
      res.writeHead(400); return res.end("Bad Request");
    }
    fs.readFile(path.join(COMMENT_IMG_DIR, file), (err, data) => {
      if (err) { res.writeHead(404); return res.end("404 Not Found"); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(data);
    });
    return;
  }

  return serveStatic(req, res, pathname);
}

pruneShares();
loadTimetable();
buildStationRegionMap();
try { fs.mkdirSync(COMMENT_IMG_DIR, { recursive: true }); } catch (e) {}

// ---- 热门车次预热（P0：降冷启动首访等待）----
// 问题：/api/train 每次冷车次 spawn python，需重载 21MB 模型 + 131MB train_hist
//      + 两次网络抓取（逐天 sleep），冷启动 14~86s。
// 方案：启动后 + 每日 04:30 串行预热热门车次，把结果写进磁盘缓存
//      （与用户请求同一份 data/cache/train/<sha1>.json），用户首访即命中
//      X-Cache: DISK（0 spawn、毫秒级）。预热只写磁盘、不占 memo。
// 注：本块置于文件末尾，确保 spawn/INSIGHT_SCRIPT/predictionCacheKey/
//      safeJsonParse 等全部已定义（虽在延迟回调中执行，仍消除 TDZ 隐患）。
const WARMUP_SEEDS = ["ICE 578", "ICE 847", "ICE 100", "RE 11", "RE 1", "RB 36"];
const WARMUP_MAX = 8;            // 单轮最多预热的车次数
const WARMUP_INTERVAL_MS = 5000; // 每趟间隔，避免抢 zugfinder 限流 / CPU
// 启动预热的可用内存下限。2026-09-14 常驻化后重测（原值 5000）：
//   常驻 worker 稳态 RssAnon 3.5~3.8GB（预热完成即 2.58GB，首次真实预测后
//   一次性 +941MB 常驻，随后在 3.5~3.8GB 波动，不再持续增长 → 无泄漏）。
//   叠加 cgroup 里其他常驻（sandbox-proxy ~0.8GB、node ~0.4GB、定时抓取 ~0.24GB），
//   8GB 限额下的安全余量其实很薄：实测 worker 4.1GB 时 cgroup 已 7.6/8.0GB。
// 因此下限提到 6000MB —— 宁可跳过预热（用户首次查询慢一次），也不要预热到一半
// 被 OOM 清掉（那会把已经跑起来的常驻进程一并带走，恢复代价大得多）。
// 可用 WARMUP_MEM_MIN_MB 覆盖：部署到更大内存机器时应下调或关闭，否则永不预热。
const WARMUP_MEM_MIN_MB = (() => {
  const v = parseInt(process.env.WARMUP_MEM_MIN_MB, 10);
  return Number.isFinite(v) && v >= 0 ? v : 6000;
})();
let _warmupRunning = false;

// 可用内存探测：优先 cgroup v2 限额，其次 /proc/meminfo。
// 返回 {availMB, limitMB}；探测失败时返回 null（调用方按“可用”处理，不误伤正常环境）。
function probeMemoryMB() {
  const out = { availMB: null, limitMB: null, usedMB: null };
  try {
    const lim = parseInt(fs.readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim(), 10);
    const cur = parseInt(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf-8").trim(), 10);
    if (Number.isFinite(lim) && Number.isFinite(cur)) {
      out.limitMB = Math.round(lim / 1048576);
      out.usedMB = Math.round(cur / 1048576);
      out.availMB = Math.round((lim - cur) / 1048576);
    }
  } catch (_) {}
  if (out.availMB === null) {
    try {
      const mi = fs.readFileSync("/proc/meminfo", "utf-8");
      const m = mi.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (m) out.availMB = Math.round(parseInt(m[1], 10) / 1024);
    } catch (_) {}
  }
  return out.availMB === null ? null : out;
}

function hasMemoryForWarmup() {
  const info = probeMemoryMB();
  if (!info || info.availMB === null) return true; // 探测不到 → 不阻断
  // 有 cgroup 限额时要求“限额 - 已用”留够余量；否则看系统可用内存
  const budget = info.availMB;
  return budget >= WARMUP_MEM_MIN_MB;
}

function collectHotTrains() {
  // 来源三合一：① history.json 的车次频次 ② 现有磁盘缓存反解 _query ③ 种子
  const freq = new Map(); // "TRAIN(大写,单空格)" -> 权重
  const bump = (t, n) => {
    const key = String(t || "").toUpperCase().replace(/_/g, " ")
      .replace(/\s+/g, " ").trim();
    if (!key) return;
    freq.set(key, (freq.get(key) || 0) + n);
  };
  // ① history.json：{ email: [ {type:'train', train:'ICE 578', ...}, ... ] }
  try {
    const hist = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "history.json"), "utf-8"));
    for (const arr of Object.values(hist || {})) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr) if (it && it.type === "train" && it.train) bump(it.train, 1);
    }
  } catch (_) {}
  // ② 现有磁盘缓存：反解 data._query.train（已被查过 → 加权）
  try {
    for (const f of fs.readdirSync(TRAIN_DISK_CACHE_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(fs.readFileSync(path.join(TRAIN_DISK_CACHE_DIR, f), "utf-8"));
        const t = e && e.data && e.data._query && e.data._query.train;
        if (t) bump(t, 2);
      } catch (_) {}
    }
  } catch (_) {}
  // ③ 种子（保底）
  for (const s of WARMUP_SEEDS) bump(s, 1);
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, WARMUP_MAX)
    .map((x) => x[0]);
}

function warmupOneTrain(train) {
  // ⚠️ 关键：predictDate 必须与「用户实际请求」一致，否则预热白做。
  // 前端 predictDateISO() 默认 "tomorrow" → 总会带上具体日期（如 2026-09-16），
  // 而 date 是 predictionCacheKey 的一部分。历史上这里写死 ""，导致：
  //   预热 key: {...,"date":""}          用户 key: {...,"date":"2026-09-16"}
  // 两者永不相等 → 预热写下的缓存 100% 命中不了，等于每天白跑一轮抓取。
  // 这里复刻前端的默认语义（明天），让预热的 key 与用户请求严格对齐。
  const predictDate = berlinDateOffset(1);
  const cacheParams = { train, days: 8, predictDate, destination: "",
                        rideFrom: "", rideTo: "", rideTime: "" };
  const key = predictionCacheKey(cacheParams);
  if (getTrainDiskCache(key)) {
    console.log("[warmup] hit  " + train);
    return Promise.resolve("hit");
  }
  return new Promise((resolve) => {
    const args = [INSIGHT_SCRIPT, train, "--days", "8", "--date", predictDate];
    const env = Object.assign({}, process.env);
    if (LOCAL_PRO_DIR && !env.ZUGFINDER_PRO_DIR) env.ZUGFINDER_PRO_DIR = LOCAL_PRO_DIR;
    const child = spawn(PYTHON_BIN, args, { env, windowsHide: true });
    let stdout = "";
    const killTimer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 120000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      console.warn("[warmup] err  " + train + ": " + err.message);
      resolve("err");
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) { console.warn("[warmup] exit " + train + " code=" + code); return resolve("exit"); }
      try {
        const data = safeJsonParse(stdout);
        if (!data || data.error) { console.warn("[warmup] bad  " + train); return resolve("bad"); }
        // _query 也要与 key 一致（date 同上），否则 /api/breakdown 回放会错位
        data._query = { train, days: 8, date: predictDate, destination: "",
                        ride_from: "", ride_to: "", ride_time: "" };
        setTrainDiskCache(key, data);
        console.log("[warmup] ok   " + train + " (date=" + predictDate + ")");
        resolve("ok");
      } catch (_) { resolve("parse_err"); }
    });
  });
}

async function runWarmup() {
  if (_warmupRunning) return;
  _warmupRunning = true;
  // 内存门禁：train_insight 单进程峰值 RSS ~3.4GB。若容器/机器内存紧张，
  // 串行预热会把预算打满并触发 OOM kill（表现为用户请求 502 + 残留僵尸进程）。
  // 因此在每轮开始前检查可用内存，不足则跳过本轮（预热是优化，绝不能拖垮主链路）。
  if (!hasMemoryForWarmup()) {
    console.warn("[warmup] 跳过本轮：可用内存不足 " + WARMUP_MEM_MIN_MB + "MB");
    _warmupRunning = false;
    return;
  }
  const _mem = probeMemoryMB();
  const list = collectHotTrains();
  console.log("[warmup] start, " + list.length + " trains: " + list.join(", ") +
    (_mem && _mem.availMB !== null ? "（可用内存 " + _mem.availMB + "MB）" : ""));
  for (const t of list) {
    // 每趟前复查：前面几趟可能已把内存吃掉 → 及时收手，避免触发 OOM
    if (!hasMemoryForWarmup()) {
      console.warn("[warmup] 提前中止：" + t + " 之前可用内存已低于 " + WARMUP_MEM_MIN_MB + "MB");
      break;
    }
    try { await warmupOneTrain(t); } catch (e) { console.warn("[warmup] fail " + t + ": " + e.message); }
    await new Promise((r) => setTimeout(r, WARMUP_INTERVAL_MS));
  }
  _warmupRunning = false;
  console.log("[warmup] done");
}

// 预热调度：启动 30s 后跑一轮，之后靠「跨天检测」触发（不再用固定时刻定时器）。
// 开关：WARMUP_DISABLED=1 时完全关闭（低内存环境必备 —— train_insight 单进程峰值
// RSS ~3.4GB，串行预热在内存受限容器里会把 cgroup 预算打满并触发 OOM kill）。
const WARMUP_DISABLED = String(process.env.WARMUP_DISABLED || "") === "1";
if (WARMUP_DISABLED) {
  console.log("[warmup] 已通过 WARMUP_DISABLED=1 关闭");
} else {
setTimeout(() => { runWarmup(); }, 30000).unref();
// 每日调度：以「柏林日期变化」为唯一触发源，不再用固定 04:30 定时器。
// 原 04:30 方案有两个问题：
//   ① 空窗 —— 0:00~4:30 之间昨天的缓存已失效、新预热未跑，早班查询全冷抓；
//   ② 漂移 —— setInterval(24h) 会累积误差，且容器休眠期间不触发。
// 改为 60s 轮询检测跨天，跨天即刻预热，空窗压到 ≤60s 且能自愈。
let _lastWarmupDay = berlinToday();
setInterval(() => {
  const d = berlinToday();
  if (d !== _lastWarmupDay) {
    _lastWarmupDay = d;
    console.log("[warmup] 检测到跨天（" + d + "），触发当日预热");
    runWarmup();
  }
}, 60 * 1000).unref();
}

server.listen(PORT, () => {
  console.log(`列车晚点 webapp 已启动: http://localhost:${PORT}`);
  console.log(`示例: http://localhost:${PORT}/?train=ICE%20578`);
  cleanTrainDiskCache(); // 启动即清一次非当日预测缓存（次日自动失效的另一半）
});
