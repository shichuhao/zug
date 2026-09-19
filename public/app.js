const trainInput = document.getElementById("trainInput");
const trainType = document.getElementById("trainType");
const trainSuggest = document.getElementById("trainSuggest");
const predictDateEl = document.getElementById("predictDate");
const searchBtn = document.getElementById("searchBtn");

// 预测日期 → ISO
function predictDateISO() {
  const v = (predictDateEl.value || "tomorrow");
  const days = { today: 0, tomorrow: 1, day2: 2, day3: 3, day4: 4, day5: 5 }[v];
  if (days === undefined) return "";
  const d = new Date();
  d.setDate(d.getDate() + days);
  // 用本地日期组件拼（不用 toISOString，避免凌晨本地已是 08-21 但 UTC 还是 08-20 的错位）
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + da;
}

// 预测日期 → 卡片标签文本（随 predictDate select 变化）
function predictDateLabel() {
  const v = (predictDateEl.value || "tomorrow");
  return ({
    today: t("date.today"),
    tomorrow: t("date.tomorrow"),
    day2: t("date.day2"),
    day3: t("date.day3"),
    day4: t("date.day4"),
    day5: t("date.day5"),
  })[v] || t("date.tomorrow");
}
const statusEl = document.getElementById("status");
const statusMessage = document.getElementById("statusMessage");
const statusRetryBtn = document.getElementById("statusRetryBtn");
const predictEl = document.getElementById("predict");
const resultsEl = document.getElementById("results");
const metaTrain = document.getElementById("metaTrain");
const metaCount = document.getElementById("metaCount");
const rowsEl = document.getElementById("rows");
const shareBtn = document.getElementById("shareBtn");
const shareTip = document.getElementById("shareTip");
// 站对站查询
const fromInput = document.getElementById("fromInput");
const toInput = document.getElementById("toInput");
const stationList = document.getElementById("stationList");
const serviceResults = document.getElementById("serviceResults");
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
// 主查询（search 走 /api/train 直查）:后端冷缓存现算可达 ~40s(叠加 zugfinder 限流更久;
// 线路复用号修复新增 PieBro 模板对齐 +2~5s),60s 会在冷查询边缘静默超时,
// 回退旧模拟接口导致空 stations 页——放宽到 90s(缓存热时 <1s,不受影响)
// 2026-09-14 QA：后端 python 超时预算已放宽到 150s（慢网络下 90s 会误杀），
// 前端必须高于后端，否则后端还在算、前端已先超时降级 → 白白浪费一次冷计算。
const MAIN_REQUEST_TIMEOUT_MS = 160000;
let activeSearchController = null;
const QUERY_DRAFT_STORAGE_KEY = "train-delay-query-draft-v1";
const ROUTE_TYPES = ["RE", "RB", "IC", "ICE", "FLX"];
const journeyUrlInput = document.getElementById("journeyUrlInput");
const journeyTextInput = document.getElementById("journeyTextInput");
const journeyPredictBtn = document.getElementById("journeyPredictBtn");
const journeyStatus = document.getElementById("journeyStatus");
const journeyResult = document.getElementById("journeyResult");
let lastJourney = null;

function journeyMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
// 换乘缓冲：到点 → 下段发车；支持跨午夜（如 23:50 → 00:15 = 25 分钟）
function journeyBuffer(arrival, departure) {
  const a = journeyMinutes(arrival), d = journeyMinutes(departure);
  if (a == null || d == null) return null;
  return d >= a ? d - a : d + 1440 - a;
}
function journeyTextLegs(text) {
  const out = [];
  const source = String(text || "").replace(/\r/g, "").replace(/\u00a0/g, " ");
  // <input type="url"> strips line breaks from pasted text, so anchors must
  // also accept plain whitespace (single-line folded paste).
  const titleRe = /(?:^|\n|\s)((?:ICE|IC|EC|RE|RB|IR|S|U|TGV|NJ|FlixTrain)\s*\d+(?:\s*\([^\n)]*\))?)\s*(?=\n|$|\s)/gim;
  const titles = Array.from(source.matchAll(titleRe));
  function station(value) {
    return value
      .replace(/\s+(?:View\s+journey|https?:\/\/\S+).*$/i, "")
      .replace(/,?\s*Platform\s*\S+\s*$/i, "").trim();
  }
  for (let i = 0; i < titles.length; i++) {
    const block = source.slice(titles[i].index + titles[i][0].lastIndexOf(titles[i][1]), titles[i + 1] ? titles[i + 1].index : source.length);
    const m = block.match(/From\s+(\d{1,2}:\d{2})\s+([\s\S]+?)\s*\bTo\s+(\d{1,2}:\d{2})\s+([^\n]+)/i);
    if (m) {
      out.push({ service: titles[i][1].replace(/\s+/g, " ").trim(), from: station(m[2]), dep: m[1], to: station(m[4]), arr: m[3] });
    }
  }
  return out;
}
function journeyTextDate(text) {
  const m = String(text || "").match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
  return m ? m[3] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0") : "";
}
function journeyPercent(v) {
  return v == null || !Number.isFinite(Number(v)) ? t("journey.noData") : Math.round(Math.min(1, Math.max(0, Number(v))) * 100) + "%";
}
// 从异常中提取「可映射的 key」：优先 message，其次 code（fetchJSON 对网络/超时
// 等失败只设 code，message 为空 —— 此时 String(err) 会退化成 "Error"）。
function errorMessageKey(error) {
  if (error == null) return "";
  const msg = error && error.message ? String(error.message).trim() : "";
  if (msg) return msg;
  const code = error && error.code ? String(error.code).trim() : "";
  if (code === "timeout") return "E_TIMEOUT";
  if (code === "network" || code === "invalid_response" || code === "http_server") return "";
  // 兜底：非空 code 直接返回（可被 localErrStr/SERVER_ERR_CODES 命中）
  return code;
}
function journeyErrorMessage(error) {
  // 注意：fetchJSON 在「网络失败 / 超时 / 非 JSON 响应」等路径抛的是
  // **无 message 的 Error**（见 fetchJSON 的 new Error()），此时
  // String(err) 得到的是字面量 "Error" 或空串 —— 直接交给下方映射会显示
  // 无意义的「Error」。先在源头识别并归入网络类提示。
  const key = errorMessageKey(error);
  if (!key || key === "Error") return t("err.networkUnavailable");
  // journey 专属业务码：语义明确，有专属引导文案
  if (key === "journey_db_link_requires_text") return t("journey.dbLinkHint");
  if (key === "journey_db_link_open_required") return t("journey.dbOpenHint");
  // 链接被 bahnapp 侧风控拒绝（服务器 IP 被封，与用户输入的链接无关）：
  // 明确告知并直接引导改用文本粘贴，而不是含糊的「无法解析」。
  if (key === "journey_source_blocked") return t("journey.sourceBlocked");
  if (key === "journey_link_expired") return t("journey.linkExpired");
  if (key === "journey_parse_failed") return t("journey.parseFailed");
  // 其余（E_ 稳定码 / 中文原文 / 未知）：统一走既有的本地化机制。
  // localErrStr 先查 SERVER_ERR_CODES（E_ 码）→ SERVER_ERR_MAP（中文串，最长前缀）
  // → 含中文兜底为 err.generic。绝不再裸返中文原文。
  const localized = localErrStr(key);
  return localized || t("journey.failed");
}
function showJourneyDbOpenHint(url) {
  journeyStatus.innerHTML = escapeHtml(t("journey.dbOpenHint")) + ' <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t("journey.openDb")) + '</a>';
  journeyStatus.className = "status error";
}
function journeyPredictionUrl(leg, date) {
  // DB's pasted text may show e.g. "RE1 (73718)". Query the line prefix
  // (RE1), not the parenthesized internal train number.
  let service = String(leg.service || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (/^(?:BUS|S|U)\b/i.test(service)) return null;
  // DB's fahrplan hash stores regional trains as bare operating numbers
  // (e.g. 62035, 4300); Zugfinder expects their RE_ prefixed identifiers.
  if (/^\d+$/.test(service)) service = "RE " + service;
  const q = "/api/train?train=" + encodeURIComponent(service) + "&days=8&date=" + encodeURIComponent(date || "") + "&destination=" + encodeURIComponent(leg.to) + "&ride_from=" + encodeURIComponent(leg.from) + "&ride_to=" + encodeURIComponent(leg.to);
  return q;
}
async function predictJourney(legs, dateHint, signal) {
  const date = dateHint || (journeyUrlInput.value.match(/202\d-[01]\d-[0-3]\d/) || [""])[0];
  // 并发上限 2（2026-09-19 修复「Keine Daten / 无数据」满屏）。
  // 背景：worker 的并发上限是 1（PREDICTOR_MAX_CONCURRENCY=1，实测结论）。
  // 之前这里把 N 段全部 Promise.all 发出去 —— 1 段占住闸门跑 20~30s，其余
  // 立刻吃 503 worker_busy，页面上就是一条接一条的「无数据」。
  // 现在最多同时 2 个在途：一个在算、一个在服务端闸门排队（server 侧有
  // 行程腿串行队列），既不让请求白白被拒，又不会把栈堆到超时。
  const CONCURRENCY = 2;
  const predictions = new Array(legs.length);
  let nextIdx = 0;
  const worker = async function () {
    while (true) {
      const i = nextIdx++;
      if (i >= legs.length) return;
      const leg = legs[i];
      if (!journeyPredictionUrl(leg, date)) { predictions[i] = { error: "unsupported_service" }; continue; }
      try {
        // 超时给到 180s：服务端排队是串行的（worker 并发上限 1），单段最坏
        // 30s 计算 + 前面几段排队累计，原先 35s 会让「排到了但还在算」的请求
        // 被前端自己掐掉，用户看到的就是满屏「无数据」而不是「超时」。
        // 服务端有 120s 的 worker 超时兜底，这里给足余量等它给出明确答复。
        predictions[i] = await fetchJSON(journeyPredictionUrl(leg, date), { timeout: 180000, signal: signal });
      } catch (e) {
        if (e && (e.name === "AbortError" || String(e).indexOf("AbortError") >= 0)) throw e; // 切页中止，静默
        predictions[i] = { error: queryTransportError(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, legs.length) }, worker));
  const cards = predictions.map(function (p, i) {
    const leg = legs[i], x = (p && p.prediction) || {}, seg = (p && p.segment) || {};
    const point = x.point_estimate != null ? x.point_estimate : seg.point_estimate;
    const p90 = x.p90 != null ? x.p90 : seg.p90;
    return { leg, prediction: p || {}, point, p90, risk: x.prob_ge15 != null ? x.prob_ge15 : seg.prob_ge15 };
  });
  lastJourney = { legs: legs, date: date, cards: cards };
  const html = '<div class="journey-summary"><strong>' + escapeHtml(legs[0].from) + ' → ' + escapeHtml(legs[legs.length - 1].to) + '</strong><span>' + t("journey.summary", { n: legs.length }) + '</span></div>' + cards.map(function (c, i) {
    const next = legs[i + 1];
    const buffer = next ? journeyBuffer(c.leg.arr, next.dep) : null;
    // 「无数据」分三种，别混成一个：
    //   1) 该次查询本身失败（繁忙/超时/网络）→ 展示具体原因，不是「无数据」
    //   2) 查询成功但这一段的区间确实没有历史样本 → 真正的无数据
    //   3) 非支持的车型（S/U/Bus）→ 明确说明不支持
    const failed = c.prediction && c.prediction.error && c.prediction.error !== "unsupported_service";
    const delay = c.prediction.error === "unsupported_service"
      ? t("journey.unsupported")
      : (failed ? String(c.prediction.error)
        : (c.point == null ? t("journey.noData") : "+" + Math.round(c.point) + " " + t("unit.min")));
    const risk = journeyPercent(c.risk);
    let connection = "";
    if (next && buffer != null) {
      const miss = c.risk == null ? null : Math.min(0.95, Math.max(0.02, c.risk * (buffer <= 8 ? 1.3 : buffer <= 15 ? .65 : .25)));
      connection = '<div class="journey-connection"><span>↳ ' + t("journey.connection", { train: escapeHtml(next.service), min: buffer }) + '</span><strong class="' + (miss != null && miss > .35 ? 'journey-warn' : '') + '">' + t("journey.catchProbability", { probability: journeyPercent(miss == null ? null : 1 - miss) }) + '</strong></div>';
    }
    return '<article class="journey-leg"><div class="journey-leg-main"><span class="journey-service">' + escapeHtml(c.leg.service) + '</span><span class="journey-times">' + escapeHtml(c.leg.dep) + ' → ' + escapeHtml(c.leg.arr) + '</span><span class="journey-stations">' + escapeHtml(c.leg.from) + ' → ' + escapeHtml(c.leg.to) + '</span></div><div class="journey-risk"><b>' + delay + '</b><span>' + t("journey.delayRisk", { probability: risk }) + '</span></div></article>' + connection;
  }).join("") + '<p class="journey-note">' + t("journey.note") + '</p>';
  journeyResult.innerHTML = html;
  journeyResult.classList.remove("hidden");
  updateShareVisibility();
}
var activeJourneyController = null; // 行程分析请求（切页时中止）
if (journeyPredictBtn) journeyPredictBtn.addEventListener("click", async function () {
  const url = (journeyUrlInput.value || "").trim();
  // Users often paste the complete DB Navigator share text into the first
  // field, including the final "View journey" URL. Treat that as text rather
  // than sending the whole multiline value to the URL parser.
  const inlineText = /(?:^|\n|\s)(?:ICE|IC|EC|RE|RB|IR|S|U|TGV|NJ|FlixTrain)\s*\d+/i.test(url) && /\bFrom\s+\d{1,2}:\d{2}\s+/i.test(url);
  const textSource = inlineText ? url : (journeyTextInput.value || "");
  journeyStatus.className = "status hidden";
  journeyResult.classList.add("hidden");
  journeyPredictBtn.disabled = true;
  const controller = new AbortController();
  activeJourneyController = controller;
  try {
    let parsed;
    if (url && !inlineText) {
      try { parsed = await fetchJSON("/api/journey/parse?url=" + encodeURIComponent(url), { timeout: 20000, signal: controller.signal }); }
      catch (linkError) {
        if (linkError && linkError.name === "AbortError") throw linkError; // 切页中止，静默
        // Keep the text fallback usable when a share page is temporarily offline.
        if (!textSource.trim()) {
          const linkErrorKey = String(linkError && linkError.message || linkError || "");
          if (linkErrorKey === "journey_db_link_open_required") showJourneyDbOpenHint(url);
          else throw new Error(journeyErrorMessage(linkError));
          return;
        }
      }
    }
    const textLegs = journeyTextLegs(textSource);
    // The pasted DB text contains vehicle types (RE1/RB40/...), while the
    // hash only contains numeric train IDs. Prefer the richer text form.
    const legs = textLegs.length ? textLegs : (parsed && parsed.legs && parsed.legs.length ? parsed.legs : []);
    if (!legs.length) throw new Error(t("journey.noLegs"));
    // 评论区/分享归属：行程栏跟随本次行程（起→终）
    journeyCtx = { from: legs[0].from, to: legs[legs.length - 1].to };
    loadComments();
    journeyStatus.textContent = t("journey.predicting", { n: legs.length });
    journeyStatus.className = "status";
    await predictJourney(legs, (parsed && parsed.date) || journeyTextDate(textSource), controller.signal);
    journeyStatus.className = "status hidden";
  } catch (e) {
    if (e && (e.name === "AbortError" || String(e).indexOf("AbortError") >= 0)) {
      // 页面切换触发的主动中止：不留错误横幅
    } else if (String(e && e.message || e) === "journey_db_link_open_required") showJourneyDbOpenHint(url);
    else { journeyStatus.textContent = journeyErrorMessage(e) || t("journey.failed"); journeyStatus.className = "status error"; }
  }
  finally {
    if (activeJourneyController === controller) activeJourneyController = null;
    journeyPredictBtn.disabled = false;
  }
});

function saveQueryDraft() {
  try {
    sessionStorage.setItem(QUERY_DRAFT_STORAGE_KEY, JSON.stringify({
      train: trainInput.value,
      trainType: trainType.value,
      predictDate: predictDateEl.value,
      from: fromInput.value,
      to: toInput.value,
      routeDelayTrain: (document.getElementById("routeDelayTrain") || {}).value || "",
    }));
  } catch (_) { /* Storage may be unavailable in private contexts. */ }
}

function restoreQueryDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(QUERY_DRAFT_STORAGE_KEY) || "null");
    if (!draft || typeof draft !== "object") return;
    trainInput.value = typeof draft.train === "string" ? draft.train : "";
    if (trainInput._syncTrainClear) trainInput._syncTrainClear();
    trainType.value = typeof draft.trainType === "string" ? draft.trainType : "";
    if (draft.predictDate && Array.from(predictDateEl.options).some(function (option) { return option.value === draft.predictDate; })) {
      predictDateEl.value = draft.predictDate;
    }
    fromInput.value = typeof draft.from === "string" ? draft.from : "";
    toInput.value = typeof draft.to === "string" ? draft.to : "";
    if (typeof draft.routeDelayTrain === "string") {
      var _rdTrainEl = document.getElementById("routeDelayTrain");
      if (_rdTrainEl) { _rdTrainEl.value = draft.routeDelayTrain; if (_rdTrainEl._syncTrainClear) _rdTrainEl._syncTrainClear(); }
    }
    syncStationClears(); // 草稿还原为程序化赋值，同步 × 显隐
  } catch (_) { /* Ignore malformed or unavailable session storage. */ }
}

// 线路号前缀集合（用于自动收窄查车次车型过滤）
const LINE_PREFIXES = ['RE', 'RB', 'IC', 'ICE', 'FLX', 'FEX'];
function detectLinePrefix(lineStr) {
  const s = (lineStr || '').trim().toUpperCase().replace(/[\s.-]/g, '');
  for (const p of LINE_PREFIXES) if (s.startsWith(p)) return p;
  return null;
}
// 输入容错：清理用户不合理的输入
function sanitizeTrain(raw) {
  let s = (raw || "").trim();
  // 全角→半角
  s = s.replace(/\u3000/g, " ").replace(/[\uff01-\uff5e]/g,
    function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); });
  // 多空格/制表符→单个空格
  s = s.replace(/[\s\t]+/g, " ").trim();
  // 去除首尾垃圾符号（括号、斜杠、井号等）
  s = s.replace(/^[#\/\\([{\s]+/, "").replace(/[)\]}\s]+$/, "");
  return s;
}

function sanitizeStation(raw) {
  let s = (raw || "").trim();
  s = s.replace(/\u3000/g, " ");
  s = s.replace(/[\s\t]+/g, " ").trim();
  return s;
}

// 拆分车次字符串为 { type, num }（与 server.js::splitTrainLine 保持一致；
// 归一化同时去空格/点/连字符/下划线——"RE_74423" / "RE-74423" / "RE 74423" → RE74423）
function splitTrainLine(s) {
  const n = (sanitizeTrain(s) || '').toUpperCase().replace(/[\s._-]/g, '');
  for (const pre of ['ICE', 'FLX', 'RE', 'RB', 'IC']) {
    if (n.startsWith(pre)) return { type: pre, num: n.slice(pre.length) };
  }
  return { type: '', num: n };
}

let chart10d = null;
let chartStations = null;
let chart10dMetric = "end"; // 最近10天图指标：segment/end/max/station
let chart10dUserPicked = false; // 用户手动点过指标按钮后不再自动切回区间视图
let todayDayIdx = -1;       // 逐站表当前选中天（-1=默认最近一天）
let searchGeneration = 0;   // 忽略晚到的旧查询响应，防止其覆盖当前结果
// 最近一次 /api/train 请求上下文（predictDate 变化时自动重查）
let lastQuery = null;
let currentData = null; // 最近一次预测结果（供分享）
let pendingRetryAction = null; // 自定义重试回调（如 breakdown 懒加载失败）

// showStatus(msg, isError, canRetry, opts)
//   opts.retryAction: 自定义重试回调（默认 rerunQuery，重放主预测）
//   opts.keepResult : 保留已渲染的预测区（超时降级——不把已有结果抹掉）
// 超时降级：当本页已展示过预测数据（currentData）时，报错不再隐藏 predict 区，
// 用户仍可查看上一次结果，仅顶部出现「数据加载较慢 / 可重试」提示。
function showStatus(msg, isError, canRetry, opts) {
  var o = opts || {};
  statusMessage.textContent = msg;
  statusEl.className = "status" + (isError ? " error" : "");
  statusRetryBtn.classList.toggle("hidden", !canRetry || !(lastQuery || o.retryAction));
  statusRetryBtn.disabled = false;
  pendingRetryAction = (canRetry && o.retryAction) ? o.retryAction : null;
  var keep = o.keepResult === true || (isError && currentData && o.keepResult !== false);
  if (!keep) {
    predictEl.classList.add("hidden");
    resultsEl.classList.add("hidden");
  }
}
function hideStatus() {
  statusEl.className = "status hidden";
  statusRetryBtn.classList.add("hidden");
  pendingRetryAction = null;
}
function queryTransportError(err) {
  if (err && err.code === "timeout") return t("err.requestTimeout");
  if (err && err.code === "invalid_response") return t("err.invalidResponse");
  if (err && err.code === "http_rate_limited") return t("err.rateLimited");
  // 先判 retryable：闸门满（worker/spawn）是「忙」不是「坏」，要明确告知稍后重试
  if (err && err.retryable && err.code === "http_server") return t("err.busyRetry");
  if (err && err.code === "http_server") return t("err.serviceUnavailable");
  if (err && err.code === "http_error") return t("err.httpError", { status: err.status });
  return t("err.networkUnavailable");
}

function copyText(text) {
  // 兼容 http（无 clipboard API）与 https/localhost；resolve(是否真正复制成功)
  // BUG FIX (2026-09-09)：旧版无论成败恒 resolve——iOS Safari 在无手势上下文
  // （如弹层打开后的 requestAnimationFrame）里 clipboard.writeText 与
  // execCommand("copy") 都会被拒，用户看到「已复制」但剪贴板是空的。
  return new Promise((resolve) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => resolve(true), () => fallbackCopy(text, resolve));
    } else {
      fallbackCopy(text, resolve);
    }
  });
}
function fallbackCopy(text, done) {
  let ok = false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand("copy");
    document.body.removeChild(ta);
  } catch (_) { ok = false; }
  done(ok === true);
}

function showShareTip(msg, ok, link) {
  // 内容区域 + 关闭按钮（每次重建以避免上次残留 class 影响 ok/err 样式）
  shareTip.innerHTML =
    '<span class="msg"></span>' +
    '<button class="close-btn" type="button" aria-label="' + escapeHtml(t("btn.close")) + '">×</button>';
  const msgEl = shareTip.querySelector(".msg");
  msgEl.textContent = msg;
  // 可选行动链接（图片保存 / 长按复制）：部分手机内核不支持 navigator.share、
  // 剪贴板又被拦，此时必须给出一个「可点击/可长按」的图片入口，否则用户只看到
  // 「图片已生成」却无从保存（2026-09-13 用户反馈）。
  // download 属性在多数移动浏览器会被忽略 → 点击仍会打开图片，长按可保存。
  if (link && link.href) {
    const a = document.createElement("a");
    a.className = "share-tip-link";
    a.href = link.href;
    a.textContent = link.text || t("share.imgDownload");
    a.setAttribute("download", link.filename || "train-delay.png");
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
    msgEl.appendChild(document.createTextNode(" "));
    msgEl.appendChild(a);
    shareTip.className = "share-tip" + (ok ? " ok" : " err");
    clearTimeout(showShareTip._t);
    // 带链接时停留久一些（用户需要时间看到并点击）
    requestAnimationFrame(function () { shareTip.classList.remove("hidden"); });
    showShareTip._t = setTimeout(hideShareTip, 15000);
    shareTip.querySelector(".close-btn").addEventListener("click", hideShareTip);
    return;
  }
  shareTip.className = "share-tip" + (ok ? " ok" : " err");
  shareTip.querySelector(".close-btn").addEventListener("click", hideShareTip);
  requestAnimationFrame(function () {
    shareTip.classList.remove("hidden");
  });
  clearTimeout(showShareTip._t);
  showShareTip._t = setTimeout(hideShareTip, 5000);
}
function hideShareTip() {
  shareTip.classList.add("hidden");
  clearTimeout(showShareTip._t);
}

shareBtn.addEventListener("click", async () => {
  const trigger = document.activeElement;
  // 分栏独立分享：route/journey 栏分享各自的查询结果（参数链接）
  if (currentView === "route" || currentView === "journey") {
    if (!currentShareTarget()) return;
    shareBtn.disabled = true;
    shareBtn.textContent = t("share.generating");
    try {
      if (currentView === "route") await shareRoute(trigger);
      else await shareJourney(trigger);
    } catch (e) {
      showShareTip(t("share.fail", { msg: e.message }), false);
    } finally {
      shareBtn.disabled = false;
      shareBtn.textContent = t("share.btn");
    }
    return;
  }
  if (!currentData) return;
  shareBtn.disabled = true;
  shareBtn.textContent = t("share.generating");
  try {
    const resp = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: currentData }),
    });
    const r = await resp.json();
    if (!resp.ok) {
      showShareTip(t("share.fail", { msg: (r.error || resp.status) }), false);
      return;
    }
    const full = location.origin + r.url;
    await presentShareUrl(full, t("share.nativeTitle", { train: (currentData && currentData.train) || "" }), trigger,
      { days: r.ttl_days, expiresAt: r.expires_at });
  } catch (e) {
    showShareTip(t("share.fail", { msg: e.message }), false);
  } finally {
    shareBtn.disabled = false;
    shareBtn.textContent = t("share.btn");
  }
});

// ===== 多渠道分享弹层 =====
let shareUrl = "";
function openShareModal(url, d, trigger) {
  shareUrl = url;
  const modal = document.getElementById("shareModal");
  if (!modal) return;
  const train = d && d.train ? String(d.train) : "";
  document.getElementById("shareModalTrain").textContent = train || "";
  const linkInput = document.getElementById("shareLinkInput");
  if (linkInput) linkInput.value = url;
  // 微信二维码（懒生成）
  document.getElementById("shareWxQr").classList.add("hidden");
  const qrBox = document.getElementById("shareQrCanvas");
  if (qrBox) { qrBox.innerHTML = ""; qrBox._generated = false; }
  // 图片下载链接复位
  const dl = document.getElementById("shareImgDownload");
  if (dl) { dl.classList.add("hidden"); dl.removeAttribute("href"); }
  const st = document.getElementById("shareImgStatus");
  if (st) st.textContent = "";
  // 快照类分享带 TTL 时明确告知失效时间（QA SEC-04：过期机制要对用户可见，
  // 否则用户会以为链接永久有效，过几天失效时以为站点坏了）
  const ttlEl = document.getElementById("shareTtlHint");
  if (ttlEl) {
    const ttl = d && d.ttl;
    if (ttl && ttl.days) {
      ttlEl.textContent = t("share.ttlHint", {
        days: ttl.days,
        date: String(ttl.expiresAt || "").slice(0, 10),
      });
      ttlEl.classList.remove("hidden");
    } else {
      ttlEl.textContent = "";
      ttlEl.classList.add("hidden");
    }
  }
  modal._returnFocus = trigger || document.activeElement;
  modal._shareTarget = currentShareTarget(); // 图片生成目标跟随打开弹层时的栏
  modal.classList.remove("hidden");
  const closeBtn = document.getElementById("shareModalClose");
  if (closeBtn) closeBtn.focus();
  // 顺手复制：无手势上下文（rAF）时 iOS 必失败——失败时明确提示改用复制按钮，
  // 不再让用户以为复制成功（旧版静默失败=「链接分享时好时坏」的一半体感）
  requestAnimationFrame(() => copyText(url).then(function (ok) {
    if (!ok) showShareTip(t("share.autoCopyFail"), false);
  }));
}

function closeShareModal() {
  const modal = document.getElementById("shareModal");
  if (!modal) return;
  modal.classList.add("hidden");
  if (modal._returnFocus && document.contains(modal._returnFocus)) modal._returnFocus.focus();
}

/* ===== Buy Me a Coffee 赞助弹窗 ===== */
function openBmcModal(trigger) {
  const modal = document.getElementById("bmcModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal._returnFocus = trigger || null;
  const closeBtn = document.getElementById("bmcModalClose");
  if (closeBtn) closeBtn.focus();
}
function closeBmcModal() {
  const modal = document.getElementById("bmcModal");
  if (!modal) return;
  modal.classList.add("hidden");
  if (modal._returnFocus && document.contains(modal._returnFocus)) modal._returnFocus.focus();
}
(function initBmc() {
  const qrBtn = document.getElementById("bmcQrBtn");
  if (qrBtn) qrBtn.addEventListener("click", function () { openBmcModal(qrBtn); });
  const closeBtn = document.getElementById("bmcModalClose");
  if (closeBtn) closeBtn.addEventListener("click", closeBmcModal);
  const modal = document.getElementById("bmcModal");
  if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) closeBmcModal(); });
})();

// 微信：二维码（扫码打开链接）
document.getElementById("shareWxBtn") &&
  document.getElementById("shareWxBtn").addEventListener("click", function () {
    const qrBox = document.getElementById("shareQrCanvas");
    const wrap = document.getElementById("shareWxQr");
    if (!qrBox || !wrap) return;
    if (!qrBox._generated) {
      try {
        if (typeof QRCode !== "undefined") {
          new QRCode(qrBox, { text: shareUrl, width: 176, height: 176, correctLevel: QRCode.CorrectLevel.M });
        } else {
          qrBox.innerHTML = '<img alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=176x176&data=' + encodeURIComponent(shareUrl) + '" />';
        }
        qrBox._generated = true;
      } catch (e) {
        qrBox.innerHTML = '<img alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=176x176&data=' + encodeURIComponent(shareUrl) + '" />';
        qrBox._generated = true;
      }
    }
    wrap.classList.remove("hidden");
  });

// WhatsApp / Telegram：新窗口
function shareVia(url, w, h) {
  window.open(url, "_blank", "width=" + (w || 640) + ",height=" + (h || 480) + ",noopener");
  return false;
}
document.getElementById("shareWaBtn") &&
  document.getElementById("shareWaBtn").addEventListener("click", function () {
    const train = (document.getElementById("shareModalTrain").textContent || "").trim();
    const text = t("share.whatsappText", { train: train || t("app.title"), url: shareUrl });
    shareVia("https://wa.me/?text=" + encodeURIComponent(text));
  });
document.getElementById("shareTgBtn") &&
  document.getElementById("shareTgBtn").addEventListener("click", function () {
    shareVia("https://t.me/share/url?url=" + encodeURIComponent(shareUrl) +
      "&text=" + encodeURIComponent(t("share.telegramText")));
  });
document.getElementById("shareCopyBtn") &&
  document.getElementById("shareCopyBtn").addEventListener("click", function () {
    copyText(shareUrl).then(function (ok) {
      if (ok) showShareTip(t("share.copied", { url: shareUrl }), true);
      else showShareTip(t("share.copyFail"), false);
    });
  });
document.getElementById("shareModalClose") &&
  document.getElementById("shareModalClose").addEventListener("click", closeShareModal);

// 生成预测结果画布（html2canvas）——头部图片快捷按钮与模态内"生成图片分享"共用
// targetEl 可选：train 栏渲染 #predict；route/journey 栏渲染各自结果容器
function renderPredictionCanvas(targetEl) {
  const target = targetEl || document.getElementById("predict");
  if (!target || target.classList.contains("hidden") || !target.offsetParent) {
    return Promise.reject(new Error("predict hidden"));
  }
  if (typeof html2canvas === "undefined") {
    return Promise.reject(new Error("html2canvas not loaded"));
  }
  return html2canvas(target, {
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
    scale: 2,
  });
}

// 当前栏的可分享结果容器（null = 该栏暂无可分享结果）
function currentShareTarget() {
  if (currentView === "route") {
    // 站对站结果 = 动态层 #predict（移入 routeResultsHost）
    var host = document.getElementById("routeResultsHost");
    if (host && !host.classList.contains("hidden")) {
      var cand = host.querySelector("#predict:not(.hidden), .route-results:not(.hidden)");
      if (cand && cand.offsetParent) return cand;
    }
    return null;
  }
  if (currentView === "journey") {
    var jr = document.getElementById("journeyResult");
    return (jr && !jr.classList.contains("hidden") && jr.offsetParent) ? jr : null;
  }
  var pr = document.getElementById("predict");
  return (pr && !pr.classList.contains("hidden") && pr.offsetParent) ? pr : null;
}

// 分享按钮/图片按钮显隐跟随当前栏（该栏有可见结果才显示）
function updateShareVisibility() {
  if (!shareBtn) return;
  var has = !!currentShareTarget();
  shareBtn.classList.toggle("hidden", !has);
  if (_imgQuickBtn) _imgQuickBtn.classList.toggle("hidden", !has);
}

// 统一分享出口：优先系统原生分享面板，回退多渠道弹层
// BUG FIX (2026-09-09)：iOS Safari 要求 navigator.share 必须在用户手势的
// transient activation 窗口内调用——await fetch/渲染之后 activation 已过期，
// share() 恒抛 NotAllowedError（「图片生成失败: The request is not allowed…」）。
// 用 navigator.userActivation.isActive 判定：手势已丢时直接走弹层，
// 不再做注定失败的 share 尝试（老设备无此 API 时 iOS 一律保守走弹层）。
function _isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
}
function canNativeShareNow() {
  if (!navigator.share) return false;
  if (navigator.userActivation) return navigator.userActivation.isActive === true;
  return !_isIOS();
}
async function presentShareUrl(full, titleText, trigger, ttlInfo) {
  if (canNativeShareNow()) {
    try {
      await navigator.share({ title: titleText, url: full });
      return;
    } catch (se) {
      if (se && se.name === "AbortError") return;
      // NotAllowedError（手势过期）等异常 → 回退弹层
    }
  }
  openShareModal(full, { train: titleText, ttl: ttlInfo }, trigger);
}

// 站对站栏分享：参数链接（打开即自动重查并展示），图片分享渲染当前结果区
async function shareRoute(trigger) {
  const from = (fromInput.value || "").trim();
  const to = (toInput.value || "").trim();
  if (!from || !to) return;
  const servicesActive = false; // 2026-09-11「查车次」Tab 已移除，站对站分享恒为区间预测语义
  const q = new URLSearchParams();
  q.set("from", from); q.set("to", to);
  q.set("mode", servicesActive ? "services" : "delay");
  if (!servicesActive) {
    const tr = (document.getElementById("routeDelayTrain") || {}).value || "";
    if (tr.trim()) q.set("train", tr.trim());
    // 已选定班次的发车时间（点班次卡时记录）：写入链接后，复用号（RE 3 等）
    // 接收方免重选班次——否则短号打开会先出班次列表，要求手选一遍
    if (window._routeDelayRideTime) q.set("rt", window._routeDelayRideTime);
  }
  const full = location.origin + "/?" + q.toString() + "#route";
  await presentShareUrl(full, t("share.nativeTitle", { train: from + " → " + to }), trigger);
}

// 行程栏分享：?j=<legs JSON> 参数链接（打开即自动重新预测并渲染）
async function shareJourney(trigger) {
  if (!lastJourney || !lastJourney.legs || !lastJourney.legs.length) return;
  const payload = { legs: lastJourney.legs, date: lastJourney.date || "" };
  const full = location.origin + "/?j=" + encodeURIComponent(JSON.stringify(payload)) + "#journey";
  const from = lastJourney.legs[0].from;
  const to = lastJourney.legs[lastJourney.legs.length - 1].to;
  await presentShareUrl(full, t("share.nativeTitle", { train: from + " → " + to }), trigger);
}

// 生成整屏结果图片（模态内：PNG 下载 + 剪贴板 + 移动端系统分享）
// BUG FIX (2026-09-09)：剪贴板写入改为点击手势内同步挂载（ClipboardItem 传
// blob Promise）——旧版在 toBlob 回调（手势外）里 write，iOS Safari 恒被拒。
document.getElementById("shareImgBtn") &&
  document.getElementById("shareImgBtn").addEventListener("click", function () {
    const st = document.getElementById("shareImgStatus");
    const btn = this;
    const targetEl = (document.getElementById("shareModal") || {})._shareTarget || currentShareTarget();
    if (!targetEl) { if (st) st.textContent = t("share.imgFail", { msg: "no result" }); return; }
    if (st) st.textContent = t("share.imgGenerating");
    btn.disabled = true;
    const canvasPromise = renderPredictionCanvas(targetEl);
    const blobPromise = canvasPromise.then(
      (c) => new Promise((res) => c.toBlob(res, "image/png")));
    // 剪贴板：手势内 promise 模式（WebKit 官方推荐）；不支持时 blob 后降级
    let clipMode = null;
    if (navigator.clipboard && typeof ClipboardItem === "function") {
      try {
        const item = new ClipboardItem({ "image/png": blobPromise });
        navigator.clipboard.write([item]).then(() => {}, () => {});
        clipMode = "promise";
      } catch (e) { clipMode = "manual"; }
    }
    blobPromise.then(function (b) {
      if (!b) return;
      // 移动端系统分享（能成则成；iOS 手势过期会静默失败——下载/复制仍可用）
      try {
        if (navigator.canShare && navigator.share) {
          const file = new File([b], "train-delay.png", { type: "image/png" });
          if (navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: t("share.imgTitle") }).catch(function () {});
          }
        }
      } catch (e) { /* 系统分享可选 */ }
      if (clipMode !== "promise") {
        try { const item = new ClipboardItem({ "image/png": b }); navigator.clipboard.write([item]).catch(function () {}); } catch (e) { /* 剪贴板可选 */ }
      }
    });
    canvasPromise.then(function (canvas) {
      const url2 = canvas.toDataURL("image/png");
      const dl = document.getElementById("shareImgDownload");
      if (dl) {
        dl.href = url2;
        dl.classList.remove("hidden");
      }
      if (st) st.textContent = t("share.imgDone");
    }).catch(function (e) {
      if (st) st.textContent = t("share.imgFail", { msg: e.message });
    }).finally(function () {
      btn.disabled = false;
    });
  });

// 头部快捷图片分享：生成当前栏结果图 → 移动端直接调起系统分享面板；桌面复制到剪贴板并提示
// BUG FIX (2026-09-09) iPad「图片分享时好时坏」：
//   iOS Safari 的 navigator.share/clipboard.write 必须在用户手势 transient
//   activation 窗口内调用；旧版 await html2canvas 渲染（1~5s）后再调用恒抛
//   NotAllowedError（渲染快时偶发成功=时好时坏）。修复三板斧：
//   ① 点击手势内同步挂载剪贴板写入（ClipboardItem 传 blob Promise，渲染完成后
//      自动入剪贴板——WebKit 官方模式）；② activation 已过期时不再徒劳 share，
//      改为缓存文件 + 按钮⤴提示，用户再点一次（新手势）同步调起系统分享必成；
//   ③ 剪贴板被拒时明确提示，不再静默。
const _imgQuickBtn = document.getElementById("shareImgQuickBtn");
if (_imgQuickBtn) _imgQuickBtn.addEventListener("click", async function () {
  const btn = this;
  // 二段式第二步：图片已就绪 → 新手势内同步调起系统分享（iOS 必成）
  if (btn._pendingFile && typeof navigator.share === "function" &&
      navigator.canShare && navigator.canShare({ files: [btn._pendingFile] })) {
    const f = btn._pendingFile;
    btn._pendingFile = null;
    if (btn._origText) { btn.textContent = btn._origText; btn._origText = null; }
    try {
      await navigator.share({ files: [f], title: t("share.imgTitle") });
    } catch (e) {
      if (!(e && e.name === "AbortError"))
        showShareTip(t("share.imgFail", { msg: e.message }), false);
    }
    return;
  }
  btn._pendingFile = null;
  if (btn._origText) { btn.textContent = btn._origText; btn._origText = null; }
  const target = currentShareTarget();
  if (!target) return;
  const old = btn.textContent;
  btn._origText = old;
  btn.disabled = true;
  btn.textContent = "⏳";
  // ① 手势内同步挂载剪贴板写入（promise 形式）：渲染完成后自动入剪贴板
  const canvasPromise = renderPredictionCanvas(target);
  const blobPromise = canvasPromise.then(
    (c) => new Promise((res) => c.toBlob(res, "image/png")));
  let clipMode = null; // "promise"=手势内已挂载 / "manual"=blob 后再写 / null=不可用
  if (navigator.clipboard && typeof ClipboardItem === "function") {
    try {
      const item = new ClipboardItem({ "image/png": blobPromise });
      navigator.clipboard.write([item]).then(() => {}, () => {});
      clipMode = "promise";
    } catch (e) { clipMode = "manual"; }
  }
  try {
    const blob = await blobPromise;
    if (!blob) throw new Error("canvas toBlob failed");
    const file = new File([blob], "train-delay-" + currentView + ".png", { type: "image/png" });
    // ② activation 仍有效（桌面/Android/渲染极快）→ 直接调起系统分享。
    //    2026-09-13：部分国产/第三方内核「声称 canShare({files})=true 但实际不弹面板」，
    //    await 后静默返回，用户什么也拿不到。故分享成功与否都先备好可点击的保存链接：
    //    分享被取消或未真正弹面板时，回退到提示条内的链接（可点/可长按保存）。
    if (canNativeShareNow() && navigator.canShare && navigator.canShare({ files: [file] })) {
      let shared = false;
      try {
        await navigator.share({ files: [file], title: t("share.imgTitle") });
        shared = true; // 正常分享完成
      } catch (se) {
        if (se && se.name === "AbortError") { shared = true; } // 用户主动取消 → 视为已处理
        // 其他异常（未真正弹面板 / 内核不支持）→ 落到下面的链接兜底
      }
      if (shared) return;
    }
    // iOS 主路径：手势已过期 → 缓存文件 + 提示条内提供可点击链接（再点调起系统分享）
    if (typeof navigator.share === "function") {
      btn._pendingFile = file;
      btn.textContent = "📤";
      showShareTip(t("share.imgReadyTap"), true,
        { href: URL.createObjectURL(blob), text: t("share.imgDownload"),
          filename: "train-delay-" + currentView + ".png" });
      return;
    }
    // 桌面无系统分享：剪贴板兜底 + 始终给出下载链接
    let copied = clipMode === "promise";
    if (!copied) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copied = true;
      } catch (e) { copied = false; }
    }
    showShareTip(copied ? t("share.imgDone") : t("share.imgReadyNoCopy"), copied,
      { href: URL.createObjectURL(blob), text: t("share.imgDownload"),
        filename: "train-delay-" + currentView + ".png" });
  } catch (e) {
    if (!(e && e.name === "AbortError")) showShareTip(t("share.imgFail", { msg: e.message }), false);
  } finally {
    btn.disabled = false;
    if (!btn._pendingFile && btn._origText) { btn.textContent = btn._origText; btn._origText = null; }
  }
});

function fmtDelay(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v >= 0 ? "+" : "") + Math.round(v) + " " + t("unit.min");
}

// ── 全屏查询 loading 覆盖层（2026-09-11 用户要求：查车次/区间预测点击后有转圈交互）──
function showPageLoading(text, sub) {
  var ov = document.getElementById("pageLoadingOverlay");
  if (!ov) return;
  document.getElementById("ploText").textContent = text || t("route.overlayDefault");
  document.getElementById("ploSub").textContent = sub || "";
  ov.style.display = "flex";
}
function hidePageLoading() {
  var ov = document.getElementById("pageLoadingOverlay");
  if (ov) ov.style.display = "none";
}

async function search(train, destination, rideFrom, rideTo, rideTime, opts) {
  const generation = ++searchGeneration;
  if (activeSearchController) activeSearchController.abort();
  train = sanitizeTrain(train);
  if (!train) {
    showStatus(t("search.emptyTrain"), true);
    return;
  }
  // 结果层归属：跟随发起查询的当前页（页面 A 单车次 / 页面 B 查晚点）
  placeResultsLayer(currentView);
  const controller = new AbortController();
  activeSearchController = controller;
  // 记录查询上下文（供 predictDate change 自动重查）
  lastQuery = {
    mode: "input", train: train,
    destination: sanitizeStation(destination || ""),
    rideFrom: sanitizeStation(rideFrom || ""),
    rideTo: sanitizeStation(rideTo || ""),
    rideTime: sanitizeStation(rideTime || ""),
  };
  // 供 breakdown 实时事件按钮回溯（懒加载 /api/train-incidents 用）
  window._lastTrainCtx = { train: train, date: predictDateISO() || "" };
  // destination 仅接受显式传入（站对站直达流程 direct/svc 卡显式传参）；
  // 不自动继承 toInput——否则站对站残留目的站会污染车次查询
  // （如先查 A→B 再查车次 RE 11，会被误限为"到达 B 的延误"而非终点延误）
  destination = (destination || "").trim();
  // 清空旧结果（避免上一次线路查询残留）
  hideStatus();
  predictEl.classList.add("hidden");
  resultsEl.classList.add("hidden");
  serviceResults.classList.add("hidden");
  searchBtn.disabled = true;
  searchBtn.textContent = t("search.searching");
  // 慢查询提示：冷车次 spawn python 可能数十秒；>20s 给出「加载较慢」文案，
  // 避免用户以为页面卡死（结果仍会正常返回）。
  var slowTimer = setTimeout(function () {
    if (generation === searchGeneration) searchBtn.textContent = t("search.slow");
  }, 20000);

  try {
    // 智能判断：提取号码部分，5 位及以上数字 → 视为具体列车号（如 RE 62037 / ICE 847），
    // 跳过线路班次列表、直接预测；短号码（1~4 位）→ 视为线路号（如 RE 7 / IC 2）→ 先列班次
    const { type: qType, num: qNum } = splitTrainLine(train);
    const isSpecificTrain = /^\d{5,}$/.test(qNum);

    // BUG FIX (2026-09-14)：ICE/IC/EC 没有"线路档案"（timetable 里无 line_number），
    // 任何 "ICE 847" 走线路查询必然 count=0，然后弹「未找到班次 + 请检查线路号」，
    // 让用户以为是自己输错了。但这个引擎里 ICE/IC/EC 都是「具体车次」，
    // 而「单车次预测」页存在的唯一意义就是查具体车次 —— 在该页直接预测，
    // 不再绕一次注定失败的线路查询。
    // 判定：ICE/IC/EC 前缀 + 纯数字（1 位起，ICE 847 是合法的 3 位车次号）。
    const _isIceFamily = /^(ICE|IC|EC)\d+$/.test(qType + qNum);
    const _onTrainView = currentView === "train";
    const _skipLineLookup = isSpecificTrain || (_isIceFamily && _onTrainView);

    // BUG FIX (2026-09-09)：带 ride_from 的查询（站对站直达卡/区间预测）必须直接
    // 进预测——旧版短号线路先走班次列表分支，ride_from/ride_to/ride_time 被丢弃，
    // 复用号（RE 8 全国 610 条班次）直接把用户甩回列表/错误分支。
    if (!_skipLineLookup && !rideFrom) {
      // 1) 线路查：按线路号列出所有班次（如 "RE 11" → 多个发车时间）
      const svc = await fetchJSON("/api/services?line=" + encodeURIComponent(train), {
        signal: controller.signal,
        timeout: MAIN_REQUEST_TIMEOUT_MS,
      });
      if (generation !== searchGeneration) return;
      if (svc && svc.count > 0 && svc.services.length > 0) {
        // 缓存线路级服务：供 from/to 下拉做上下文感知（priority ②）
        //   此前遗漏——cachedLineServices 只初始化未填充，导致查完线路后
        //   聚焦空起点站仍显示通用站（Aachen…）而非该线路途经站。
        cachedLineServices = { line: train, services: svc.services };
        // 查晚点降级上下文（查晚点 tab 无起终点时列班次）：点卡只选定班次，
        // 不自动预测——等用户确认区间后手动触发（省一次 /api/train 请求）
        // 站对站视图即查晚点语境（2026-09-11「查车次」Tab 已移除，不再需要 Tab 判定）
        const _delayCtx = currentView === "route";
        renderServices(train, svc, destination, { autoPredict: !_delayCtx });
        return;
      }
      if (svc && svc.count === 0) {
        // 线路号无匹配班次（ICE/IC 无线路档案）→ 显示空结果提示而非静默冷预测
        cachedLineServices = { line: "", services: null };
        renderServices(train, svc, destination, { autoPredict: false });
        return;
      }
    }
    // 2) 直接按车次号预测（具体车次 / 线路号无班次时降级）
    let trainUrl = "/api/train?train=" + encodeURIComponent(train) + "&days=10";
    const dateISO = predictDateISO();
    if (dateISO) trainUrl += "&date=" + dateISO;
    if (destination) trainUrl += "&destination=" + encodeURIComponent(destination);
    if (rideFrom) trainUrl += "&ride_from=" + encodeURIComponent(rideFrom);
    if (rideTo) trainUrl += "&ride_to=" + encodeURIComponent(rideTo);
    if (rideTime) trainUrl += "&ride_time=" + encodeURIComponent(rideTime);
    const data = await fetchJSON(trainUrl, {
      signal: controller.signal,
      timeout: MAIN_REQUEST_TIMEOUT_MS,
    });
    if (generation !== searchGeneration) return;
    if (data && !data.error) {
      renderPredict(data);
      return;
    }
    // 3) 回退：旧模拟接口（仅数据兜底，渲染复用 renderPredict）
    const data2 = await fetchJSON("/api/delay?train=" + encodeURIComponent(train), {
      signal: controller.signal,
      timeout: MAIN_REQUEST_TIMEOUT_MS,
    });
    if (generation !== searchGeneration) return;
    if (!data2 || data2.error) {
      showStatus(data2 && data2.error ? t("err.queryFail", { msg: localErrStr(data2.error) }) : t("err.noResponse"), true, true);
      // 查询失败：清空上下文缓存，避免旧车次停靠站污染后续站名下拉建议
      cachedLineServices = { line: "", services: null };
      cachedTrainStations = { train: "", stations: null };
      return;
    }
    // /api/delay 返回的旧格式（{rows: [...]}）转成 renderPredict 期望的形状再渲染
    renderPredict({
      train: train,
      prediction: data2.rows && data2.rows.length
        ? { point_estimate: Math.round(data2.rows.reduce(function (a, r) { return a + (r.delay || 0); }, 0) / data2.rows.length) }
        : null,
      recent: data2.rows || [],
      station_days: [],
      mode: "legacy",
    });
  } catch (e) {
    if (generation !== searchGeneration) return;
    // 超时降级：若本页已有预测结果（currentData），保留展示 + 提示可重试，
    // 不把用户已经看到的数据抹掉（旧行为：一律隐藏 predict 区 → 白屏）。
    var isTimeout = e && e.code === "timeout";
    var msg = isTimeout && currentData ? t("err.slowKept") : queryTransportError(e);
    showStatus(msg, true, true, { keepResult: !!(isTimeout && currentData) });
    // 同上：失败后清空上下文缓存
    cachedLineServices = { line: "", services: null };
    cachedTrainStations = { train: "", stations: null };
  } finally {
    clearTimeout(slowTimer);
    if (activeSearchController === controller) activeSearchController = null;
    if (generation !== searchGeneration) { if (opts && opts.onSettled) { try { opts.onSettled(); } catch (_) {} } return; }
    searchBtn.disabled = false;
    searchBtn.textContent = t("search.btn");
    // 全屏 loading 收起（查车次/预测区间晚点入口挂了 onSettled）
    if (opts && opts.onSettled) { try { opts.onSettled(); } catch (_) {} }
  }
}

// 显示线路的所有班次（让用户选择具体班次预测）
// ── serviceResults 宿主搬运（2026-09-10 用户反馈「查车次结果放进 route-search 卡片」）──
// serviceResults 只有一份：站对站视图下搬进 .route-search 卡片内的 #svcResultsHost
// （视觉上属于搜索面板）；其他视图（单车程预测页）放回 #predict 预测区。
function _placeServiceResults() {
  const host = document.getElementById("svcResultsHost");
  if (!host || !serviceResults) return;
  if (currentView === "route") {
    if (serviceResults.parentElement !== host) host.appendChild(serviceResults);
  } else if (serviceResults.parentElement !== predictEl) {
    const cards = document.getElementById("predictionCards");
    if (cards) predictEl.insertBefore(serviceResults, cards);
    else predictEl.appendChild(serviceResults);
  }
}

// ── 区间走向判定：班次停靠序列中 from 是否在 to 之前（true=正向覆盖 / false=反向 / null=无法判断）──
function _stationIndexInList(sts, name) {
  const n = normalizeStation(name);
  if (!n) return -1;
  for (let i = 0; i < sts.length; i++) {
    const s = normalizeStation(sts[i]);
    if (!s) continue;
    if (s === n) return i;
    // 宽松前缀（≥4 字符）：兼容 "Werdohl" vs "Werdohl(Lüdenscheid)" 类写法
    if (n.length >= 4 && (s.indexOf(n) === 0 || n.indexOf(s) === 0)) return i;
  }
  return -1;
}
function _svcCoversInterval(svc, from, to) {
  const sts = svc.all_stations && svc.all_stations.length > 1 ? svc.all_stations : null;
  if (!sts) return null;
  const fi = _stationIndexInList(sts, from);
  const ti = _stationIndexInList(sts, to);
  if (fi < 0 || ti < 0 || fi === ti) return null;
  return fi < ti;
}
let _svcShowAll = false; // 「显示全部」一次性开关（反向班次被区间过滤后可展开）
// ── 班次列表按时段分组（2026-09-10 用户定稿：只保留时段分组——按州与州筛选条
// 重复、按时间与卡片自带时刻重复，均已移除）──
function _PERIOD_DEFS() {
  // 时段五桶（跨夜的 00:00–05:00 归「夜间」）；分组、时间筛选条、徽标共用
  return [
    { key: "early",     label: t("svc.periodEarly"),     lo: 5,  hi: 8 },
    { key: "morning",   label: t("svc.periodMorning"),   lo: 8,  hi: 12 },
    { key: "afternoon", label: t("svc.periodAfternoon"), lo: 12, hi: 18 },
    { key: "evening",   label: t("svc.periodEvening"),   lo: 18, hi: 24 },
    { key: "night",     label: t("svc.periodNight"),     lo: 0,  hi: 5 },
  ];
}
function _depHour(s) {
  return parseInt((s.dep_time || (s.dataset && s.dataset.dep) || "00:00").slice(0, 2), 10);
}
function _svcGroup(services) {
  return _PERIOD_DEFS().map(function (d) {
    return {
      key: d.key, label: d.label,
      items: services.filter(function (s) {
        const h = _depHour(s);
        return h >= d.lo && h < d.hi;
      })
    };
  }).filter(function (g) { return g.items.length; });
}

// ── 具体班次号补齐（2026-09-10 用户需求「列出 RE 62037 这样的号」）──
// 号源是 PieBro parquet 的 train_number（每个班次唯一，如 RE 4 05:21 → 26405）。
// /api/ride-numbers 返回 {from, dep, num} 列表；前端按「归一起点站 + 发车时刻
// 差 ≤10 分钟取最近」匹配卡片（timetable 与 PieBro 是两个数据源，时刻常差 1~3 分钟）。
window._rideNumCache = window._rideNumCache || {}; // 线路归一键 → numbers（会话内复用）
let _rideNumFetchSeq = 0; // 防过期响应覆盖新列表

function _normStationKey4Num(s) {
  return String(s || "").toLowerCase()
    .replace(/hauptbahnhof|flughafen|bahnhof|hbf|bhf/g, "")
    .replace(/[^a-z0-9äöüß]/g, "");
}
function _hhmmToMin4Num(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}
function _matchRideNum(nums, fromStation, depTime) {
  const fk = _normStationKey4Num(fromStation);
  const dm = _hhmmToMin4Num(depTime);
  if (!nums || fk.length < 4 || dm < 0) return "";
  let best = null, bestDiff = 11; // ≤10 分钟
  for (const x of nums) {
    if (_normStationKey4Num(x.from) !== fk) continue;
    const xm = _hhmmToMin4Num(x.dep);
    if (xm < 0) continue;
    const diff = Math.abs(xm - dm);
    if (diff < bestDiff) { bestDiff = diff; best = x; }
  }
  return best ? String(best.num) : "";
}
function _applyRideNumbers(container, line) {
  const key = String(line || "").toUpperCase().replace(/\s+/g, "");
  const nums = window._rideNumCache[key];
  if (!nums) return false;
  container.querySelectorAll(".svc-card").forEach(function (card) {
    if (card.dataset.jnum) return;
    const num = _matchRideNum(nums, card.dataset.from, card.dataset.dep);
    if (!num) return;
    card.dataset.jnum = num;
    const el = card.querySelector(".rc-line");
    if (el) {
      const sp = document.createElement("span");
      sp.className = "rc-jnum";
      sp.textContent = num;
      el.appendChild(sp);
    }
  });
  return true;
}
function _fetchRideNumbers(line) {
  const key = String(line || "").toUpperCase().replace(/\s+/g, "");
  if (!key) return;
  if (_applyRideNumbers(serviceResults, line)) return; // 缓存命中：重渲染立即补
  const seq = ++_rideNumFetchSeq;
  fetch("/api/ride-numbers?line=" + encodeURIComponent(line))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !Array.isArray(d.numbers)) return;
      window._rideNumCache[key] = d.numbers;
      if (seq !== _rideNumFetchSeq) return; // 用户已切到别的线路查询
      if (String((lastSvcData && lastSvcData.line) || "").toUpperCase().replace(/\s+/g, "") !== key) return;
      _applyRideNumbers(serviceResults, line);
    })
    .catch(function () {}); // 静默降级：拿不到号就只显示线路名
}
function _svcCardHtml(s) {
  const trainRef = s.line_number || (s.journey_number != null && s.train_type
    ? s.train_type + " " + s.journey_number : "");
  const canPredict = !!trainRef;
  return '<div class="route-card svc-card" ' +
    (canPredict ? '' : ' aria-disabled="true"') +
    'data-line="' + escapeHtml(trainRef) + '" ' +
    'data-from="' + escapeHtml(s.from_station) + '" ' +
    'data-to="' + escapeHtml(s.to_station) + '" ' +
    'data-dep="' + escapeHtml(s.dep_time) + '" ' +
   'data-region="' + escapeHtml(s.region || "") + '" ' +
   'data-regions="' + escapeHtml((s.regions && s.regions.length ? s.regions : [s.region]).join("|")) + '">' +
    '<span class="rc-line">' + escapeHtml(s.train_type) +
    (s.line_number ? " · " + escapeHtml(s.line_number) : "") + "</span>" +
    '<span class="rc-time">' + escapeHtml(s.dep_time) + "</span>" +
    '<span class="rc-meta">' + escapeHtml(s.from_station) + " → " + escapeHtml(s.to_station) +
    t("svc.metaStops", { n: s.n_stops }) + t("svc.metaDays", { d: s.n_days }) +
    (s.duration_min ? t("svc.metaDur", { m: duration_min_str(s.duration_min) }) : "") + "</span>" +
    (canPredict ? "" : '<span class="rc-unavailable">' + escapeHtml(t("route.notPredictable")) + "</span>") +
    '<button type="button" class="rc-region region-chip" data-region="' + escapeHtml(s.region || "") + '">' + escapeHtml(s.region || "") + "</button></div>";
}

function renderServices(line, svc, destination, opts) {
  resultsEl.classList.add("hidden");
  predictEl.classList.remove("hidden"); // serviceResults 可能仍在 predict（非站对站视图）
  serviceResults.classList.remove("hidden");
  _placeServiceResults(); // 站对站视图 → 搬进 .route-search 卡片内
  // 线路查询只应显示待选班次；清除上一趟具体车次的预测，避免分享或阅读到过期数据。
  // 2026-09-13 补 segmentPanel/breakdownPanel：区间预测卡残留屏上，被误读成
  // 新区间的结果（用户反馈「改了起终点，晚点数不变」的直接根源之一）。
  currentData = null;
  updateShareVisibility();
  ["predictionHead", "predictionCards", "chart10dPanel", "chartStationsPanel", "timetablePanel",
   "dataQuality", "pEmpty", "segmentPanel", "breakdownPanel"]
    .forEach(function (id) {
      const panel = document.getElementById(id);
      if (panel) panel.classList.add("hidden");
    });
  let services = svc.services || [];
  const _totalN = services.length;
  // 空结果提示（2026-09-14）：timetable 只有 RE/RB/IC/ICE/FLX，且 ICE/IC 无线路号概念
  // （line_number 缺失）→ "ICE 847" 这类查询必然 count=0。
  // 2026-09-14 修订：原文案是「未找到班次 + 请检查线路号是否正确」，把"ICE 本来就没有
  // 线路档案"这个必然结果说成了"你可能输错了"，是误导。改为：动词改成中性的「按线路查询」，
  // 并明确告知 ICE/EC 需要用具体车次号查，给出直接可点的下一步。
  if (_totalN === 0) {
    const _q = String(line || "").trim().toUpperCase();
    // IC 也归入"无线路档案"一类（与 ICE/EC 同样只有具体车次号）
    const _iceLike = /^(ICE|IC|EC)\s*\d+$/.test(_q);
    currentData = null;
    updateShareVisibility();
    lastSvcData = null;
    let tip;
    if (_iceLike) {
      // ICE/IC/EC 没有线路档案，列不出班次是必然结果，不是用户输错。
      // 到了这里说明用户没填起终点（填了的话 predictRouteDelay 已直接走区间预测）。
      // 此时最有效的引导是「补上起终点」，而不是把他赶去另一个页面。
      tip = '<div class="route-title">' + t("svc.iceTitle", { line: escapeHtml(_q) }) + "</div>" +
        '<div class="svc-empty-note">' + t("svc.emptyIceNeedStations", { line: escapeHtml(_q) }) + "</div>" +
        '<button type="button" class="svc-goto-predict" id="svcGotoPredict">' +
        t("svc.emptyGoPredict", { line: escapeHtml(_q) }) + "</button>";
    } else {
      tip = '<div class="route-title">' + t("svc.emptyTitle", { line: escapeHtml(line) }) + "</div>" +
        '<div class="svc-empty-note">' + t("svc.emptyGeneric") + "</div>";
    }
    serviceResults.innerHTML = tip;
    const _goBtn = document.getElementById("svcGotoPredict");
    if (_goBtn) _goBtn.addEventListener("click", function () {
      // 跳到「列车预测」页并直接把该车次填入搜索框（不自动提交，用户可确认后查询）
      if (typeof switchView === "function") switchView("train");
      if (trainInput) {
        trainInput.value = _q;
        try { trainInput.focus(); } catch (_) {}
      }
    });
    return;
  }
  // 区间感知过滤（2026-09-10 用户反馈：Dortmund Hbf→Werdohl 列表混入 Siegen→Dortmund
  // 反向班次）：起终点都填时，仅保留停靠序列覆盖该区间方向的班次；无法判断时保留。
  let _filtered = false;
  const _fromV = (fromInput.value || "").trim();
  const _toV = (toInput.value || "").trim();
  if (_fromV && _toV && !_svcShowAll) {
    const _cov = services.filter(function (s) { return _svcCoversInterval(s, _fromV, _toV) === true; });
    if (_cov.length && _cov.length < services.length) { services = _cov; _filtered = true; }
  }
  _svcShowAll = false; // 一次性
  // 按 dep_time 排序
  services.sort(function (a, b) { return a.dep_time.localeCompare(b.dep_time); });
  // 标题（区间过滤时注明数量并提供「显示全部」入口）
  let html = '<div class="route-title">' +
    (_filtered
      ? t("svc.filtered", { from: escapeHtml(_fromV), to: escapeHtml(_toV), n: services.length, m: _totalN }) +
        ' <button type="button" class="svc-showall" data-i18n="svc.showAll">' + t("svc.showAll", { m: _totalN }) + "</button>"
      : t("svc.title", { line: escapeHtml(line), n: services.length })) +
    "</div>";
  // 缓存供清空筛选时重渲染（opts 随缓存透传，语言切换/重渲染不丢语义）
  lastSvcData = { line: line, svc: svc, destination: destination,
                  opts: opts || (lastSvcData && lastSvcData.opts) || { autoPredict: true } };
  // 按时段分组渲染（2026-09-10 用户定稿：仅时段分组，去 tabs）
  html += _svcGroup(services).map(function (g) {
    return '<div class="svc-group-head">' + g.label +
      '<span class="svc-group-n">' + g.items.length + '</span></div>' +
      g.items.map(_svcCardHtml).join("");
  }).join("");
  serviceResults.innerHTML = html;
  // 「显示全部」：区间过滤后可展开被滤掉的反向班次（一次性，重渲染即恢复过滤）
  const _showAllBtn = serviceResults.querySelector(".svc-showall");
  if (_showAllBtn) _showAllBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    _svcShowAll = true;
    renderServices(line, svc, destination, opts);
  });
  // 绑卡片 click（预测该车次）
  serviceResults.querySelectorAll(".svc-card").forEach(function (card) {
    const canPredict = !!card.dataset.line;
    if (canPredict) {
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
    } else {
      card.classList.add("route-card-unavailable");
    }
    card.addEventListener("keydown", function (e) {
      if (!canPredict) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); card.click(); }
    });
    card.addEventListener("click", function (e) {
      // 点 region chip 时不触发卡片 click
      if (e.target.closest(".region-chip")) return;
      const lineNumber = card.dataset.line;
      if (!canPredict) return;
      const fromSt = card.dataset.from || "";
      const toSt = card.dataset.to || "";
      trainInput.value = lineNumber;
      if (trainInput._syncTrainClear) trainInput._syncTrainClear();
      const _hadF = !!(fromInput.value || "").trim();
      const _hadT = !!(toInput.value || "").trim();
      const _noAuto = opts && opts.autoPredict === false;
      if (_noAuto) {
        // 查晚点降级：点卡只选定班次——已填的区间不覆盖（用户可能特意选的），
        // 只补空位；两个都是回填才锁定交换
        if (fromSt && !_hadF) fromInput.value = fromSt;
        if (toSt && !_hadT) toInput.value = toSt;
        stationsAutoFilled = !_hadF && !_hadT && (!!fromSt || !!toSt);
      } else {
        if (fromSt) fromInput.value = fromSt;
        if (toSt) toInput.value = toSt;
        stationsAutoFilled = true; // 起终点来自车次数据（单向线路），禁止交换
      }
      syncStationClears(); // 程序化回填也要刷新 × 显隐
      hideStatus();
      if (_noAuto) {
        serviceResults.classList.add("hidden");
        const _rdt = document.getElementById("routeDelayTrain");
        if (_rdt) { _rdt.value = lineNumber; if (_rdt._syncTrainClear) _rdt._syncTrainClear(); }
        // 记住所选班次的发车时间：predictRouteDelay 传给后端 resolve_ride，
        // 复用号线路多班次共用同一起终点时按时间精确定位该班次
        window._routeDelayRideTime = card.dataset.dep || "";
        // 已选定班次：下次点「预测区间晚点」直接预测（先出列表 → 选定 → 预测）
        window._routeDelaySvcPicked = true;
        const _st = document.getElementById("routeDelayStatus");
        if (_st) {
          _st.textContent = t("route.pickServiceFilled", { train: lineNumber });
          _st.classList.remove("hidden");
          setTimeout(function () { _st.classList.add("hidden"); }, 8000);
        }
        saveQueryDraft();
        return;
      }
      serviceResults.classList.add("hidden");
      predictEl.classList.add("hidden");
      searchBtn.disabled = true;
      searchBtn.textContent = t("search.searching");
      // 把 to_station 作为 destination 传给 /api/train（站对站预测）
      let trainUrl = "/api/train?train=" + encodeURIComponent(lineNumber) + "&days=10";
      const dest = (toSt || destination || "").trim();
      const dateISO = predictDateISO();
      if (dest) trainUrl += "&destination=" + encodeURIComponent(dest);
      // 线路复用号（RE 13 等）：必须把始发站 + 发车时间一并传给后端，
      // resolve_ride 据此定位用户所选班次的具体车号。缺了这两个参数，
      // 后端只会做线路级查询（全天多班次聚合），点 NRW 早班车也会
      // 落到其他走向（如 Magdeburg 方向）。
      if (fromSt) trainUrl += "&ride_from=" + encodeURIComponent(fromSt);
      if (card.dataset.dep) trainUrl += "&ride_time=" + encodeURIComponent(card.dataset.dep);
      if (dateISO) trainUrl += "&date=" + dateISO;
      fetchJSON(trainUrl)
        .then(function (data) {
          if (data && !data.error) renderPredict(data);
          else showStatus(t("err.queryFail", { msg: localErrStr(data && data.error || "无响应") }), true, true);
        })
        .catch(function (e) { showStatus(queryTransportError(e), true, true); })
        .finally(function () { searchBtn.disabled = false; searchBtn.textContent = t("search.btn"); });
    });
  });
  renderRegionBar(serviceResults);
  applyRegionFilter(serviceResults);
  renderTimeBar(serviceResults);
  applyTimeFilter(serviceResults);
  // 具体班次号异步补齐（列表先出，号随后补上；缓存命中则立即）
  _fetchRideNumbers(line);
  bindRegionChips(serviceResults);
}

/* ===== 州（region）筛选：通用工具，服务于 serviceResults（线路班次列表） ===== */
let regionFilter = ""; // 空 = 不过滤；非空 = 仅显示该州
let lastSvcData = null;     // { line, svc, destination } —— 清空筛选时重渲染
// 列表顶部「按地区」州筛选条（2026-09-10）：卡片内嵌 chip 只显示该班次的起点州，
// 途经州（data-regions）没有入口——跨州长途班次想筛途经州时用户点不到，只能靠
// 恰好有一趟以该州为起点的车。这里按全部卡片的途经州并集生成 chip 并标班次计数。
function renderRegionBar(container) {
  if (!container) return;
  const oldBar = container.querySelector(".region-filter-bar");
  if (oldBar) oldBar.remove();
  const counts = new Map();
  container.querySelectorAll(".svc-card, .direct-card").forEach(function (card) {
    const regs = (card.dataset.regions || card.dataset.region || "").split("|").filter(Boolean);
    for (const r of regs) counts.set(r, (counts.get(r) || 0) + 1);
  });
  if (counts.size < 2) return; // 单一州无需筛选
  const list = Array.from(counts.entries()).sort(function (a, b) {
    return b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
  });
  const bar = document.createElement("div");
  bar.className = "region-filter-bar";
  bar.innerHTML = '<span class="region-bar-label">' + escapeHtml(t("region.filter")) + "</span>" +
    list.map(function (e) {
      return '<button type="button" class="region-chip" data-region="' + escapeHtml(e[0]) + '">' +
        escapeHtml(e[0]) + '<span class="region-n">' + e[1] + "</span></button>";
    }).join("") +
    '<button type="button" class="region-clear" aria-label="清空筛选">×</button>';
  bar.querySelector(".region-clear").addEventListener("click", function () {
    regionFilter = "";
    if (typeof lastSvcData !== "undefined" && lastSvcData) renderServices(lastSvcData.line, lastSvcData.svc, lastSvcData.destination, lastSvcData.opts);
  });
  container.insertBefore(bar, container.firstChild);
  updateRegionBar(container);
}
function updateRegionBar(container) {
  if (!container) return;
  const bar = container.querySelector(".region-filter-bar");
  if (!bar) return;
  bar.querySelectorAll(".region-chip").forEach(function (c) {
    c.classList.toggle("active", !!regionFilter && c.dataset.region === regionFilter);
  });
  const clr = bar.querySelector(".region-clear");
  if (clr) clr.style.display = regionFilter ? "" : "none";
}

// 分组视图：组头计数改为仅统计可见卡（双筛选：region-hidden / time-hidden 都算隐藏），
// 空组头隐藏（筛州后「Bayern 0」无意义）
function _updateGroupHeads(container) {
  if (!container) return;
  container.querySelectorAll(".svc-group-head").forEach(function (h) {
    let el = h.nextElementSibling, vis = 0;
    while (el && !el.classList.contains("svc-group-head")) {
      if (el.classList.contains("svc-card") && _cardVisible(el)) vis++;
      el = el.nextElementSibling;
    }
    const n = h.querySelector(".svc-group-n");
    if (n) n.textContent = vis;
    h.style.display = vis ? "" : "none";
  });
  // 标题行筛选态徽标（州 + 时间各一枚）：筛后「找到 N 个班次」不同步会误导
  const title = container.querySelector(".route-title");
  if (title) {
    const cards = container.querySelectorAll(".svc-card");
    let vis = 0;
    cards.forEach(function (c) { if (_cardVisible(c)) vis++; });
    _upsertFilterBadge(container, title, "svc-region-badge",
      regionFilter ? t("svc.regionFiltered", { r: regionFilter, n: vis, m: cards.length }) : "",
      vis < cards.length);
    const tDef = timeFilter ? _PERIOD_DEFS().find(function (d) { return d.key === timeFilter; }) : null;
    _upsertFilterBadge(container, title, "svc-time-badge",
      tDef ? t("svc.timeFiltered", { p: tDef.label, n: vis, m: cards.length }) : "",
      vis < cards.length);
  }
}
function _upsertFilterBadge(container, title, cls, text, show) {
  let badge = container.querySelector("." + cls);
  if (show && text) {
    if (!badge) {
      badge = document.createElement("span");
      // 基类 svc-filter-badge 出样式；cls 独立标识，保证两枚徽标查询互不命中
      badge.className = "svc-filter-badge " + cls;
      title.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.display = "";
  } else if (badge) {
    badge.style.display = "none";
  }
}

function applyRegionFilter(container) {
  if (!container) return;
  // 清空筛选时：移除所有 region-hidden + 移除 active 高亮（不含时间 chips）
  if (!regionFilter) {
    container.querySelectorAll(".svc-card.region-hidden, .direct-card.region-hidden").forEach(function (c) {
      c.classList.remove("region-hidden");
    });
    container.querySelectorAll(".region-chip.active:not(.time-chip)").forEach(function (c) {
      c.classList.remove("active");
    });
    updateRegionBar(container);
    _updateGroupHeads(container);
    return;
  }
  let hidden = 0, kept = 0;
  container.querySelectorAll(".svc-card, .direct-card").forEach(function (card) {
    // 州筛选按「途经州」匹配（data-regions 由服务端途经州集合渲染）——
    // 旧版只比对起点州标签，穿越多州的长途班次（RE 8 Wismar→Baruth 标
    // MV/Brandenburg）筛 Berlin 时会整体消失，只剩市内碎片班次
    const regs = (card.dataset.regions || card.dataset.region || "").split("|").filter(Boolean);
    if (regs.indexOf(regionFilter) >= 0) { card.classList.remove("region-hidden"); kept++; }
    else { card.classList.add("region-hidden"); hidden++; }
  });
  _updateGroupHeads(container);
  // 高亮当前州 + 显示清空按钮
  updateRegionBar(container);
}
function bindRegionChips(container) {
  // :not(.time-chip)——时间筛选条 chips 复用 region-chip 样式，不能被州筛选绑定
  container.querySelectorAll(".region-chip:not(.time-chip)").forEach(function (chip) {
    chip.addEventListener("click", function (e) {
      e.stopPropagation(); // 防止冒泡到卡片
      const r = chip.dataset.region || chip.textContent;
      regionFilter = (regionFilter === r) ? "" : r; // 同州再次点击 = 清空
      applyRegionFilter(container);
      // 高亮当前选中的 chip
      container.querySelectorAll(".region-chip:not(.time-chip)").forEach(function (c) {
        c.classList.toggle("active", c.dataset.region === regionFilter);
      });
    });
  });
}

// ── 时间筛选条（2026-09-10 用户手绘定稿：与「筛选州」并列的「筛选时间」chips）──
// 与州筛选可组合（州 ∩ 时段）；组头计数/标题徽标同时计入两个筛选。
let timeFilter = ""; // 空 = 不过滤；值 = 时段桶 key（early/morning/...）
function _cardVisible(c) {
  return !c.classList.contains("region-hidden") && !c.classList.contains("time-hidden");
}
function renderTimeBar(container) {
  if (!container) return;
  const oldBar = container.querySelector(".time-filter-bar");
  if (oldBar) oldBar.remove();
  const counts = new Map();
  container.querySelectorAll(".svc-card, .direct-card").forEach(function (card) {
    const h = parseInt((card.dataset.dep || "00:00").slice(0, 2), 10);
    if (isNaN(h)) return;
    for (const d of _PERIOD_DEFS()) {
      if (h >= d.lo && h < d.hi) { counts.set(d.key, (counts.get(d.key) || 0) + 1); break; }
    }
  });
  if (counts.size < 2) return; // 单一时段无需筛选
  const bar = document.createElement("div");
  bar.className = "region-filter-bar time-filter-bar";
  bar.innerHTML = '<span class="region-bar-label">' + escapeHtml(t("svc.filterTime")) + "</span>" +
    _PERIOD_DEFS().filter(function (d) { return counts.has(d.key); }).map(function (d) {
      return '<button type="button" class="region-chip time-chip" data-period="' + d.key + '">' +
        escapeHtml(d.label) + '<span class="region-n">' + counts.get(d.key) + "</span></button>";
    }).join("") +
    '<button type="button" class="region-clear time-clear" aria-label="清空时间筛选">×</button>';
  bar.querySelector(".time-clear").addEventListener("click", function () {
    timeFilter = "";
    if (typeof lastSvcData !== "undefined" && lastSvcData) renderServices(lastSvcData.line, lastSvcData.svc, lastSvcData.destination, lastSvcData.opts);
  });
  // 插到州筛选条之后（都存在时）
  const regionBar = container.querySelector(".region-filter-bar:not(.time-filter-bar)");
  if (regionBar && regionBar.nextSibling) container.insertBefore(bar, regionBar.nextSibling);
  else if (regionBar) container.appendChild(bar);
  else container.insertBefore(bar, container.firstChild);
  bar.querySelectorAll(".time-chip").forEach(function (chip) {
    chip.addEventListener("click", function (e) {
      e.stopPropagation();
      const k = chip.dataset.period || "";
      timeFilter = (timeFilter === k) ? "" : k; // 同档再次点击 = 清空
      applyTimeFilter(container);
    });
  });
  updateTimeBar(container);
}
function updateTimeBar(container) {
  if (!container) return;
  const bar = container.querySelector(".time-filter-bar");
  if (!bar) return;
  bar.querySelectorAll(".time-chip").forEach(function (c) {
    c.classList.toggle("active", !!timeFilter && c.dataset.period === timeFilter);
  });
  const clr = bar.querySelector(".time-clear");
  if (clr) clr.style.display = timeFilter ? "" : "none";
}
function applyTimeFilter(container) {
  if (!container) return;
  if (!timeFilter) {
    container.querySelectorAll(".svc-card.time-hidden, .direct-card.time-hidden").forEach(function (c) {
      c.classList.remove("time-hidden");
    });
    updateTimeBar(container);
    _updateGroupHeads(container);
    return;
  }
  const def = _PERIOD_DEFS().find(function (d) { return d.key === timeFilter; });
  if (!def) { timeFilter = ""; return applyTimeFilter(container); }
  container.querySelectorAll(".svc-card, .direct-card").forEach(function (card) {
    const h = parseInt((card.dataset.dep || "00:00").slice(0, 2), 10);
    const inBucket = !isNaN(h) && h >= def.lo && h < def.hi;
    if (inBucket) card.classList.remove("time-hidden");
    else card.classList.add("time-hidden");
  });
  _updateGroupHeads(container);
  updateTimeBar(container);
}

function duration_min_str(m) {
  if (!m && m !== 0) return "—";
  const h = Math.floor(m / 60), mm = m % 60;
  if (h > 0) return h + ":" + (mm < 10 ? "0" + mm : mm);
  return String(mm);
}

/* ---------- 新：真实预测展示 ---------- */

// 生成 zugfinder 车次页面链接（如 RE 7 定位到 RE 74423 → train-RE_74423-30-Dessau_Hbf；
// 格式与 zugfinder.net 页面一致：车型_车号-30-终点站，站名内空格→下划线）
function zugfinderUrl(train, finalStation) {
  const { type, num } = splitTrainLine(train);
  const key = (type ? type + "_" : "") + num;
  const st = (finalStation || "").trim()
    ? "-" + encodeURIComponent(finalStation.trim()).replace(/%20/g, "_")
    : "";
  return "https://www.zugfinder.net/en/train-" + key + "-30" + st;
}

// 更新页脚 zugfinder 链接（预测结果后调用；无有效车号时隐藏）
function updateZugLink(train, finalStation) {
  const el = document.getElementById("zugLink");
  if (!el) return;
  const { type, num } = splitTrainLine(train || "");
  if (!type || !num) { el.classList.add("hidden"); return; }
  el.href = zugfinderUrl(train, finalStation);
  el.textContent = t("footer.zugLink", { train: type + " " + num });
  el.classList.remove("hidden");
}

function renderPredict(d) {
  hideStatus();
  // 走向防御提示（server 端 interval_warning）：请求区间未被返回数据覆盖
  // ——复用号线路级查询可能落到全国同名线的另一个州变体，如实告知而非假装正确。
  const _iwEl = document.getElementById("routeDelayStatus");
  if (d.interval_warning && _iwEl) {
    _iwEl.textContent = t("route.intervalWarning", { from: d.interval_warning.from, to: d.interval_warning.to });
    _iwEl.classList.add("warn");
    _iwEl.classList.remove("hidden");
    setTimeout(function () { _iwEl.classList.add("hidden"); }, 15000);
  } else if (_iwEl) {
    _iwEl.classList.remove("warn");
  }
  predictEl.classList.remove("hidden");
  resultsEl.classList.add("hidden");
  document.getElementById("predictionHead").classList.remove("hidden");
  // 查晚点 tab 的 loading 条（route.searchingInterval）随结果出现立即收起——
  // 否则「上面还在查询班次、下面已出结果」（2026-09-09 用户原话）
  const _dr = document.getElementById("routeDelayResult");
  if (_dr) _dr.classList.add("hidden");
  currentData = d; // 供分享
  updateShareVisibility();
  // 评论区跟随当前查询：车次预测页 → 该车次评论；首页 → 全局评论
  loadComments();

  // 缓存该车次实际停靠站（仅供 fromInput 联动筛选——避免显示无关车站）。
  // 重要：不要把 stationList 覆盖为车次停靠站！
  //   stationList 是 fromInput/toInput 共享的 datalist；若改成车次停靠站，
  //   用户后续选择别的起/终点时会只看到该车次的 17 个站，无法换线。
  if (d.stations && d.stations.length) {
    cachedTrainStations = { train: d.train || currentLine || "", stations: d.stations };
  } else {
    // 该车次无站序数据：清空缓存，避免旧车次停靠站污染后续站名下拉建议
    cachedTrainStations = { train: "", stations: null };
  }

  const p = d.prediction || {};
  // 已训练 LightGBM v5wxhr 模型预测（主预测；含天气特征；缺失时回落基线中位数）
  const m = (d.model && d.model.available) ? d.model : null;
  // 显示目的站（站对站模式）
  const dest = p.destination || "";
  const trainLabel = d.train || "";
  // ride.train_number 现为完整车次号（如 "RE_26709"）：展示时下划线→空格 → "#RE 26709"
  const rideNum = d.ride && d.ride.train_number
    ? "#" + String(d.ride.train_number).replace(/_/g, " ") : "";
  document.getElementById("pTrain").textContent =
    trainLabel + (rideNum ? " " + rideNum : "") + (dest ? " → " + dest : "");
  // 页脚 zugfinder 链接：优先定位到的具体车号（d.ride.train_number，如 RE 74423），否则查询车次
  updateZugLink((d.ride && d.ride.train_number) || d.train || "",
                d.stations && d.stations.length ? d.stations[d.stations.length - 1] : "");
  const total = (d.recent || []).length;
  const valid = d.n_valid_days ?? 0;
  const limited = d.n_rate_limited_days ?? 0;
  const matched = p.destination_matched_days ?? valid;
  const fallback = !!p.fallback_to_end;
  let meta = t("meta.base", { date: d.prediction_date || "—", matched: matched, total: total });
  if (d.data_date_range) meta += t("meta.window", { range: d.data_date_range });
  if (dest) meta += t("meta.dest", { dest: dest });
  if (fallback) meta += t("meta.fallback");
  // 线路联邦州指纹（同名车次多线路：如 RE 11 在 NRW 与 Sachsen 各有一条）
  const ln = d.line || {};
  if (ln.main_states && ln.main_states.length) {
    meta += t("meta.line", { states: ln.main_states.join(" · ") });
  }
  if (ln.conflict && ln.destination_auto && ln.queried_destination) {
    meta += t("meta.lineConflict", { orig: ln.queried_destination, auto: ln.destination_auto });
  }
  if (ln.cross_line_filtered_days > 0) {
    meta += t("meta.lineFiltered", { n: ln.cross_line_filtered_days });
  }
  if (limited > 0) meta += t("meta.limited", { n: limited });
  const running = d.running || null;
  if (running) {
    meta += t("meta.running", { station: running.current_station || "?", delay: Math.round(running.current_delay) });
  }
  let metaHtml = escapeHtml(meta);
  document.getElementById("pMeta").innerHTML = metaHtml;
  // 数据来源行：不再展示来源文本（用户只关注晚点率），仅保留限流/异常警告
  const srcEl = document.getElementById("pSource");
  if (srcEl) {
    srcEl.textContent = "";
    srcEl.classList.add("hidden");
  }
  renderDataQuality(d, valid, limited, matched, total, fallback);

  // 德铁官方次日开行校验（实验；unknown=未确认，不打扰）
  const dbEl = document.getElementById("dbStatus");
  const db = d.db_status || {};
  if (dbEl) {
    if (db.status === "canceled") {
      dbEl.textContent = db.note || t("db.canceled");
      dbEl.className = "db-banner db-cancel";
    } else if (db.status === "confirmed") {
      dbEl.textContent = db.note || t("db.confirmed");
      dbEl.className = "db-banner db-ok";
    } else {
      dbEl.textContent = "";
      dbEl.className = "db-banner hidden";
    }
  }

  // 实验性取消概率（统一口径：同线班次经验取消率；模型侧未校准概率不展示）
  const pCancel = document.getElementById("pCancel");
  const cp = d.cancellation_prob || {};
  if (pCancel) {
    pCancel.textContent = (cp.prob === null || cp.prob === undefined)
      ? "—" : Math.round(cp.prob * 100) + "%";
    pCancel.className = "mcard-value" +
      (cp.prob !== null && cp.prob >= 0.2 ? " warn" : "");
    if (cp.prob === null || cp.prob === undefined) {
      pCancel.title = cp.source === "piebro_line_fallback"
        ? t("predict.cancelHintFallback", { n: cp.n_rides || 0 })
        : t("predict.cancelNoData");
    } else if (cp.cross_line_rides_dropped) {
      pCancel.title = t("predict.cancelHint", { n: cp.n_rides, d: cp.n_dates })
        + " · " + t("predict.cancelHintCross", { m: cp.cross_line_rides_dropped });
    } else {
      pCancel.title = t("predict.cancelHint", { n: cp.n_rides, d: cp.n_dates });
    }
  }

  // 空数据兜底：后端 warning 优先（车次不存在等），其次限流提示
  const emptyEl = document.getElementById("pEmpty");
  const warn = d.warning || "";
  if (warn) {
    emptyEl.innerHTML = '<div class="empty-banner">⚠️ ' + escapeHtml(warn) + '</div>';
    emptyEl.classList.remove("hidden");
  } else if (valid === 0 && (limited === total || total === 0)) {
    emptyEl.innerHTML = '<div class="empty-banner">' + t("empty.rateLimited", { n: Math.max(total, limited) }) + '</div>';
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    emptyEl.innerHTML = "";
  }

  // 主预测值：模型优先，基线兜底
  const point = (m && m.point_estimate != null) ? m.point_estimate : p.point_estimate;
  document.getElementById("pPointLabel").textContent = predictDateLabel();
  document.getElementById("pPoint").innerHTML =
    point === null || point === undefined
      ? "—"
      : `${Math.round(point)} <span class="unit">${t("unit.min")}</span>`;
  const ivPair = (m && m.q10 != null && m.q90 != null) ? [m.q10, m.q90]
              : (p.p10 != null && p.p90 != null) ? [p.p10, p.p90] : null;
  const iv = ivPair
    ? `${Math.round(ivPair[0])}–${Math.round(ivPair[1])} <span class="unit">${t("unit.min")}</span>`
    : "—";
  document.getElementById("pInterval").innerHTML = iv;
  const p15 = (m && m.prob_ge15 != null) ? m.prob_ge15 : p.prob_ge15;
  document.getElementById("pProb15").textContent =
    p15 === null || p15 === undefined ? "—" : `${Math.round(p15 * 100)}%`;
  document.getElementById("pProb15").className =
    "mcard-value" + (p15 !== null && p15 >= 0.8 ? " warn" : "");
  // 今日实际 / 运行中当前延误（补正；running 已在 pMeta 处声明）
  const todayEl = document.getElementById("pToday");
  const todayLblEl = document.getElementById("pTodayLabel");
  const todayVal = p.today_actual;
  const todayIsToday = p.today_actual_is_today !== false;  // 缺省视为今日（兼容旧响应）
  if (running && todayVal != null) {
    // 运行中：显示"当前 N 分"，并在 title 里给出当前位置（不冒充终点延误）
    todayEl.textContent = t("today.running", { m: Math.round(todayVal) });
    todayEl.title = t("today.runningTitle", { station: running.current_station || "?", m: Math.round(todayVal) });
    if (todayLblEl) {
      todayLblEl.removeAttribute("data-i18n");
      todayLblEl.textContent = t("predict.todayLabel");
    }
  } else if (todayVal != null && !todayIsToday) {
    // 回退到历史日：明确标注日期，不冒充"今日实际"（2026-09-18 边界防护）
    const src = p.today_actual_from || "";
    todayEl.textContent = fmtDelay(todayVal);
    todayEl.title = t("today.lastKnownTitle", { date: src, m: Math.round(todayVal) });
    if (todayLblEl) {
      todayLblEl.removeAttribute("data-i18n");
      todayLblEl.textContent = t("today.lastKnown", { date: src });
    }
  } else {
    todayEl.textContent =
      todayVal === null || todayVal === undefined ? "—" : fmtDelay(todayVal);
    todayEl.title = "";
    if (todayLblEl) {
      todayLblEl.removeAttribute("data-i18n");
      todayLblEl.textContent = t("today.actual");
    }
  }
  todayEl.className =
    "mcard-value" + (todayVal !== null && todayVal >= 30 ? " warn" : "");

  // 晚点成分构成（历史基线分配 + 当日叠加信号）—— 懒加载：
  // 预测先出，用户点「展开」才请求 /api/breakdown（2026-09-11 用户明确要求）
  renderBreakdownLazy(d);

  // 区间预测（直达卡片 from→to 段延误）
  renderSegment(d);

  // 区间查询（ride_from→ride_to 有实测）时默认展示「区间到达」柱状图：
  // 终点延误是整段口径，对区间查询无意义（2026-09-11 用户反馈「区间晚点返回了整段晚点」）
  const _segOk = !!(d.segment && d.segment.by_day && d.segment.by_day.length);
  const _segBtn = document.getElementById("metricSegmentBtn");
  if (_segBtn) _segBtn.classList.toggle("hidden", !_segOk);
  if (_segOk && !chart10dUserPicked) chart10dMetric = "segment";
  if (!_segOk && chart10dMetric === "segment") chart10dMetric = "end";
  document.querySelectorAll(".chart-toggles .toggle-btn").forEach(function (b) {
    b.classList.toggle("active", b.dataset.metric === chart10dMetric);
  });

  // 近 10 天柱状图（指标切换：区间到达/终点/最大/逐站选站）
  drawChart10d(d, chart10dMetric);

  // 近 3 天逐站曲线
  drawStations(d);

  // 逐站延误：填充选站下拉
  const stSel = document.getElementById("stationSelect");
  if (stSel) {
    stSel.innerHTML = (d.stations || []).map(function (s) {
      return '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + "</option>";
    }).join("");
    if (stSel.options[0]) stSel.value = stSel.options[0].value;
    stSel.classList.toggle("hidden", chart10dMetric !== "station");
  }

  // 逐站时刻表（近三日切换）
  renderDays(d);

  // 无历史数据时只展示明确的空状态，避免把空图表误认为有效预测。
  const noPredictionData = valid === 0;
  updateShareVisibility();
  ["predictionHead", "predictionCards", "chart10dPanel", "chartStationsPanel", "timetablePanel"]
    .forEach(function (id) {
      const panel = document.getElementById(id);
      if (panel) panel.classList.toggle("hidden", noPredictionData);
    });
}

// 晚点成分构成（历史基线分配 + 当日叠加）
var BD_COLORS = {
  kaskade: "#ba2c2c",       // 前车连锁（最常见，最高权重）
  ausfall: "#993c1d",       // 停运
  bau: "#a85e00",           // 施工/维护
  wagen: "#534ab7",         // 改编组
  fahrzeug: "#378add",      // 车辆技术
  infrastruktur: "#0c447c",// 设施/信号
  passagier: "#18794e",     // 乘客相关
  einsatz: "#5f5e5a",       // 紧急介入
  bereitstellung: "#888780",// 晚备车
  wetter: "#155e75",        // 天气
  sonstiges: "#888780",
  strecke: "#7f77dd",
  ausland: "#1d9e75",
  keine: "#b8c4ce",
  ersatz: "#ef9f27"
};
var BREAKDOWN_LABELS = {
  zh: { kaskade: "前车/先前晚点连锁", ausfall: "列车停运/车辆停用", bau: "施工/维护/减速限速", wagen: "改编组", fahrzeug: "列车车辆技术故障", infrastruktur: "设施/信号/道岔/接触网故障", passagier: "乘客相关（候补/医疗/上下客）", einsatz: "紧急部门介入（警察/消防/医疗/官方）", bereitstellung: "晚备车/营运组织/用人", wetter: "天气/自然灾害", sonstiges: "其他/未归类", strecke: "线路障碍（落树/异物/动物）", ausland: "跨境/边境管制", keine: "无原因说明", ersatz: "替代交通/绕行" },
  en: { kaskade: "Knock-on delay from preceding services", ausfall: "Service or vehicle cancellation", bau: "Construction, maintenance and speed restrictions", wagen: "Train formation changes", fahrzeug: "Rolling-stock faults", infrastruktur: "Infrastructure, signalling and overhead-line faults", passagier: "Passenger-related incidents", einsatz: "Emergency-service intervention", bereitstellung: "Operational staffing and rolling-stock provision", wetter: "Weather and natural hazards", sonstiges: "Other or uncategorized", strecke: "Track obstructions", ausland: "Cross-border and border control", keine: "No reason stated", ersatz: "Replacement transport and diversions" },
  de: { kaskade: "Folgeverspätung durch vorherige Züge", ausfall: "Zug- oder Fahrzeugausfall", bau: "Bau, Instandhaltung und Langsamfahrstellen", wagen: "Wagenreihungsänderungen", fahrzeug: "Fahrzeugstörungen", infrastruktur: "Infrastruktur-, Signal- und Oberleitungsstörungen", passagier: "Fahrgastbezogene Ereignisse", einsatz: "Einsatz von Rettungs- und Sicherheitskräften", bereitstellung: "Betrieb, Personal und Bereitstellung", wetter: "Wetter und Naturereignisse", sonstiges: "Sonstiges oder nicht zugeordnet", strecke: "Hindernisse auf der Strecke", ausland: "Grenzverkehr und Grenzkontrollen", keine: "Keine Ursache angegeben", ersatz: "Ersatzverkehr und Umleitungen" }
};
function breakdownLabel(category, fallback) {
  var labels = BREAKDOWN_LABELS[getLang()] || BREAKDOWN_LABELS.zh;
  return labels[category] || fallback || category;
}

// ── breakdown 懒加载层（2026-09-11）──
// 预测响应不再内联 breakdown（服务端已拆到 /api/breakdown）。
// 这里先渲染「展开分析」闸门；用户点击才 fetch，结果按 train|date 参数缓存。
var _bdLazy = { cache: {}, key: "", q: null };
function _bdLazyKey(d) {
  // 以服务端回显的规范参数（d._query）为准——前端 lastQuery 是 sanitizeStation
  // 归一化后的站名，与原 /api/train URL 原文不同，会导致 cacheKey 不一致 → 410
  var q = (d && d._query) || null;
  if (!q) return [(d && d.train) || "", predictDateISO() || ""].join("|");
  return [q.train, q.date, q.destination, q.ride_from, q.ride_to, q.ride_time].join("|");
}
function renderBreakdownLazy(d) {
  var panel = document.getElementById("breakdownPanel");
  if (!panel) return;
  // 兼容旧快照/旧内存缓存：响应自带 breakdown → 直接渲染
  if (d && d.breakdown && d.breakdown.historical && d.breakdown.historical.length) {
    renderBreakdown(d);
    return;
  }
  if (!d || !d.train) { panel.classList.add("hidden"); return; }
  var gate = document.getElementById("bdLazyGate");
  var grid = document.getElementById("bdGrid");
  if (!gate || !grid) { // 无闸门元素（异常布局）→ 直接隐藏面板兜底
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  grid.style.display = "none";      // 主体先藏，展开后再渲染
  gate.style.display = "";
  _bdLazy.key = _bdLazyKey(d);
  _bdLazy.train = d.train;
  _bdLazy.q = d._query || null;
  var btn = document.getElementById("bdLazyBtn");
  if (btn) {
    btn.disabled = false;
    // 文案复位（i18n 切语言时 applyI18n 会刷 data-i18n span；这里复位按钮自身文案）
    var sp = btn.querySelector("span:last-child");
    if (sp) sp.textContent = t("breakdown.lazyGate");
  }
}
function expandBreakdownNow() {
  var gate = document.getElementById("bdLazyGate");
  var grid = document.getElementById("bdGrid");
  var panel = document.getElementById("breakdownPanel");
  var btn = document.getElementById("bdLazyBtn");
  if (!gate || !grid || !panel) return;
  var cached = _bdLazy.cache[_bdLazy.key];
  if (cached) {
    renderBreakdown({ breakdown: cached });
    return;
  }
  if (btn) { btn.disabled = true; var sp = btn.querySelector("span:last-child"); if (sp) sp.textContent = t("breakdown.lazyLoading"); }
  // 用服务端回显的规范参数原样回放（与原 /api/train 请求严格同 key）
  var q = _bdLazy.q || {};
  var url = "/api/breakdown?train=" + encodeURIComponent(q.train || _bdLazy.train || "") +
    (q.date ? "&date=" + encodeURIComponent(q.date) : "") +
    (q.destination ? "&destination=" + encodeURIComponent(q.destination) : "") +
    (q.ride_from ? "&ride_from=" + encodeURIComponent(q.ride_from) : "") +
    (q.ride_to ? "&ride_to=" + encodeURIComponent(q.ride_to) : "") +
    (q.ride_time ? "&ride_time=" + encodeURIComponent(q.ride_time) : "") +
    "&days=" + (q.days || 8);
  fetch(url, { cache: "no-store" })
    .then(function (r) { return r.json().catch(function () { return { error: "bad json", status: r.status }; }); })
    .then(function (j) {
      if (j && j.breakdown && j.breakdown.historical && j.breakdown.historical.length) {
        _bdLazy.cache[_bdLazy.key] = j.breakdown;
        renderBreakdown({ breakdown: j.breakdown });
      } else {
        // 410（服务重启且当日缓存失效）或空数据 → 提示 + 提供重试
        _bdLazyFail(j);
      }
    })
    .catch(function () { _bdLazyFail({ error: "network" }); });
}

// breakdown 懒加载失败：面板内提示 + 独立「重试」按钮（不依赖顶部 status 的 lastQuery，
// 因为 breakdown 可在主预测之后很久才点开，lastQuery 语义不匹配）。
function _bdLazyFail(j) {
  var gate = document.getElementById("bdLazyGate");
  var btn = document.getElementById("bdLazyBtn");
  var detail = j && j.hint ? j.hint : t("breakdown.lazyFail");
  if (gate) gate.style.display = "none";
  var box = document.getElementById("bdLazyErr");
  if (!box) {
    box = document.createElement("div");
    box.id = "bdLazyErr";
    box.className = "bd-note bd-note-warn";
    if (gate && gate.parentElement) gate.parentElement.insertBefore(box, gate);
  }
  box.style.display = "";
  box.textContent = detail + " ";
  var retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn-link";
  retry.textContent = t("btn.retry");
  retry.addEventListener("click", function () {
    box.style.display = "none";
    _bdLazy.cache[_bdLazy.key] = null;
    if (gate) gate.style.display = "";
    expandBreakdownNow();
  });
  if (!box.querySelector("button")) box.appendChild(retry);
  if (btn) { btn.disabled = false; var sp = btn.querySelector("span:last-child"); if (sp) sp.textContent = t("breakdown.lazyGate"); }
}
(function () {
  var btn = document.getElementById("bdLazyBtn");
  if (btn) btn.addEventListener("click", expandBreakdownNow);
})();
// 晚点成分构成面板：点击标题栏折叠 / 展开（2026-09-16 修复「展开就收不回」）
(function () {
  var head = document.getElementById("bdHead");
  if (!head) return;
  function toggle() {
    var panel = document.getElementById("breakdownPanel");
    if (!panel || panel.classList.contains("hidden")) return;
    var collapsed = panel.classList.toggle("bd-collapsed");
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
})();

function renderBreakdown(d) {
  var panel = document.getElementById("breakdownPanel");
  if (!panel) return;
  var bd = d && d.breakdown;
  if (!bd || !bd.historical || bd.historical.length === 0) {
    panel.classList.add("hidden");
    return;
  }
  window._lastBreakdownPayload = d; // 供语言切换时重渲染（动态文案不走 data-i18n）
  panel.classList.remove("hidden");
  // 展开态：清折叠标记，确保内容可见（折叠由用户主动点 bdHead 触发）
  panel.classList.remove("bd-collapsed");
  var _bh = document.getElementById("bdHead");
  if (_bh) _bh.setAttribute("aria-expanded", "true");
  // 展开态：藏闸门、显主体（懒加载与内联两条路径都经过这里）
  var gate = document.getElementById("bdLazyGate");
  var grid = document.getElementById("bdGrid");
  if (gate) gate.style.display = "none";
  if (grid) grid.style.display = "";
  var lazyErr = document.getElementById("bdLazyErr");
  if (lazyErr) lazyErr.style.display = "none";
  // 头部 meta
  document.getElementById("bdDest").textContent = bd.destination || "—";
  document.getElementById("bdRegion").textContent = bd.region || "—";
  // 「按线路历史画像」标识：区分「本线路专属」与「全网全局兜底」
  var profNote = document.getElementById("bdProfileNote");
  if (profNote) {
    if (bd.line_key && bd.line_profile_based_on) {
      profNote.textContent = t("breakdown.histNoteLine", { line: bd.line_key }) +
        "（" + t("breakdown.estimated") + "）";
      profNote.style.color = "";
    } else {
      profNote.textContent = t("breakdown.histNoteGlobal");
      profNote.style.color = "var(--muted)";
    }
  }
  // 线路实测延误特征卡（方案 C·B）
  renderLineStats(bd.line_stats, bd.line_key);
  // 原因编码实测表（raw_data 直算）
  renderTopCodes(bd.top_codes, bd.reason_window);
  // 原因正文分类（zugfinder 730 天）
  renderZfCats(bd.zf_cats, bd.zf_meta);
  // 本车次原因成分实测（三级降级：本车次 → 线路 → 全网）
  renderTrainComposition(bd.train_composition, bd.train_composition_src,
                         bd.train_composition_sample, bd.train_meta);
  // 实时原因/事件按钮：仅当本次查询有车次（可回溯 IRIS）时显示
  var incBtn = document.getElementById("bdIncidentsBtn");
  var incBox = document.getElementById("bdIncidentsBox");
  if (incBtn) {
    var hasTrain = !!(bd.line_key || (window._lastTrainCtx && window._lastTrainCtx.train));
    incBtn.style.display = hasTrain ? "" : "none";
    if (incBox) incBox.style.display = "none";
    incBtn.onclick = function () {
      // 再次点击：若已展开且有内容则收起（解决「查看后收不回」）
      if (incBox && incBox.style.display !== "none" && incBox.innerHTML) {
        incBox.style.display = "none";
        return;
      }
      loadRealtimeIncidents();
    };
  }
  // 点估计≈0 时按 share_pct 分配出的「分钟数」恒为 0（12 行全 0.0 分），
  // 此时分钟数失去意义，列表主值改为展示历史占比 share_pct%，并给出提示。
  var point = bd.point_estimate;
  var hasPoint = (point !== null && point !== undefined && Number(point) > 0);
  var zeroNote = document.getElementById("bdZeroNote");
  if (zeroNote) {
    if (hasPoint) {
      zeroNote.style.display = "none";
      zeroNote.textContent = "";
    } else {
      zeroNote.style.display = "";
      zeroNote.textContent = t("breakdown.zeroPoint");
    }
  }
  // 历史堆叠柱 + 列表
  var visible = bd.historical.filter(function (h) { return h.share_pct > 0; });
  var barEl = document.getElementById("bdBar");
  barEl.innerHTML = visible.map(function (h) {
    return '<div class="seg" style="width:' + h.share_pct + '%; background:' +
      (BD_COLORS[h.category] || "#888780") + '" title="' + escapeHtml(breakdownLabel(h.category, h.cn)) +
      ' · ' + h.share_pct.toFixed(1) + '%' +
      (hasPoint ? ' · ' + h.minutes.toFixed(1) + ' ' + t("breakdown.unitMin") : '') + '"></div>';
  }).join("");
  var listEl = document.getElementById("bdList");
  listEl.innerHTML = visible.map(function (h) {
    var valHtml = hasPoint
      ? '<strong>' + h.minutes.toFixed(1) + '</strong> ' + t("breakdown.unitMin") +
        ' · ' + h.share_pct.toFixed(1) + '%'
      : '<strong>' + h.share_pct.toFixed(1) + '%</strong> <small style="color:var(--muted)">(' +
        t("breakdown.histShare") + ')</small>';
    return '<li>' +
      '<span class="dot" style="background:' + (BD_COLORS[h.category] || "#888780") + '"></span>' +
       '<span class="bd-cn">' + escapeHtml(breakdownLabel(h.category, h.cn)) + '</span>' +
      '<span class="bd-v">' + valHtml + '</span>' +
      '</li>';
  }).join("");
  // 当日叠加信号
  var today = bd.today || {};
  var wEl = document.getElementById("bdWeather");
  if (!bd.region) {
    wEl.innerHTML = '<span style="color:var(--muted)">' + escapeHtml(t("breakdown.noRegion")) + '</span>';
  } else if (today.weather_no_data) {
    var range = (today.weather_min_date && today.weather_max_date)
      ? today.weather_min_date + " ~ " + today.weather_max_date : "—";
    wEl.innerHTML = '<span style="color:var(--muted)" title="' + escapeHtml(range) + '">' +
      escapeHtml(t("breakdown.weatherNoData")) + '</span>';
  } else if (today.weather_delay_min === 0) {
    wEl.innerHTML = '<span style="color:var(--green,#18794e)">0 ' + t("breakdown.unitMin") + '</span>' +
      ' <small style="color:var(--muted)">(' + escapeHtml(t("breakdown.weatherClear")) + ')</small>';
  } else {
    wEl.innerHTML = '<strong>' + today.weather_delay_min.toFixed(1) + '</strong> ' +
      t("breakdown.unitMin");
  }
  var cEl = document.getElementById("bdIncCount");
  cEl.textContent = (today.incidents || []).length;
  var listIEl = document.getElementById("bdIncList");
  var incs = today.incidents || [];
  if (incs.length) {
    listIEl.innerHTML = incs.map(function (x) {
      var sev = x.severity ? '<span class="sev">' + escapeHtml(x.severity) + '</span>' : "";
      return '<div class="bd-event">' +
        '<div class="per">' + escapeHtml(x.start_date) + ' → ' + escapeHtml(x.end_date) +
        ' · ' + (x.delay_min || 0) + ' ' + t("breakdown.unitMin") + '</div>' +
        '<div><span class="ca">' + escapeHtml((x.cause || "").slice(0, 70)) + '</span>' + sev + '</div>' +
        '</div>';
    }).join("");
  } else {
    listIEl.innerHTML = '<div class="bd-empty">' + escapeHtml(t("breakdown.noEvents")) + '</div>';
  }
}

// 线路实测延误特征卡（方案 C·B：PieBro 历史真实统计）
function renderLineStats(stats, lineKey) {
  var box = document.getElementById("bdLineStats");
  if (!box) return;
  if (!stats) {
    box.innerHTML = '<div class="bd-empty">' +
      (lineKey ? t("breakdown.lineStatsMissing") : t("breakdown.lineStatsNoLine")) + '</div>';
    return;
  }
  function row(label, val, unit) {
    return '<div class="ls-row"><span class="ls-lbl">' + escapeHtml(label) + '</span>' +
      '<span class="ls-val">' + escapeHtml(String(val)) + (unit ? ' <small>' + escapeHtml(unit) + '</small>' : '') + '</span></div>';
  }
  var html = "";
  html += row(t("breakdown.lsRides"), stats.n_rides, t("breakdown.lsRidesUnit"));
  html += row(t("breakdown.lsAvg"), stats.avg_delay, t("breakdown.unitMin"));
  html += row(t("breakdown.lsP95"), stats.p95_delay, t("breakdown.unitMin"));
  html += row(t("breakdown.lsZero"), stats.zero_delay_pct, "%");
  html += row(t("breakdown.lsCancel"), stats.cancel_pct, "%");
  if (stats.top_stations && stats.top_stations.length) {
    html += '<div class="ls-stations"><div class="ls-lbl">' + t("breakdown.lsTopStations") + '</div>';
    html += stats.top_stations.map(function (s) {
      return '<div class="ls-st"><span class="ls-sn">' + escapeHtml(s.name) + '</span>' +
        '<span class="ls-sv">' + Math.round(s.delay) + ' ' + t("breakdown.unitMin") + '</span></div>';
    }).join("");
    html += '</div>';
  }
  box.innerHTML = html;
}

// 原因编码实测表：raw_data 直算的「DB 延误编码 → 实测延误/取消率」。
// 这是全站唯一带实测量的原因视角（不含正文，但可量化「哪类原因更致命」）。
function renderTopCodes(codes, window) {
  var box = document.getElementById("bdTopCodes");
  if (!box) return;
  if (!codes || !codes.length) { box.innerHTML = ""; return; }
  var head = '<div class="tc-head">' +
    '<span class="tc-title">' + escapeHtml(t("breakdown.tcTitle")) + '</span>' +
    (window && window[0] ? '<span class="tc-win">' + escapeHtml(window[0]) + '</span>' : '') +
    '</div>';
  var rows = codes.map(function (c) {
    var color = BD_COLORS[c.cat] || "#888780";
    var dd = (c.avg_delay != null ? c.avg_delay.toFixed(1) : "—");
    var cc = (c.cancel_pct != null ? c.cancel_pct.toFixed(0) + "%" : "—");
    var cls = (c.avg_delay != null && c.avg_delay >= 15) ? " tc-hi"
            : (c.avg_delay != null && c.avg_delay >= 8) ? " tc-mid" : "";
    return '<div class="tc-row' + cls + '">' +
      '<span class="tc-dot" style="background:' + color + '"></span>' +
      '<span class="tc-code">#' + c.code + '</span>' +
      '<span class="tc-cat">' + escapeHtml(t("cat." + c.cat) !== "cat." + c.cat ? t("cat." + c.cat) : c.cat) + '</span>' +
      '<span class="tc-d">+' + escapeHtml(dd) + ' ' + escapeHtml(t("breakdown.unitMin")) + '</span>' +
      '<span class="tc-c">' + escapeHtml(cc) + '</span>' +
      '</div>';
  }).join("");
  box.innerHTML = head + rows;
}

// 本车次原因成分实测：百分比条 + 折算分钟，标注数据来源与样本规模。
// src: "train"（本车次实测）/ "line"（线路画像）/ "global"（全网基线）
function renderTrainComposition(comp, src, sample, meta) {
  var box = document.getElementById("bdTrainComp");
  if (!box) return;
  if (!comp || !comp.length) { box.innerHTML = ""; return; }

  // 来源徽标：颜色区分可信度
  var srcKey = src || "global";
  var badgeCls = "tcomp-badge tcomp-" + srcKey;
  var badgeTxt = t("breakdown.tcompSrc" + (srcKey.charAt(0).toUpperCase() + srcKey.slice(1)));

  // 样本描述
  var sampleTxt = "";
  if (sample) {
    if (srcKey === "train") {
      sampleTxt = t("breakdown.tcompSampleTrain", {
        d: sample.days, s: fmtNum(sample.stops), c: fmtNum(sample.coded),
        w: (sample.window && sample.window[0]) ? sample.window[0] + "~" + sample.window[1] : "—"
      });
    } else if (srcKey === "line") {
      sampleTxt = t("breakdown.tcompSampleLine", { line: sample.line_key || "—" });
    } else {
      sampleTxt = t("breakdown.tcompSampleGlobal", { n: fmtNum(sample.n_stops) });
    }
  }

  var head = '<div class="tcomp-head">' +
    '<span class="tcomp-title">' + escapeHtml(t("breakdown.tcompTitle")) + '</span>' +
    '<span class="' + badgeCls + '">' + escapeHtml(badgeTxt) + '</span>' +
    '</div>' +
    (sampleTxt ? '<div class="tcomp-sample">' + escapeHtml(sampleTxt) + '</div>' : '');

  // 顶部堆叠条（只显示前 6 类，其余归"其他"）
  var TOPN = 6;
  var shown = comp.slice(0, TOPN);
  var restPct = comp.slice(TOPN).reduce(function (s, c) { return s + (c.share_pct || 0); }, 0);
  var segs = shown.map(function (c) {
    return '<span class="tcomp-seg" style="width:' + c.share_pct + '%;background:' +
      (BD_COLORS[c.category] || "#888780") + '" title="' +
      escapeHtml(breakdownLabel(c.category) + " " + c.share_pct.toFixed(1) + "%") + '"></span>';
  }).join("");
  if (restPct > 0.5) {
    segs += '<span class="tcomp-seg tcomp-seg-rest" style="width:' + restPct.toFixed(2) +
      '%" title="' + escapeHtml(t("breakdown.tcompRest")) + '"></span>';
  }

  // 明细行
  var rows = comp.map(function (c, i) {
    var color = BD_COLORS[c.category] || "#888780";
    var sw = Math.max(1, Math.min(100, c.share_pct));
    var cls = i === 0 ? " tcomp-row-top" : "";
    return '<div class="tcomp-row' + cls + '">' +
      '<span class="tcomp-dot" style="background:' + color + '"></span>' +
      '<span class="tcomp-name">' + escapeHtml(breakdownLabel(c.category)) + '</span>' +
      '<span class="tcomp-bar"><span class="tcomp-bar-fill" style="width:' + sw +
        '%;background:' + color + '"></span></span>' +
      '<span class="tcomp-pct">' + c.share_pct.toFixed(1) + '%</span>' +
      '<span class="tcomp-min">+' + (c.minutes != null ? c.minutes.toFixed(2) : "—") + '</span>' +
      '</div>';
  }).join("");

  // 一级数据才附编码/消息明细
  var extra = "";
  if (srcKey === "train" && meta) {
    var codes = meta.codes || {};
    var ck = Object.keys(codes);
    if (ck.length) {
      extra += '<div class="tcomp-codes"><span class="tcomp-codes-lbl">' +
        escapeHtml(t("breakdown.tcompCodes")) + '</span>' +
        ck.slice(0, 8).map(function (k) {
          return '<span class="tcomp-code">#' + escapeHtml(k) + ' <b>' + codes[k] + '</b></span>';
        }).join("") + '</div>';
    }
    var mc = meta.msgcats || {};
    var mk = Object.keys(mc);
    if (mk.length) {
      extra += '<div class="tcomp-codes"><span class="tcomp-codes-lbl">' +
        escapeHtml(t("breakdown.tcompMsgs")) + '</span>' +
        mk.slice(0, 6).map(function (k) {
          return '<span class="tcomp-code">' + escapeHtml(k) + ' <b>' + mc[k] + '</b></span>';
        }).join("") + '</div>';
    }
  }

  box.innerHTML = head + '<div class="tcomp-stack">' + segs + '</div>' + rows + extra;
}

// zugfinder 原因正文分类（730 天归档）：可读的德文原因 + 实测延误强度。
// 与上方「编码」表互补——编码看规模、正文看语义。
function renderZfCats(cats, meta) {
  var box = document.getElementById("bdZfCats");
  if (!box) return;
  if (!cats || !cats.length) { box.innerHTML = ""; return; }
  // 视图模式：count=记录占比 / delay=延误分钟贡献（严重度加权）
  // 默认 delay —— 单纯记录占比会低估「线路障碍」这类少而重的原因。
  var mode = window._zfViewMode || "delay";
  var head = "";
  if (meta && meta.avg_with != null) {
    head = '<div class="zf-meta">' +
      '<span>' + escapeHtml(t("breakdown.zfSample", {
        n: fmtNum(meta.with_remark), pct: (meta.remark_pct != null ? meta.remark_pct : 0)
      })) + '</span>' +
      '<span class="zf-vs">' + escapeHtml(t("breakdown.zfVs", {
        a: meta.avg_with, b: meta.avg_without
      })) + '</span>' +
      '</div>';
  }
  // 视图切换按钮（记录数 / 延误影响）
  var hasDelay = cats.some(function (c) { return c.delay_share_pct != null; });
  var toggle = hasDelay
    ? '<div class="zf-toggle">' +
        '<button type="button" class="zf-tbtn' + (mode === "count" ? " on" : "") + '" data-zfview="count">' +
          escapeHtml(t("breakdown.zfViewCount")) + '</button>' +
        '<button type="button" class="zf-tbtn' + (mode === "delay" ? " on" : "") + '" data-zfview="delay">' +
          escapeHtml(t("breakdown.zfViewDelay")) + '</button>' +
      '</div>'
    : "";
  // 按当前模式排序
  var sorted = cats.slice().sort(function (a, b) {
    var av = mode === "delay" ? (a.delay_share_pct || 0) : (a.pct || 0);
    var bv = mode === "delay" ? (b.delay_share_pct || 0) : (b.pct || 0);
    return bv - av;
  });
  var rows = sorted.map(function (c) {
    var val = mode === "delay" ? (c.delay_share_pct || 0) : (c.pct || 0);
    var w = Math.max(2, Math.min(100, val * 1.6));
    var sev = c.severity || 2;
    // 影响倍率徽标：>1.3 表示「少而重」，是该类原因被低估的信号
    var ratioBadge = "";
    if (mode === "delay" && c.impact_ratio != null && c.impact_ratio >= 1.3) {
      ratioBadge = '<span class="zf-ratio" title="' +
        escapeHtml(t("breakdown.zfRatioTip")) + '">×' +
        c.impact_ratio.toFixed(1) + '</span>';
    }
    return '<div class="zf-row sev' + sev + '" data-cat="' + escapeHtml(c.key) + '">' +
      '<div class="zf-bar" style="width:' + w + '%"></div>' +
      '<span class="zf-name">' + escapeHtml(t("zfcause." + c.key) !== ("zfcause." + c.key) ? t("zfcause." + c.key) : (c.cn || c.key)) + ratioBadge + '</span>' +
      '<span class="zf-pct">' + val.toFixed(1) + '%</span>' +
      '<span class="zf-d">+' + (c.avg_delay != null ? c.avg_delay.toFixed(1) : "—") + '</span>' +
      '</div>';
  }).join("");
  box.innerHTML = head + toggle + rows;
  // 绑定视图切换
  var btns = box.querySelectorAll("[data-zfview]");
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener("click", function () {
      window._zfViewMode = this.getAttribute("data-zfview");
      renderZfCats(window._lastZfCats, window._lastZfMeta);
    });
  }
  window._lastZfCats = cats;
  window._lastZfMeta = meta;
}

function fmtNum(n) {
  if (n == null) return "—";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// 懒加载实时原因/事件（IRIS / bahn.expert 消息），不阻塞晚点显示
function loadRealtimeIncidents() {
  var btn = document.getElementById("bdIncidentsBtn");
  var box = document.getElementById("bdIncidentsBox");
  if (!btn || !box) return;
  var ctx = window._lastTrainCtx || {};
  var train = ctx.train || "";
  if (!train) { box.style.display = ""; box.innerHTML = '<div class="bd-empty">' + t("breakdown.noTrainForInc") + '</div>'; return; }
  btn.disabled = true;
  var origTxt = btn.querySelector("span:last-child") ? btn.querySelector("span:last-child").textContent : "";
  box.style.display = "";
  box.innerHTML = '<div class="bd-inc-loading">' + escapeHtml(t("breakdown.loadingIncidents")) + '</div>';
  var url = "/api/train-incidents?train=" + encodeURIComponent(train) +
    (ctx.date ? "&date=" + encodeURIComponent(ctx.date) : "") +
    (ctx.eva || ctx.station_eva ? "&eva=" + encodeURIComponent(ctx.eva || ctx.station_eva) : "");
  fetch(url, { cache: "no-store" })
    .then(function (r) { return r.json().catch(function () { return { error: "bad json" }; }); })
    .then(function (d) {
      if (d && d.error) {
        box.innerHTML = '<div class="bd-inc-err">' + escapeHtml(t("breakdown.incFetchFail", { msg: d.error })) + '</div>';
        return;
      }
      var incs = (d && d.incidents) || [];
      if (!incs.length) {
        box.innerHTML = '<div class="bd-empty">' + escapeHtml(t("breakdown.noRealtimeInc")) + '</div>';
        return;
      }
      // 车次概况（车次名 / 起讫站 / 最大实测晚点）
      var head = "";
      if (d.journey_desc || d.first_stop) {
        var seg = (d.first_stop || "") + (d.last_stop ? " → " + d.last_stop : "");
        head = '<div class="bd-inc-head">' +
          (d.journey_desc ? '<span class="bd-inc-desc">' + escapeHtml(d.journey_desc) + '</span>' : '') +
          (seg ? '<span class="bd-inc-seg">' + escapeHtml(seg) + '</span>' : '') +
          (d.max_delay ? '<span class="bd-inc-max">' + escapeHtml(t("breakdown.realtimeMaxDelay", { n: d.max_delay })) + '</span>' : '') +
          '</div>';
      }
      box.innerHTML = head + incs.map(function (x) {
        var catColor = (BD_COLORS[x.category] || "#888780");
        var txt = x.text || x.label || x.head || "";
        var meta = [];
        if (x.station) meta.push(escapeHtml(x.station));
        if (x.value) meta.push(escapeHtml(t("breakdown.realtimeVal", { n: x.value })));
        return '<div class="bd-inc-item">' +
          '<span class="bd-inc-dot" style="background:' + catColor + '"></span>' +
          '<div class="bd-inc-body">' +
          '<div class="bd-inc-txt">' + escapeHtml(txt) + '</div>' +
          (meta.length ? '<div class="bd-inc-meta">' + meta.join(" · ") + '</div>' : '') +
          '</div></div>';
      }).join("");
    })
    .catch(function (e) {
      box.innerHTML = '<div class="bd-inc-err">' + escapeHtml(t("breakdown.incNetFail", { msg: e.message })) + '</div>';
    })
    .finally(function () { btn.disabled = false; });
}

// 区间预测渲染
function renderSegment(d) {
  var panel = document.getElementById("segmentPanel");
  if (!panel) return;
  var s = d && d.segment;
  if (!s || !s.n_days) { panel.classList.add("hidden"); return; }
  if (s.error === "from_not_in_route" || s.error === "to_not_in_route") {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  document.getElementById("segFrom").textContent = s.from;
  document.getElementById("segTo").textContent = s.to;
  document.getElementById("segN").textContent = s.n_days;
  document.getElementById("segPoint").innerHTML = (s.point_estimate != null ? Math.round(s.point_estimate) : "—") + ' <span class="unit">' + t("segment.unitMin") + '</span>';
  document.getElementById("segIV").textContent = (s.p10 != null ? s.p10.toFixed(0) : "—") + "–" + (s.p90 != null ? s.p90.toFixed(0) : "—") + " " + t("segment.unitMin");
  var probEl = document.getElementById("segProb");
  probEl.textContent = (s.prob_ge15 != null ? Math.round(s.prob_ge15 * 100) : 0) + "%";
  probEl.className = "val" + (s.prob_ge15 >= 0.8 ? " warn" : "");
  document.getElementById("segCancel").textContent = s.canceled_days || 0;
  var barEl = document.getElementById("segBar");
  var samples = Array.isArray(s.samples) ? s.samples : [];
  if (samples.length && barEl) {
    var maxV = Math.max.apply(null, samples) || 1;
    barEl.innerHTML = samples.map(function (v) {
      var h = Math.max(2, Math.round((v / maxV) * 100));
      var cls = v >= 15 ? "day-bar ge15" : (v === 0 ? "day-bar zero" : "day-bar");
      return '<div class="' + cls + '" style="height:' + h + '%" title="' + v + ' ' + t("segment.unitMin") + '"></div>';
    }).join("");
  } else if (barEl) {
    barEl.innerHTML = '<div class="seg-empty" style="color:var(--muted);font-size:12px;align-self:center">' + t("segment.noData") + '</div>';
  }
  var note = document.getElementById("segNote");
  if (note) {
    var _note = t("segment.note", { from: s.from, to: s.to, n: s.n_days });
    // 样本过少时追加提示（单日样本的柱状图无分布意义）
    if (samples.length > 0 && samples.length < 3) {
      _note += " " + t("segment.smallSample", { n: samples.length });
    }
    note.textContent = _note;
  }
}

function drawChart10d(d, metric) {
  const el = document.getElementById("chart10d");
  if (typeof Chart === "undefined") {
    // Chart.js 未加载（如 CDN 不可达且本地缺失）：清空画布，避免静默失败
    try { el.getContext("2d").clearRect(0, 0, el.width, el.height); } catch (_) {}
    return;
  }
  if (chart10d) chart10d.destroy();
  const recsAll = d.recent || [];
  // 该图表区域默认仅展示 zugfinder 数据：过滤 PieBro 本地历史 / DB 官方实时（今日补充）
  const zfRecs = recsAll.filter(function (r) {
    const src = r.source || "";
    return src === "" || src === "cached";
  });
  const pieRecs = recsAll.filter((r) => (r.source || "") === "piebro");
  // 兜底：若近窗口内 zugfinder 全部准点（终点延误恒为 0），自动回退展示本地历史库的
  // 延误分布，避免柱状图一片空白、用户误以为未加载。回退后明确标注"本地历史"。
  let useRecs = zfRecs;
  // 本地历史兜底标记："" = 用 zugfinder；"allzero" = zugfinder 真查到且全部准点；
  // "empty" = 近窗口内 zugfinder 0 天（没查到/查询失败——不可谎称「全部准点」）
  let usingLocal = "";
  const zfEndVals = zfRecs
    .map((r) => r.end_delay)
    .filter((v) => v !== null && v !== undefined);
  const zfAllZero = zfEndVals.length > 0 && zfEndVals.every((v) => v === 0);
  const zfEmpty = zfRecs.length === 0; // 近窗口内 zugfinder 0 天 ≠ 全部准点！
  const pieHasDelay = pieRecs.some((r) => (r.end_delay || 0) > 0);
  if (zfAllZero && pieHasDelay) {
    useRecs = pieRecs.slice(-10);
    usingLocal = "allzero";
  } else if (zfEmpty && pieHasDelay) {
    useRecs = pieRecs.slice(-10);
    usingLocal = "empty";
  }
  const recs = useRecs;
  const nFiltered = recsAll.length - zfRecs.length;
  // 区间到达数据（ride_from → ride_to 的 ride_to 站逐日到站延误）。
  // 区间查询时替代"终点延误"作为默认视图——终点延误是整段口径，
  // 与用户查询的区间无关（2026-09-11 用户反馈「区间晚点返回了整段晚点」）。
  const segBd = (metric === "segment" && d.segment && Array.isArray(d.segment.by_day))
    ? d.segment.by_day : [];
  const segOk = metric === "segment" && segBd.length > 0;
  let title = t("chart.10dEnd");
  let labels, vals, dsLabel;
  if (segOk) {
    title = t("chart.10dSegment", { from: d.segment.from || "", to: d.segment.to || "" });
    labels = segBd.map((x) => (x.date || "").slice(5));
    vals = segBd.map((x) => (x.delay === null || x.delay === undefined ? null : Math.max(x.delay, 0)));
    dsLabel = "→ " + (d.segment.to || "");
  } else if (metric === "max") {
    // 每日最大延误（max_delay）
    title = usingLocal ? t("chart.10dMaxLocal") : t("chart.10dMax");
    labels = recs.map((r) => r.date.slice(5));
    vals = recs.map((r) =>
      r.max_delay === null || r.max_delay === undefined ? null : Math.max(r.max_delay, 0)
    );
    dsLabel = t("chart.dsMax");
  } else if (metric === "station") {
    // 选定车站的逐日延误
    const sel = document.getElementById("stationSelect");
    const st = sel && sel.value ? sel.value : "";
    const sd = d.station_days || [];
    title = t("chart.10dStation", { st: st ? "：" + st : "" });
    labels = sd.map((x) => x.date.slice(5));
    // 站名归一化匹配（2026-09-18 修复）：下拉来自 d.stations（时刻表/PieBro
    // 规范名，如 "Hamm (Westf) Hbf"、"Berlin Hauptbahnhof"），而 station_days 的
    // 键是 zugfinder 原始站名（"Hamm(Westf)Hbf"、"Berlin Hbf"）——精确匹配会落空，
    // 整列 null → 误报「0 天有记录」。精确失败时回退归一化匹配（normalizeStation
    // 已剥离 Hbf/Hauptbahnhof，二者归一后一致）。
    const stKey = normalizeStation(st);
    vals = sd.map((x) => {
      const dl = (x && x.delays) || {};
      let v = dl[st];
      if ((v === undefined || v === null) && stKey) {
        for (const k in dl) {
          if (normalizeStation(k) === stKey) { v = dl[k]; break; }
        }
      }
      return v === undefined || v === null ? null : Math.max(v, 0);
    });
    dsLabel = st || t("chart.dsStation");
  } else {
    // 每日终点延误（默认）
    title = usingLocal ? t("chart.10dEndLocal") : t("chart.10dEnd");
    labels = recs.map((r) => r.date.slice(5));
    vals = recs.map((r) => {
      // end_delay < 0（旧缓存的 -1 = destination not reached 哨兵）→ null 断柱，
      // 显示"无数据"空框而非伪准点 0（2026-09-11 用户反馈：9/9、9/2 超长晚点被判 0 分钟）
      if (r.end_delay === null || r.end_delay === undefined || r.end_delay < 0) return null;
      return Math.max(r.end_delay, 0);
    });
    dsLabel = t("chart.dsEnd");
  }
  const canceledSet = new Set(d.canceled_days || []);
  document.getElementById("chart10dTitle").textContent = title;
  // 无数据日占位柱（2026-09-09 RE 8 反馈）：zugfinder 对某些日期查无记录
  // （rows=0，非限流也非取消）——旧版该日整根柱消失，用户以为「图缺了一根/漏数据」。
  // 这里画灰色虚线空框 + 破折号，把「查无数据」与「准点(0)」在视觉上区分开。
  const noDataGapPlugin = {
    id: "noDataGap",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      const ds = chart.data.datasets[0];
      if (!meta || !ds) return;
      const ctx = chart.ctx;
      const tickColor = cssVar("--chart-tick") || "#94a3b8";
      ctx.save();
      meta.data.forEach(function (bar, i) {
        const v = ds.data[i];
        if (v !== null && v !== undefined) return;
        const x = bar.x, base = bar.base;
        const w = Math.max(bar.width || 12, 6);
        const h = Math.min(22, Math.max(12, (base - chart.chartArea.top) * 0.35));
        const top = base - h;
        ctx.strokeStyle = tickColor;
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(x - w / 2, top, w, h);
        ctx.setLineDash([]);
        ctx.fillStyle = tickColor;
        ctx.globalAlpha = 0.9;
        ctx.font = "12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("–", x, top + h / 2);
      });
      ctx.restore();
    },
  };
  // 通用高清屏适配
  const dpr = window.devicePixelRatio || 1;
  // 取消日柱子：红色条纹背景 + 值固定为 0（不参与延误分布）
  const cancBg = "repeating-linear-gradient(135deg,#fecaca,#fecaca 4px,#fca5a5 4px,#fca5a5 8px)";
  chart10d = new Chart(el, {
    type: "bar",
    plugins: [noDataGapPlugin],
    data: {
      labels,
      datasets: [{
        label: dsLabel,
        data: vals.map((v, i) => (canceledSet.has(recs[i]?.date) ? 0 : v)),
        // minBarLength：0 值（准点日）也画 3px 微柱——旧版准点日柱高为 0 完全
        // 不可见，用户误以为该天没查到数据（2026-09-09 RE 8 反馈）
        minBarLength: 3,
        backgroundColor: vals.map((v, i) => {
          if (canceledSet.has(recs[i]?.date)) return cancBg;
          if (v === null || v === undefined) return "transparent"; // 无数据：由虚框插件绘制
          if (usingLocal) return "#2563eb"; // 本地历史兜底：蓝色区分
          if (v === 0) return "#16a34a";    // 准点日：绿色微柱
          return i === vals.length - 1 ? "#dc2626" : "#d97706";
        }),
        borderRadius: 3,
        borderColor: vals.map((v, i) =>
          canceledSet.has(recs[i]?.date) ? "#ef4444" : "transparent"
        ),
        borderWidth: vals.map((v, i) =>
          canceledSet.has(recs[i]?.date) ? 1 : 0
        ),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      devicePixelRatio: dpr,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const idx = c.dataIndex;
              const dt = recs[idx]?.date || "";
              if (canceledSet.has(dt)) return t("chart.cancelledNote");
              return c.parsed.y === null ? t("chart.noData") : `${c.parsed.y} ${t("unit.min")}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { autoSkip: false, maxRotation: 45, font: { size: 11 }, color: cssVar('--chart-tick') }, grid: { display: false }, border: { color: cssVar('--chart-grid') } },
        y: { beginAtZero: true, ticks: { callback: (v) => v + " " + t("unit.min"), color: cssVar('--chart-tick') }, grid: { color: cssVar('--chart-grid') }, border: { color: cssVar('--chart-grid') } },
      },
    },
  });
  // 零延误标注：全部非空值均为 0 → 显示绿色准点提示（避免用户误以为未加载）
  const validVals = vals.filter((v) => v !== null && v !== undefined);
  const allZero = validVals.length > 0 && validVals.every((v) => v === 0);
  const hint10d = document.getElementById("chart10dHint");
  if (hint10d) {
    let hintHtml = "";
    // 回退到本地历史：明确告知（蓝柱为本地历史库，非 zugfinder 实时）
    // "allzero"（zugfinder 真全准点）与 "empty"（0 天，没查到）必须用不同文案——
    // 旧版共用「全部准点」文案导致查询失败被误报成准点（2026-09-09 用户报告）。
    if (usingLocal === "allzero") {
      hintHtml += '<span style="color:#1d4ed8;font-weight:600;">' +
        t("chart.usingLocalHistory", { n: recs.length, src: "PieBro" }) + '</span>';
    } else if (usingLocal === "empty") {
      hintHtml += '<span style="color:#1d4ed8;font-weight:600;">' +
        t("chart.noZugfinderData", { n: recs.length, src: "PieBro" }) + '</span>';
    } else if (nFiltered > 0) {
      // 该区域严格 zugfinder：本地历史库(PieBro)/DB 实时天不在此图绘制（并非数据被剔除）
      hintHtml += '<span style="color:#b45309;font-weight:600;">' +
        t("chart.filteredNonZf", { zf: recs.length, ext: nFiltered }) + '</span>';
    }
    // zugfinder 数据稀疏：明确告知该车次近 N 天 zugfinder 仅 M 天有记录
    if (!usingLocal && recs.length > 0 && validVals.length < recs.length && !allZero) {
      const missing = recs.length - validVals.length;
      hintHtml += (hintHtml ? "<br>" : "") +
        '<span style="color:#b45309;">' + t("chart.sparse", { n: recs.length, m: validVals.length, k: missing }) + '</span>';
    }
    if (allZero && !usingLocal) {
      hintHtml += (hintHtml ? "<br>" : "") +
        '<span class="chart-all-on-time">' + t("chart.allOnTime") + '</span>';
    }
    hint10d.innerHTML = hintHtml;
    hint10d.className = hintHtml ? "" : "hidden";
  }
}

function drawStations(d) {
  const el = document.getElementById("chartStations");
  // 结构：#chartStations → .chart-fixed-wrap（尺寸基准，宽度=目标宽）→ .chart-box（横向滚动容器）
  const wrap = el.parentElement;
  const box = (wrap && wrap.parentElement) || wrap || el;
  if (typeof Chart === "undefined") {
    try { el.getContext("2d").clearRect(0, 0, el.width, el.height); } catch (_) {}
    document.getElementById("stationsLegend").innerHTML = t("chart.noLib");
    return;
  }
  if (chartStations) chartStations.destroy();
  const stations = d.stations || [];
  const curve = d.curve || [];
  if (stations.length === 0) {
    el.getContext("2d").clearRect(0, 0, el.width, el.height);
    document.getElementById("stationsLegend").innerHTML = t("chart.noStationData");
    box.classList.remove("scrollable-x");
    return;
  }
  // canvas 宽度：按站数动态决定每站宽度，让图表尽量贴近视口（避免横向滚动 + 标签被拉断）
  //  - 站少 (<15)：每站 55px（让曲线舒展、点之间清晰）
  //  - 站中 (15-30)：每站 40px
  //  - 站多 (≥30)：每站 30px（接近视口宽度，配合 autoSkip 等距分布）
  //  - 始终至少填满 box 容器宽度
  const perStation = stations.length >= 30 ? 30 : stations.length >= 15 ? 40 : 55;
  const boxW = box.clientWidth || 338;
  // 窄屏（手机/平板竖屏）：把每站宽压到「刚好铺满容器」，使整图首屏完整可见、不横向滚动
  const isNarrow = boxW < 820;
  const effPer = isNarrow
    ? Math.max(18, Math.min(perStation, Math.floor(boxW / Math.max(stations.length, 1))))
    : perStation;
  const targetW = Math.max(stations.length * effPer, boxW);
  if (targetW > boxW + 50) {
    box.classList.add("scrollable-x");
  } else {
    box.classList.remove("scrollable-x");
  }
  // 关键：把 wrapper 宽度固定为 targetW —— Chart.js 的 responsive/容器监听
  // 只能把 canvas 缩到「容器宽」，只要容器宽本身就是 targetW，就永远不会缩回
  // 视口宽造成横向拉伸（2026-09-13 手机端变形根因）。窄屏下 targetW≈boxW，首屏完整可见。
  wrap.style.width = targetW + "px";
  const colors = ["#d97706", "#2563eb", "#dc2626"];
  const datasets = [];
  // 每条线：主曲线（不停靠站插值连续）+ X 标记（不停靠站）
  curve.forEach((c, i) => {
    const color = colors[i % 3];
    const isCanc = !!c.canceled;
    const series = (c.series || []).map((v) =>
      v === null || v === undefined ? null : Number(v)
    );
    const skipped = c.skipped || [];
    if (isCanc) {
      // 取消日：全 null series → 渲染为底部虚线 + 🚫 标记，不插值
      const cancData = new Array(series.length).fill(null);
      // 在首尾已知站位置放一个 -0.5 哨兵让线可见（Chart.js spanGaps:false 会连成平线）
      for (let idx = 0; idx < series.length; idx++) {
        cancData[idx] = -0.5; // 略低于 0，视觉上区分于"准点"
      }
      datasets.push({
        label: c.date + " (已取消)",
        data: cancData,
        borderColor: "#9ca3af",
        backgroundColor: "#9ca3af",
        pointRadius: 0,
        borderWidth: 1.5,
        borderDash: [6, 4],
        tension: 0,
        spanGaps: false,
      });
      // 取消标记点：每隔几个站放一个 🚫
      const markData = series.map((v, idx) =>
        (idx % Math.max(3, Math.ceil(stations.length / 8)) === 0) ? -0.5 : null
      );
      datasets.push({
        label: c.date + " 取消",
        data: markData,
        borderColor: "transparent",
        backgroundColor: "transparent",
        pointStyle: "crossRot",
        pointRadius: 6,
        pointBorderColor: "#ef4444",
        pointBorderWidth: 2,
        showLine: false,
        spanGaps: false,
      });
      return; // 取消日不需要常规曲线+X标记
    }
    // 不停靠站插值：前后有效值平均，曲线连续经过；数据缺失（非插值）保持 null 断开
    const lineData = series.slice();
    for (let idx = 0; idx < series.length; idx++) {
      if (!skipped[idx]) continue; // 只处理确定不停靠的位置（其 series 为 null）
      let prev = null, next = null;
      for (let j = idx - 1; j >= 0; j--) {
        if (series[j] !== null) { prev = series[j]; break; }
      }
      for (let j = idx + 1; j < series.length; j++) {
        if (series[j] !== null) { next = series[j]; break; }
      }
      if (prev !== null && next !== null) lineData[idx] = (prev + next) / 2;
      else if (prev !== null) lineData[idx] = prev;
      else if (next !== null) lineData[idx] = next;
      else lineData[idx] = null;
    }
    // 主曲线在不停靠站隐藏圆点（让位给 X），其他点保留
    const pointRadii = series.map((v, idx) => (skipped[idx] ? 0 : 3));
    datasets.push({
      label: c.date,
      data: lineData,
      borderColor: color,
      backgroundColor: color,
      pointRadius: pointRadii,
      borderWidth: 1.5,
      tension: 0.2,
      spanGaps: false,
    });
    // X 标记：值用 lineData 插值后的 y，让 X 落在曲线上
    const crossData = series.map((v, idx) => (skipped[idx] ? lineData[idx] : null));
    datasets.push({
      label: c.date + " 不停靠",
      data: crossData,
      borderColor: "transparent",
      backgroundColor: "transparent",
      pointStyle: "cross",
      pointRadius: 5,
      pointBorderColor: color,
      pointBorderWidth: 2,
      showLine: false,
      spanGaps: false,
    });
  });
  // QA ENG-13：canvas 默认不进 Tab 序列，键盘用户无法触发放大交互。
  // canvas 已带 tabindex=0（index.html），这里补 Enter/Space 触发，与点击等价；
  // 关闭 lightbox 时焦点会由 closeChartLightbox 返回到触发元素（已有逻辑）。
  if (el && !el._kbdLightboxBound) {
    el._kbdLightboxBound = true;
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
        ev.preventDefault();
        openChartLightbox(chartStations, stations, d);
      }
    });
  }
  chartStations = new Chart(el, {
    type: "line",
    // responsive:true —— 尺寸由外层 .chart-fixed-wrap 的固定宽度主导
    // （wrapper 宽 = max(站数×每站宽, 视口宽)），Chart.js 只需跟随 wrapper 即可，
    // 不会再出现「canvas 缩回视口宽、元素却显示 770」的拉伸（2026-09-13 修复）。
    responsive: true,
    data: { labels: stations.map((s) => {
      // 长站名截断：跨境/欧际列车站名常 15+ 字符（如 "Kłodzko Miasto"、"Praha-Libeň"）
      // 截到 12 字符避免 x 轴重叠；tooltip 仍显示全名
      const trimmed = s.replace("(Westf)Hbf", "").replace(" Hbf", "");
      return trimmed.length > 12 ? trimmed.slice(0, 11) + "…" : trimmed;
    }), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      devicePixelRatio: window.devicePixelRatio || 1,
      onClick: () => openChartLightbox(chartStations, stations, d), // 单击图区域进入 lightbox
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.raw !== null,
          callbacks: {
            title: (items) => {
              // tooltip 标题用全名（替代截断的 label）
              const idx = items[0] && items[0].dataIndex;
              return idx != null && stations[idx] ? stations[idx] : (items[0] && items[0].label);
            },
            label: (ctx) => {
              if (ctx.dataset.pointStyle === "cross") return t("chart.notStopping");
              return ctx.parsed.y === null ? t("chart.noData") : `${ctx.parsed.y} ${t("unit.min")}`;
            },
          },
        },
      },
      scales: {
        x: {
          // 站多（≥24）时自动跳过：保留约每 N 站一个 label，避免重叠
          autoSkip: stations.length >= 24,
          autoSkipPadding: 8,
          maxRotation: 60,
          minRotation: 0,
          ticks: { font: { size: 10 }, color: cssVar('--chart-tick') },
          grid: { display: false },
          border: { color: cssVar('--chart-grid') },
        },
        y: {
          beginAtZero: true,
          // 全 0 分时 y 轴自动 0-1 仍太挤；suggestedMax 给最小可见范围（2 分）
          // 有非零数据时 Chart.js 仍按实际最大值放大，不被此值限制
          suggestedMax: 2,
          ticks: { callback: (v) => v + " " + t("unit.min"), color: cssVar('--chart-tick') },
          grid: { color: cssVar('--chart-grid') },
          border: { color: cssVar('--chart-grid') },
        },
      },
    },
  });
  // 尺寸已由外层 .chart-fixed-wrap 固定宽度主导，Chart.js responsive 自动跟随，
  // 无需手工 resize；此处仅确保一次重绘以适配 wrapper 宽度。
  const _chartH = box.clientHeight || 230;
  wrap.style.height = _chartH + "px";
  try { chartStations.resize(); } catch (_) {}
  const skipSites = [];
  curve.forEach((c, i) => {
    const skipped = c.skipped || [];
    skipped.forEach((sk, idx) => {
      if (sk && stations[idx] && !skipSites.includes(stations[idx])) {
        skipSites.push(stations[idx]);
      }
    });
  });
  const legend = curve
    .map((c, i) => {
      const tag = c.date === d.recent && d.recent.length ? (c.date === d.recent[d.recent.length - 1].date ? " · 今日" : "") : "";
      const histTag = c.historical ? `<span style="color:#1d4ed8;font-weight:600;margin-left:4px;">⏱️${t("chart.historical")}</span>` : "";
      if (c.canceled) {
        return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:14px;">
          <span style="width:10px;height:10px;border-radius:2px;background:#9ca3af;border-top:2px dashed #ef4444;"></span>${c.date.slice(5)}${tag}
          <span style="color:#ef4444;font-weight:600;">🚫 ${t("chart.cancelledShort")}</span>
        </span>`;
      }
      return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:14px;">
        <span style="width:10px;height:10px;border-radius:2px;background:${c.historical ? "#2563eb" : colors[i % 3]};"></span>${c.date.slice(5)}${tag}${histTag}
        <span style="color:var(--muted)">${t("chart.endAt", { m: c.end_delay === null ? "—" : Math.round(c.end_delay) })}</span>
      </span>`;
    })
    .join("");
  const skipNote = skipSites.length
    ? `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:14px;">
        <span style="width:10px;height:10px;display:inline-flex;align-items:center;justify-content:center;color:#888780;font-size:12px;line-height:1;">✕</span>
        ${t("chart.skipNote", { s: skipSites.join("、") })}
      </span>`
    : "";
  document.getElementById("stationsLegend").innerHTML = legend + skipNote;
  // 逐站曲线零延误标注
  let allStationZero = true;
  let hasData = false;
  let hasHistorical = false;
  curve.forEach((c) => {
    const hasSeries = (c.series || []).some((v) => v !== null && v !== undefined);
    if (c.historical && hasSeries) hasHistorical = true;
    (c.series || []).forEach((v) => {
      if (v !== null && v !== undefined) { hasData = true; if (v !== 0) allStationZero = false; }
    });
  });
  const stHint = document.getElementById("chartStationsHint");
  if (stHint) {
    if (hasHistorical) {
      stHint.innerHTML = '<span style="color:#1d4ed8;font-weight:600;">' + t("chart.historicalCurve") + '</span>';
      stHint.className = "";
    } else if (hasData && allStationZero) {
      stHint.innerHTML = '<span class="chart-all-on-time chart-all-on-time-station">' + t("chart.allOnTime") + '</span>';
      stHint.className = "";
    } else {
      stHint.innerHTML = "";
      stHint.className = "hidden";
    }
  }
}

/* ===== 图表 lightbox：点击进入详细查看模式 ===== */
let _chartLightbox = null; // 当前 lightbox 实例（{ chart, el }）
function openChartLightbox(srcChart, stations, d) {
  if (!srcChart || _chartLightbox) return; // 已有则不重开
  const trigger = document.activeElement;
  // 1) overlay（body 直接子元素，避免父级 hidden 影响）
  const overlay = document.createElement("div");
  overlay.className = "chart-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", t("chart.lightboxAria"));
  // 2) 内容包装
  const wrap = document.createElement("div");
  wrap.className = "chart-lightbox-wrap";
  // 标题（与原 panel-title 一致）
  const title = document.createElement("div");
  title.className = "chart-lightbox-title";
  title.textContent = t("chart.libTitle");
  // 关闭按钮
  const closeBtn = document.createElement("button");
  closeBtn.className = "chart-lightbox-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", t("btn.close"));
  closeBtn.textContent = "×";
  // 3) 新 canvas —— 用全名（不被截断），无 autoSkip → 1:1 全宽显示
  const canvas = document.createElement("canvas");
  canvas.className = "chart-lightbox-canvas";
  // 动态宽度：每站 60px（1:1），最少 640px，最多 3200px（超出部分 wrap 内横向滚动）
  const lbWidth = Math.max(640, Math.min((stations || []).length * 60, 3200));
  canvas.style.minWidth = lbWidth + "px";
  wrap.appendChild(title);
  wrap.appendChild(closeBtn);
  wrap.appendChild(canvas);
  overlay.appendChild(wrap);
  document.body.appendChild(overlay);

  // 4) 复制 options，去掉 autoSkip（让每个站都显示）；保留 maxRotation 让长站名倾斜可读
  //    关键：让 canvas 自适应内容宽度（去掉响应式 max-width 限制）→ 真正 1:1 比例
  const opts = JSON.parse(JSON.stringify(srcChart.options || {}));
  opts.responsive = true;
  opts.maintainAspectRatio = false;
  if (opts.scales && opts.scales.x) {
    opts.scales.x.ticks = Object.assign({}, opts.scales.x.ticks || {}, {
      autoSkip: false,    // 1:1 —— 每个站都显示
      maxRotation: 60,    // 长站名倾斜，避免水平挤压
      minRotation: 0,
      font: { size: 11 },
    });
  }
  // 5) 复制 data，labels 用全名（去掉 12 字符截断）
  const data = {
    labels: (stations || []).map((s) => String(s).replace("(Westf)Hbf", "").replace(" Hbf", "")),
    datasets: srcChart.data.datasets,
  };
  // 6) 创建新 chart
  const newChart = new Chart(canvas, {
    type: srcChart.config ? srcChart.config.type : "line",
    data: data,
    options: opts,
  });

  _chartLightbox = { chart: newChart, el: overlay, canvas: canvas, trigger: trigger };
  closeBtn.focus();

  // 7) 关闭交互
  closeBtn.addEventListener("click", closeChartLightbox);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeChartLightbox(); // 点背景关，点 wrap 不关
  });
  // ESC 键
  function keyListener(e) {
    if (e.key === "Escape") { closeChartLightbox(); return; }
    if (e.key === "Tab") { e.preventDefault(); closeBtn.focus(); }
  }
  document.addEventListener("keydown", keyListener);
  // 关闭时清理
  _chartLightbox._keyListener = keyListener;
  // 点击 chart 也关闭（因为 lightbox 里的 chart 有 own click handler，会被 onClick 触发）
  // 拦截冒泡避免双开
  canvas.addEventListener("click", function (e) { e.stopPropagation(); });
}
function closeChartLightbox() {
  if (!_chartLightbox) return;
  try { _chartLightbox.chart && _chartLightbox.chart.destroy(); } catch (_) { /* 忽略销毁错误 */ }
  if (_chartLightbox._keyListener) {
    document.removeEventListener("keydown", _chartLightbox._keyListener);
  }
  if (_chartLightbox.el && _chartLightbox.el.parentNode) {
    _chartLightbox.el.parentNode.removeChild(_chartLightbox.el);
  }
  const trigger = _chartLightbox.trigger;
  _chartLightbox = null;
  if (trigger && document.contains(trigger)) trigger.focus();
}

function renderDays(d) {
  const days = d.days_stations || [];
  const canceledSet = new Set(d.canceled_days || []);
  const tabsEl = document.getElementById("dayTabs");
  const title = document.getElementById("todayTitle");
  if (!days.length) {
    tabsEl.innerHTML = "";
    document.getElementById("todayRows").innerHTML = "";
    title.textContent = t("day.noData");
    return;
  }
  // 近三日日期切换标签（默认最近一天）；取消日标签加标记
  tabsEl.innerHTML = days
    .map((x, i) => {
      const isCanc = canceledSet.has(x.date);
      return '<button class="day-tab' + (i === days.length - 1 ? " active" : "") +
        (isCanc ? " day-tab-canceled" : "") +
        '" data-i="' + i + '" type="button">' + x.date.slice(5) +
        (isCanc ? ' <span class="canc-tag">🚫</span>' : "") + "</button>";
    })
    .join("");
  tabsEl.querySelectorAll(".day-tab").forEach(function (b) {
    b.addEventListener("click", function () {
      const i = parseInt(b.dataset.i, 10);
      tabsEl.querySelectorAll(".day-tab").forEach(function (x) {
        x.classList.toggle("active", parseInt(x.dataset.i, 10) === i);
      });
      showDayTable(days[i], canceledSet.has(days[i].date));
    });
  });
  showDayTable(days[days.length - 1], canceledSet.has(days[days.length - 1]?.date));
}

function showDayTable(day, isCanceled) {
  const title = document.getElementById("todayTitle");
  document.getElementById("todayRows").innerHTML = "";
  if (!day) {
    title.textContent = t("day.noData");
    return;
  }
  title.textContent = "→ " + day.date + (isCanceled ? " " + t("day.canceled") : "");
  if (isCanceled) {
    const tbody = document.getElementById("todayRows");
    tbody.innerHTML = '<tr><td colspan="5" class="cancell-banner">' + t("day.cancelledRow") + '</td></tr>';
    return;
  }
  renderTableRows(day.stations || []);
}

function renderTableRows(stations) {
  const tbody = document.getElementById("todayRows");
  tbody.innerHTML = "";
  for (const s of stations) {
    const arr = s.arr && s.arr !== "99:99" ? s.arr : "—";
    const dep = s.dep && s.dep !== "99:99" ? s.dep : "—";
    const ad = num(s.adelay);
    const dd = num(s.ddelay);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.bhf)}</td>
      <td>${escapeHtml(arr)}</td>
      <td class="${delayCls(ad)}">${fmtDelay(ad)}</td>
      <td>${escapeHtml(dep)}</td>
      <td class="${delayCls(dd)}">${fmtDelay(dd)}</td>`;
    tbody.appendChild(tr);
  }
}

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function delayCls(v) {
  if (v === null) return "";
  if (v > 15) return "text-red";
  if (v > 5) return "text-yellow";
  return "text-green";
}

/* ========== 站对站查询（五车型） ========== */

// JSON 请求统一处理超时、调用方取消和响应格式错误；自动携带登录 token。
// 会话凭证已改为 httpOnly Cookie（2026-09-18，QA SEC-03）：
// token 不再写入 localStorage —— JS 读不到 Cookie，XSS 偷不走会话；
// 浏览器会自动随同源请求带上，前端不需要也不应该手动拼 header。
// 这里保留函数签名（返回空对象）以兼容既有调用点；
// 服务端仍接受 Authorization: Bearer，仅供脚本/curl 调试使用。
function authHeaders() {
  return {};
}
async function fetchJSON(url, opts) {
  var opt = opts || {};
  var headers = Object.assign({}, authHeaders(), opt.headers || {});
  var controller = new AbortController();
  var timedOut = false;
  var externalSignal = opt.signal;
  var abortFromCaller = function () { controller.abort(); };
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abortFromCaller, { once: true });
  }
  var timer = setTimeout(function () {
    timedOut = true;
    controller.abort();
  }, opt.timeout || DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    // credentials: "same-origin" —— 让 httpOnly 会话 Cookie 随请求发出（登录态的关键）
    var resp = await fetch(url, Object.assign({}, opt, { headers: headers, signal: controller.signal, credentials: "same-origin" }));
    if (!resp.ok) {
      var httpError = new Error("HTTP " + resp.status);
      httpError.status = resp.status;
      httpError.code = resp.status === 429 ? "http_rate_limited" : resp.status >= 500 ? "http_server" : "http_error";
      try {
        var errorBody = await resp.json();
        if (errorBody && errorBody.error) httpError.message = errorBody.error;
        // 后端在「预测服务繁忙」时返回 retryable:true（worker 闸门满 / spawn 闸门满），
        // 这类失败等几秒重试就好，与「服务坏了」是两回事，前端要给可重试的提示。
        if (errorBody && errorBody.retryable) httpError.retryable = true;
      } catch (_) { /* non-JSON error response */ }
      throw httpError;
    }
    const text = await resp.text();
    if (!text.trim()) {
      var emptyResponseError = new Error("empty response");
      emptyResponseError.code = "invalid_response";
      throw emptyResponseError;
    }
    try { return JSON.parse(text); }
    catch (_) {
      var parseError = new Error("invalid JSON response");
      parseError.code = "invalid_response";
      throw parseError;
    }
  } catch (err) {
    if (err && err.code) throw err;
    var requestError = new Error(timedOut ? "request timeout" : "network error");
    requestError.code = timedOut ? "timeout" : externalSignal && externalSignal.aborted ? "aborted" : "network";
    throw requestError;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", abortFromCaller);
  }
}

function renderDataQuality(d, valid, limited, matched, total, fallback) {
  const el = document.getElementById("dataQuality");
  if (!el) return;
  // 数据源拆分：区分 zugfinder 实时（含缓存）与本地历史库(PieBro)扩展，
  // 避免「有效 68 天」与图表「过滤 60 天」貌似矛盾（实为同一批扩窗数据的两种视角）。
  const recent = d.recent || [];
  const zf = recent.filter((r) => !r.source || r.source === "cached").length;
  const ext = recent.filter((r) => r.source === "piebro" || r.source === "db_realtime").length;
  const denominator = Math.max(total, valid, limited);
  const matchRate = denominator > 0 ? Math.round((matched / denominator) * 100) : 0;
  const notes = [];
  if (fallback) notes.push(t("quality.destinationFallback"));
  if (limited > 0) notes.push(t("quality.rateLimited", { n: limited }));
  if (d.source === "piebro" || d.source === "db_realtime") notes.push(t("quality.fallbackSource"));
  const level = valid >= 7 && !fallback && limited === 0 ? "good" : valid >= 3 ? "caution" : "poor";
  el.innerHTML = '<strong>' + escapeHtml(t("quality.title")) + '</strong>' +
    '<span>' + escapeHtml(t("quality.samples", { total: total, zf: zf, ext: ext })) + '</span>' +
    '<span>' + escapeHtml(t("quality.destination", { matched: matched, rate: matchRate })) + '</span>' +
    '<span class="quality-level">' + escapeHtml(t("quality.level." + level)) + '</span>' +
    (notes.length ? '<div class="quality-notes">' + notes.map(escapeHtml).join(" · ") + '</div>' : "");
  el.className = "data-quality " + level;
  el.classList.remove("hidden");
}

// 字母导航已移除：datalist + 输入建议已能满足"按字母筛站"的需求

function showRouteTip(msg) {
  let tip = document.getElementById("routeTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "routeTip";
    tip.className = "status";
    (document.getElementById("routeDelayPane") || document.body).appendChild(tip);
  }
  tip.textContent = msg;
  tip.classList.remove("hidden");
  clearTimeout(showRouteTip._t);
  showRouteTip._t = setTimeout(function () { tip.classList.add("hidden"); }, 6000);
}

function routeStationKey(value) {
  return String(value || "").toLowerCase().replace(/[\s.\-\/]+/g, " ").trim();
}

function routeTimeMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
}

function routeRanking(route, from, to, queryTime) {
  const trainRef = route.line_number || route.journey_number;
  const predictable = trainRef ? 1 : 0;
  const exactRoute = routeStationKey(route.from_station) === routeStationKey(from) &&
    routeStationKey(route.to_station) === routeStationKey(to) ? 1 : 0;
  const dep = routeTimeMinutes(route.dep_time);
  const requested = routeTimeMinutes(queryTime);
  let timeDistance = dep === null ? Number.MAX_SAFE_INTEGER : dep;
  if (dep !== null && requested !== null) {
    timeDistance = Math.min(Math.abs(dep - requested), 1440 - Math.abs(dep - requested));
  }
  return { predictable, exactRoute, timeDistance, dep: dep === null ? Number.MAX_SAFE_INTEGER : dep };
}

// 起/终点输入框 Enter（2026-09-11 移除直达查询后简化）：站对站视图下已填车次号
// 时 Enter = 区间预测；未填则提示（旧版会退化到按起终点查直达班次）。
function _routeEnterAction() {
  // 变量原名 t，遮蔽全局 i18n 函数 t() → 下一行 t("route.noTrainNum") 必然抛
  // "t is not a function"（用户未填车次号按 Enter 即触发）。改名 trainQ。
  const trainQ = ((document.getElementById("routeDelayTrain") || {}).value || trainInput.value || "").trim();
  if (trainQ) { predictRouteDelay(); return; }
  showRouteTip(t("route.noTrainNum"));
}
fromInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); _routeEnterAction(); } });
toInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); _routeEnterAction(); } });


// 查晚点：车次号（页面 B 专用输入框优先，兼容旧顶栏）+ 起终点 → 直接区间预测
async function predictRouteDelay() {
  const from = (fromInput.value || "").trim();
  const to = (toInput.value || "").trim();
  const _rdTrain = document.getElementById("routeDelayTrain");
  const train = ((_rdTrain && _rdTrain.value) || trainInput.value || "").trim();
  const statusEl = document.getElementById("routeDelayStatus");
  const resultEl = document.getElementById("routeDelayResult");
  if (!train) {
    if (statusEl) { statusEl.textContent = t("route.noTrainNum"); statusEl.classList.remove("hidden"); setTimeout(function () { statusEl.classList.add("hidden"); }, 5000); }
    return;
  }
  // 停靠站成员预检查（2026-09-13 用户反馈「改了起终点，晚点数不变」）：
  // 起/终点明显不在该车次停靠序列时立即报错并收起旧预测结果——否则旧结果
  // 滞留屏上被误读成新区间的预测（如 Leipzig Hbf ≠ ICE 847 停靠站）。
  // 匹配规则与站名下拉 _getContextualStations 一致（normalizeStation + 双向
  // 前缀）：拿不准一律放行，由后端 interval_warning 兜底，绝不误拦。
  const _cts0 = cachedTrainStations;
  if (_cts0 && _cts0.train && _cts0.stations && _cts0.stations.length) {
    // 剥空白与下划线：API 返回 train 为 "ICE_847"（下划线），用户输入为 "ICE 847"
    const _tn = function (s) { return (s || "").replace(/[\s_]+/g, "").toLowerCase(); };
    if (_tn(_cts0.train) === _tn(train)) {
      const _hitSt = function (name) {
        const n = normalizeStation(name);
        if (!n) return true; // 空白站不拦（仅填终点模式预测合法）
        return _cts0.stations.some(function (s) {
          const ns = normalizeStation(s);
          if (!ns) return false;
          if (ns === n) return true;
          if (n.length >= 4 && ns.startsWith(n)) return true;
          if (ns.length >= 4 && n.startsWith(ns)) return true;
          return false;
        });
      };
      const _miss = [];
      if (!_hitSt(from)) _miss.push(from);
      if (!_hitSt(to)) _miss.push(to);
      if (_miss.length) {
        const _msg = t("route.notInRoute", { station: _miss.join(" / "), train: train });
        if (statusEl) {
          statusEl.textContent = _msg;
          statusEl.classList.remove("hidden");
          setTimeout(function () { statusEl.classList.add("hidden"); }, 8000);
        }
        if (resultEl) {
          resultEl.classList.remove("hidden");
          resultEl.innerHTML = '<div class="empty-banner">' + escapeHtml(_msg) + "</div>";
        }
        // 报错场景把上一趟预测面板一并收起：留着旧数字只会加重「结果没变」的误读
        ["predictionHead", "predictionCards", "chart10dPanel", "chartStationsPanel",
         "timetablePanel", "dataQuality", "pEmpty", "segmentPanel", "breakdownPanel"]
          .forEach(function (id) {
            const panel = document.getElementById(id);
            if (panel) panel.classList.add("hidden");
          });
        return;
      }
    }
  }
  const _st = splitTrainLine(train);
  const _specific = /^\d{5,}$/.test(_st.num);
  // BUG FIX (2026-09-14)：ICE/IC/EC 家族在 timetable 里没有线路档案，
  // /api/services 必然 count=0 → 永远进不了 _routeDelaySvcPicked「已选定班次」状态。
  // 若此时用户已经填好起终点，下面 count===0 分支会把流程拦在「无班次列表」，
  // 把明明可预测的区间预测挡在门外（用户已在 Köln Hbf→Dortmund Hbf 填好，
  // 却被要求「去单车次页查」）。
  // ICE/IC/EC 本身就是唯一班次、无列表可选，选班次这一步对它们毫无意义：
  // 已填起终点 → 直接走区间预测；未填 → 仍落到列表引导（提示去单车次页）。
  const _isIceFamily2 = /^(ICE|IC|EC)\d+$/.test(_st.type + _st.num);
  const _hasIntervalPre = !!from && !!to;
  const _iceDirectInterval = _isIceFamily2 && _hasIntervalPre;
  // 用户流程（2026-09-10 用户定稿「两个按钮」）：
  // ①「查车次」→ 班次列表（筛州/发车时间）→ ②点班次卡只选定（回填区间、零请求）
  // → ③确认/修改区间 → 点「预测区间晚点」→ 才真正预测。
  // 本按钮（预测区间晚点）在未选定班次时（短号且 _routeDelaySvcPicked=false）
  // 一律先出班次列表引导选定——即使区间已填也不跳过选班次：
  // 用户原话「先查车次，再让用户选区间，再预测区间晚点 这样才对」
  //（RE 34 + Dortmund Hbf→Finnentrop 直接出了 #RE 33082 到终点站的报告，
  //  多趟班次被服务端擅自挑了一趟）。具体车次号（5 位+）本身即唯一班次，直接预测。
  const _hasInterval = !!from && !!to;
  if (!_specific && !_iceDirectInterval && !window._routeDelaySvcPicked) {
    // 未选定班次：先试班次列表（用户定稿「先查车次，再选区间，再预测区间晚点」）。
    // 修复 2026-09-13：列表为空时（如 ICE 847 无 zugfinder 线路档案，/api/services
    // count=0），旧代码 search(train,null,…) 会在 search() 内部静默降级成
    // 「无区间终点预测」→ renderPredict 重显上一趟结果 → 用户误读
    // 「改了起终点，晚点数不变」。现在：列表存在则显示列表；列表为空/请求失败
    // 则直接落到下方区间预测（from/to 已过停靠站预检查，区间有效），
    // 绝不再降级成无区间预测。
    let _svcListed = false;
    const _gen0 = searchGeneration;
    showPageLoading(t("route.overlayServices"), t("route.overlayServicesSub"));
    try {
      const svc = await fetchJSON("/api/services?line=" + encodeURIComponent(train), { timeout: MAIN_REQUEST_TIMEOUT_MS });
      if (searchGeneration !== _gen0) { hidePageLoading(); return; } // 已有更新的查询接管
      if (svc && svc.count > 0 && svc.services && svc.services.length) {
        cachedLineServices = { line: train, services: svc.services };
        if (statusEl) {
          statusEl.textContent = t("route.delayFallback");
          statusEl.classList.remove("hidden");
          setTimeout(function () { statusEl.classList.add("hidden"); }, 8000);
        }
        renderServices(train, svc, null, { autoPredict: false });
        hidePageLoading();
        _svcListed = true;
      } else if (svc && svc.count === 0) {
        // 线路号无匹配班次（如 ICE 847：ICE/IC 无线路档案）→ 显示可操作的
        // 空结果提示（含「改为预测该车次」跳转），不要静默落进 85s 的冷预测。
        renderServices(train, svc, null, { autoPredict: false });
        hidePageLoading();
        _svcListed = true;
      }
    } catch (_) { /* 班次列表失败 → 直接落到区间预测 */ }
    if (_svcListed) return;
  }
  if (!_specific) window._routeDelaySvcPicked = false; // 预测完成，下次查询重新选班次
  if (statusEl) statusEl.classList.add("hidden");
  // 评论区/分享归属：查晚点跟随本次车次+区间查询
  routeCtx = { from: from, to: to };
  loadComments();
  if (resultEl) {
    resultEl.classList.remove("hidden");
    // 文案用「区间晚点预测」——旧文案「正在查询直达班次」与实际动作不符，
    // 且预测结果渲染在 predictionHead，这条 loading 必须在出结果时收掉
    resultEl.innerHTML = '<div class="empty-banner">' + t("route.searchingInterval") + '</div>';
  }
  // 直接调 search：把顶部车次号 + 起终点 作为 ride_from/ride_to 触发区间预测
  // 全屏 loading：python 预测 10~40s，必须给可见反馈（2026-09-11 用户要求）
  showPageLoading(t("route.overlayPredict"), t("route.overlayPredictSub"));
  window.scrollTo({ top: 0, behavior: "smooth" });
  search(train, to, from, to, (window._routeDelayRideTime || ""), { onSettled: hidePageLoading });
}
const _routeDelayBtn = document.getElementById("routeDelayBtn");
if (_routeDelayBtn) _routeDelayBtn.addEventListener("click", predictRouteDelay);
// 「查车次」按钮（2026-09-10 两按钮流程）：显式查班次列表。
// 短号 → /api/services 列表；具体车次号（5 位+）无列表可言，直接查该车次预测。
(function () {
  const _btn = document.getElementById("routeDelaySearchBtn");
  if (!_btn) return;
  _btn.addEventListener("click", function () {
    const _rdTrain = document.getElementById("routeDelayTrain");
    const train = ((_rdTrain && _rdTrain.value) || trainInput.value || "").trim();
    const statusEl = document.getElementById("routeDelayStatus");
    if (!train) {
      if (statusEl) { statusEl.textContent = t("route.noTrainNum"); statusEl.classList.remove("hidden"); setTimeout(function () { statusEl.classList.add("hidden"); }, 5000); }
      return;
    }
    if (statusEl) statusEl.classList.add("hidden");
    showPageLoading(t("route.overlayServices"), t("route.overlayServicesSub"));
    search(train, null, null, null, "", { onSettled: hidePageLoading });
  });
})();
// 换了车次号 → 重新走班次选择流程
(function () {
  const _el = document.getElementById("routeDelayTrain");
  if (_el) _el.addEventListener("input", function () { window._routeDelaySvcPicked = false; });
})();
// 车次号框：一键清空 ×（2026-09-11 用户要求，与车站输入框一致）
(function () {
  const _el = document.getElementById("routeDelayTrain");
  const _field = _el && _el.closest(".train-field");
  const _btn = document.getElementById("routeTrainClear");
  if (!_el || !_btn || !_field) return;
  const _sync = function () { _field.classList.toggle("has-value", !!_el.value); };
  _el.addEventListener("input", _sync);
  _el.addEventListener("change", _sync);
  _sync();
  _el._syncTrainClear = _sync; // 程序化回填（分享链接/草稿/班次卡）后显式刷新
  _btn.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    _el.value = "";
    window._routeDelaySvcPicked = false;
    _sync();
    _el.focus();
  });
})();
// 单车次栏车次号框（#trainInput）：一键清空 ×（2026-09-11 用户要求，与站对站/车站框同款式）
(function () {
  const _el = trainInput;
  const _field = _el && _el.closest(".station-field");
  const _btn = document.getElementById("trainClear");
  if (!_el || !_btn || !_field) return;
  const _sync = function () { _field.classList.toggle("has-value", !!_el.value); };
  _el.addEventListener("input", _sync);
  _el.addEventListener("change", _sync);
  _sync();
  _el._syncTrainClear = _sync; // 程序化回填（草稿/分享链接/示例链接/班次卡）后显式刷新
  _btn.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    _el.value = "";
    _sync();
    _el.focus();
    saveQueryDraft(); // 草稿同步为空，刷新后不复活旧值
  });
})();
// 车次号框：Enter = 查车次（2026-09-11 用户要求）
(function () {
  const _el = document.getElementById("routeDelayTrain");
  const _btn = document.getElementById("routeDelaySearchBtn");
  if (!_el || !_btn) return;
  _el.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); _btn.click(); }
  });
})();
/* ========== 站对站查询（RE/RB） ========== */

// 线路服务缓存：trainInput 输入线路号后拉取，供 from/to 下拉做上下文感知
let cachedLineServices = { line: "", services: null };

// 具体车次停靠站缓存：renderPredict 填充；与 cachedLineServices 互为补充。
// 注意：必须在此显式声明，否则「已查线路但未点具体班次」时 line 863 读取会抛
// ReferenceError（此前是隐式全局，只有 renderPredict 跑过才存在 → 下拉无反应）。
let cachedTrainStations = { train: "", stations: null };

// 站名规范化：Hbf/Hauptbahnhof/Flughafen/Bahnhof 归一、去标点空白
function normalizeStation(s) {
  return (s || "").toLowerCase()
    .replace(/hauptbahnhof|flughafen|bahnhof|hbf|bhf/g, "")
    .replace(/[^a-z0-9äöüß]/g, "");
}

// HTML 转义：防止站名/线路号中的 & < > " ' 破坏 DOM 结构（被多处 innerHTML 拼接调用）
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 起点 / 目的站下拉（route 模式）—— 上下文感知混合子系统
//
// 填充优先级（从高到低）：
//   ① 有输入文字 → /api/stations?q= 精确查（始终走后端，最准）
//   ② toInput 空白 + fromInput 有值 + 已查车次停靠站（cachedTrainStations）
//      → 显示该车次「from 站之后」的途经站（线路上下文，最相关）
//   ③ fromInput 空白 + 已查车次停靠站
//      → 显示该车次全部停靠站（用户大概率在选该车的途经站）
//   ④ 无任何上下文 → 通用站名兜底（/api/stations，保证永不空）
//
// 安全规则：上下文结果 < 3 项时自动回退通用站（绝不塌缩成 1~2 项）。
// ───────────────────────────────────────────────────────────────────────────

let _universalStations = [];   // 兜底通用站
let _universalLoaded = false;
const _CTX_MIN_ITEMS = 3;      // 上下文结果最少项数，低于此值回退通用

async function ensureUniversalStations() {
  if (_universalLoaded) return _universalStations;
  try {
    const d = await fetchJSON("/api/stations?q=");
    if (d && d.stations && d.stations.length) _universalStations = d.stations;
  } catch (_) { /* 忽略 */ }
  _universalLoaded = true;
  return _universalStations;
}

function setStationList(stations) {
  const arr = (stations && stations.length) ? stations : [];
  const html = arr.slice(0, 200)
    .map(function (s) { return '<option value="' + escapeHtml(s) + '"></option>'; })
    .join("");
  if (stationList.innerHTML !== html) stationList.innerHTML = html;
}

// ── 复用号线路补齐（2026-09-09 用户反馈「RE 7 下拉只剩一条走向的站」）：
// 点选班次后 cachedTrainStations = 该班次停靠站（单走向）。RE 7 这类复用号
// 线路同号多走向（Dessau/Berlin/Senftenberg…），下拉若只用单车次站就选不到
// 其他走向的站。这里以单车次站序为主（相关性最高），把线路全部班次的站
// 并集补在后面（去重、可排除 from 站）——单走向线路并集≈原列表，无感知。
// 同一站的多种写法各占一行会让下拉出现「重复项」：zugfinder 实时停靠站用
// "Berlin Hbf"/"Neustadt(Dosse)"，时刻表用 "Berlin Hauptbahnhof"/"Neustadt (Dosse)"。
// normalizeStation 已剥离 Hbf/Hauptbahnhof 与非字母数字，二者归一后相同 —— 按归一键
// 归并，写法统一采用时刻表（canonMap）的规范名，与班次卡、预测展示保持一致。
function _dedupeStations(list, canonMap) {
  const seen = new Set();
  const out = [];
  for (const s of list || []) {
    if (!s) continue;
    const rep = (canonMap && canonMap.get(normalizeStation(s))) || s;
    const k = normalizeStation(rep);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(rep);
  }
  return out;
}

function _ctxMergeWithLine(primary, excludeFrom) {
  const cls = cachedLineServices;
  if (!cls || !cls.services || !cls.services.length) return primary || [];
  let svcs = cls.services;
  if (regionFilter) {
    const _has = function (svc) {
      const regs = svc.regions && svc.regions.length ? svc.regions : [svc.region];
      return regs.indexOf(regionFilter) >= 0;
    };
    const f = svcs.filter(_has);
    if (f.length) svcs = f;
  }
  // 先建立「归一键 → 时刻表规范写法」映射（线路数据优先，与班次卡一致）
  const canon = new Map();
  const lineStations = [];
  for (const svc of svcs) {
    const sts = svc.all_stations && svc.all_stations.length
      ? svc.all_stations : [svc.from_station, svc.to_station];
    for (const s of sts) {
      if (!s) continue;
      const k = normalizeStation(s);
      if (k && !canon.has(k)) canon.set(k, s);
      lineStations.push(s);
    }
  }
  const ex = excludeFrom ? normalizeStation(excludeFrom) : "";
  const has = function (s) {
    if (!s) return false;
    if (ex) { const ns = normalizeStation(s); if (ns === ex) return false; }
    return true;
  };
  const set = new Set();
  _dedupeStations(primary, canon).forEach(function (s) { if (has(s)) set.add(s); });
  _dedupeStations(lineStations, canon).forEach(function (s) { if (has(s)) set.add(s); });
  return Array.from(set);
}

// ── 上下文感知：有车次停靠站缓存或线路服务缓存时，返回线路相关的站列表（或 null 表示无上下文） ──
function _getContextualStations(inputEl) {
  // 优先①：具体车次停靠站（renderPredict 填充，最精确）；复用号线路并补齐线路并集
  const cts = cachedTrainStations;
  if (cts && cts.train && cts.stations && cts.stations.length) {
    if (inputEl === toInput) {
      const fromVal = (fromInput && fromInput.value ? fromInput.value : "").trim();
      // 起始站未填：显示全部停靠站（与 fromInput 语义一致），避免回退到通用站 Aachen…
      if (!fromVal) {
        const merged = _ctxMergeWithLine(cts.stations, "");
        return merged.length >= _CTX_MIN_ITEMS ? merged : null;
      }
      const fromNorm = normalizeStation(fromVal);
      const sts = cts.stations;
      let fi = -1;
      for (let i = 0; i < sts.length; i++) {
        const ns = normalizeStation(sts[i]);
        if (ns === fromNorm || ns.startsWith(fromNorm) || fromNorm.startsWith(ns)) { fi = i; break; }
      }
      let after;
      if (fi >= 0) {
        after = sts.slice(fi + 1);
      } else {
        // from 站不在停靠站里 → 宽松排除
        after = sts.filter(function (s) {
          const ns = normalizeStation(s);
          return ns.indexOf(fromNorm) === -1 && fromNorm.indexOf(ns) === -1;
        });
      }
      const merged = _ctxMergeWithLine(after, fromVal);
      return merged.length >= _CTX_MIN_ITEMS ? merged : null;
    }
    if (inputEl === fromInput) {
      const merged = _ctxMergeWithLine(cts.stations, "");
      return merged.length >= _CTX_MIN_ITEMS ? merged : null;
    }
  }

  // 优先②：线路服务缓存（renderServices 填充，覆盖「已查线路但未选具体班次」的场景）
  // 全国复用号线路（RE 7/8 等）同号几百条班次横跨多州——并集会把下拉稀释成
  // 「半个德国的站」。用户在班次列表点了州筛选（regionFilter）即表达了对走向的
  // 选择，聚合必须跟着筛——否则下拉退回全国站，等于没有上下文（2026-09-09 复发）。
  const cls = cachedLineServices;
  if (cls && cls.line && cls.services && cls.services.length) {
    const _svcs = (function () {
      if (!regionFilter) return cls.services;
      const f = cls.services.filter(function (svc) {
        const regs = svc.regions && svc.regions.length ? svc.regions : [svc.region];
        return regs.indexOf(regionFilter) >= 0;
      });
      return f.length ? f : cls.services; // 筛后为空 → 回退全部，保证下拉不消失
    })();
    if (inputEl === toInput) {
      const fromVal = (fromInput && fromInput.value ? fromInput.value : "").trim();
      if (!fromVal) {
        // 起始站未填：显示线路上所有唯一站（同 fromInput 语义）
        const allSet = new Set();
        for (const svc of _svcs) {
          const sts = svc.all_stations && svc.all_stations.length
            ? svc.all_stations : [svc.from_station, svc.to_station];
          sts.forEach(function (s) { if (s) allSet.add(s); });
        }
        const allResult = _dedupeStations(Array.from(allSet)).sort();
        return allResult.length >= _CTX_MIN_ITEMS ? allResult : null;
      }
      const fromNorm = normalizeStation(fromVal);
      // 找经过 from 站的服务分支
      const branch = _svcs.filter(function (svc) {
        const sts = svc.all_stations && svc.all_stations.length
          ? svc.all_stations : [svc.from_station, svc.to_station];
        return sts.some(function (s) {
          const ns = normalizeStation(s);
          return ns === fromNorm || ns.startsWith(fromNorm) || fromNorm.startsWith(ns);
        });
      });
      if (!branch || !branch.length) return null;
      // 收集该分支上 from 站之后的唯一站名
      const afterSet = new Set();
      for (const svc of branch) {
        const sts = svc.all_stations && svc.all_stations.length
          ? svc.all_stations : [svc.from_station, svc.to_station];
        let found = false;
        for (const s of sts) {
          if (found) afterSet.add(s);
          const ns = normalizeStation(s);
          if (!found && (ns === fromNorm || ns.startsWith(fromNorm) || fromNorm.startsWith(ns))) found = true;
        }
      }
      const result = _dedupeStations(Array.from(afterSet)).sort();
      return result.length >= _CTX_MIN_ITEMS ? result : null;
    }
    if (inputEl === fromInput) {
      // fromInput: 收集线路上所有唯一站
      const allSet = new Set();
      for (const svc of _svcs) {
        const sts = svc.all_stations && svc.all_stations.length
          ? svc.all_stations : [svc.from_station, svc.to_station];
        sts.forEach(function (s) { if (s) allSet.add(s); });
      }
      const result = _dedupeStations(Array.from(allSet)).sort();
      return result.length >= _CTX_MIN_ITEMS ? result : null;
    }
  }

  return null;
}

// ── 主填充入口（focus / mousedown 调用）：先试上下文，再回退通用 ──
function fillStationDatalistNow(inputEl) {
  const q = (inputEl && inputEl.value ? inputEl.value : "").trim();
  if (q) { refreshStationDatalist(inputEl); return; }
  const generation = ++_stationDatalistGeneration;

  // 优先：上下文感知
  const ctx = _getContextualStations(inputEl);
  if (ctx && ctx.length) { setStationList(ctx); return; }

  // 回退：通用站名兜底
  if (_universalLoaded && _universalStations.length) {
    setStationList(_universalStations);
  } else {
    ensureUniversalStations().then(function (uni) {
      if (generation === _stationDatalistGeneration && !inputEl.value.trim()) setStationList(uni);
    });
  }
}

// ── 输入联想（防抖）：有文字时「上下文过滤优先，后端补充」；空白时同上（上下文 > 通用） ──
let _stationDatalistTimer = null;
let _stationDatalistGeneration = 0;
function refreshStationDatalist(inputEl) {
  const q = (inputEl && inputEl.value ? inputEl.value : "").trim();
  const generation = ++_stationDatalistGeneration;
  clearTimeout(_stationDatalistTimer);
  _stationDatalistTimer = setTimeout(async function () {
    if (q) {
      // 有上下文（已查线路/车次）：先在该线路真实途经站里按前缀过滤——
      //   让「输入 B」得到的是当前线路自己的 B 站（RE 3 → Bad Bevensen/Berlin…，
      //   RE 7 → Babstadt/Bad Bellingen…），随线路变化；而不是全国固定的 Bonn/Bochum。
      const ctx = _getContextualStations(inputEl);
      if (ctx && ctx.length) {
        const qLow = q.toLowerCase();
        const qNorm = normalizeStation(q);
        // 前缀匹配优先：站名或归一化名以 q 开头（"B" → Bad Bevensen/Berlin…，而非含 b 的 Altenburg）
        let matched = ctx.filter(function (s) {
          const n = normalizeStation(s);
          return s.toLowerCase().indexOf(qLow) === 0 || n.indexOf(qNorm) === 0;
        });
        // 前缀命中太少（如输入 "charlott" 只能子串匹配 Berlin-Charlottenburg）→ 补充「包含」匹配
        if (matched.length < _CTX_MIN_ITEMS) {
          const contains = ctx.filter(function (s) {
            if (matched.indexOf(s) !== -1) return false;
            return s.toLowerCase().indexOf(qLow) > 0 || normalizeStation(s).indexOf(qNorm) > 0;
          });
          matched = matched.concat(contains);
        }
        if (matched.length >= _CTX_MIN_ITEMS) {
          setStationList(matched); // 上下文命中足够 → 只显示线路相关站（随线路变）
          return;
        }
        // 上下文匹配太少（如输入 Z 但线路只有 B 站）→ 上下文命中置顶 + 后端补充
        const d = await fetchJSON("/api/stations?q=" + encodeURIComponent(q));
        if (generation !== _stationDatalistGeneration || inputEl.value.trim() !== q) return;
        if (d && d.stations) {
          const rest = d.stations.filter(function (s) {
            return matched.indexOf(s) === -1;
          });
          setStationList(matched.concat(rest));
        }
        return;
      }
      // 无上下文：纯后端全国搜索
      const d = await fetchJSON("/api/stations?q=" + encodeURIComponent(q));
      if (generation !== _stationDatalistGeneration || inputEl.value.trim() !== q) return;
      if (d && d.stations) setStationList(d.stations);
      return;
    }
    // 空白输入：同样尝试上下文
    const ctx = _getContextualStations(inputEl);
    if (ctx && ctx.length) { setStationList(ctx); return; }
    const uni = await ensureUniversalStations();
    if (generation !== _stationDatalistGeneration || inputEl.value.trim() !== q) return;
    setStationList(uni);
  }, 120);
}
// from/to 下拉事件绑定
fromInput.addEventListener('mousedown', function () { fillStationDatalistNow(fromInput); });
toInput.addEventListener('mousedown', function () { fillStationDatalistNow(toInput); });
fromInput.addEventListener('focus', function () { fillStationDatalistNow(fromInput); });
toInput.addEventListener('focus', function () { fillStationDatalistNow(toInput); });
// 输入联想：打字时实时走后端搜索（防抖 120ms），避免停留在旧的上下文/通用站列表
fromInput.addEventListener('input', function () { refreshStationDatalist(fromInput); });
toInput.addEventListener('input', function () { refreshStationDatalist(toInput); });
[trainInput, trainType, predictDateEl, fromInput, toInput].forEach(function (input) {
  input.addEventListener(input.tagName === "SELECT" ? "change" : "input", saveQueryDraft);
});

// ── 站点输入框一键清空（× 按钮）──
// 每个 .station-field 包裹一个 input + .station-clear；有值时显示 ×，点击清空并刷新下拉
function setupStationClear(inputEl) {
  const field = inputEl.closest(".station-field");
  if (!field) return;
  const clearBtn = field.querySelector(".station-clear");
  if (!clearBtn) return;
  const sync = function () {
    field.classList.toggle("has-value", !!inputEl.value);
  };
  inputEl.addEventListener("input", sync);
  inputEl.addEventListener("change", sync);
  sync();
  // 程序化回填（点班次卡自动带入起终点 / 草稿还原 / 分享链接 / 交换）不触发
  // input 事件——旧版 × 不出现，删一个字符才冒出来（2026-09-09 用户反馈）。
  // 暴露 sync 供回填点显式刷新。
  inputEl._syncClearBtn = sync;
  clearBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    inputEl.value = "";
    stationsAutoFilled = false; // 清空自动填充 → 回到用户自定义站对站输入（解除单向锁定）
    sync();
    inputEl.focus();
    fillStationDatalistNow(inputEl); // 清空后回到上下文/通用下拉
  });
}
function syncStationClears() {
  [fromInput, toInput].forEach(function (el) {
    if (el && el._syncClearBtn) el._syncClearBtn();
  });
}
setupStationClear(fromInput);
setupStationClear(toInput);

// 拼出最终查询的车次字符串：用户选了车型 + 输入号 → "RE 11"；只输入 → 原样
function buildTrainQuery() {
  const num = trainInput.value.trim();
  if (!num) return "";
  if (!trainType.value) return num; // 未选车型，原样
  // 已选车型：自动拼接前缀（但用户可能在手动输入如 "ICE 847"，避免重复）
  const prefix = trainType.value + " ";
  if (num.toUpperCase().startsWith(trainType.value.toUpperCase())) return num;
  return prefix + num;
}

searchBtn.addEventListener("click", () => search(buildTrainQuery(), "", fromInput.value.trim(), toInput.value.trim()));
statusRetryBtn.addEventListener("click", function () {
  if (statusRetryBtn.disabled) return;
  // 优先走自定义重试（如 breakdown 懒加载失败）；否则重放主预测
  var action = pendingRetryAction;
  if (!action && !lastQuery) return;
  statusRetryBtn.disabled = true;
  if (action) { pendingRetryAction = null; try { action(); } catch (e) { rerunQuery(); } }
  else rerunQuery();
});
trainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") search(buildTrainQuery(), "", fromInput.value.trim(), toInput.value.trim());
});

// 预测日期切换 → 自动用上次查询参数重查（避免显示与 select 不一致的结果）
predictDateEl.addEventListener("change", () => {
  if (!lastQuery) return;
  if (predictEl.classList.contains("hidden")) return; // 没有预测结果时无需重查
  rerunQuery();
});

async function rerunQuery() {
  if (!lastQuery) return;
  const dateISO = predictDateISO();
  if (lastQuery.mode === "input") {
    return search(lastQuery.train, lastQuery.destination,
                  lastQuery.rideFrom, lastQuery.rideTo, lastQuery.rideTime);
  }
  // route 模式：直接重发同一请求（用新日期）
  let url = "/api/train?train=" + encodeURIComponent(lastQuery.line) + "&days=10";
  if (lastQuery.toSt) url += "&destination=" + encodeURIComponent(lastQuery.toSt);
  if (dateISO) url += "&date=" + dateISO;
  if (lastQuery.fromSt) url += "&ride_from=" + encodeURIComponent(lastQuery.fromSt);
  if (lastQuery.depTime) url += "&ride_time=" + encodeURIComponent(lastQuery.depTime);
  hideStatus();
  predictEl.classList.add("hidden");
  searchBtn.disabled = true;
  searchBtn.textContent = t("search.searching");
  try {
    const data = await fetchJSON(url);
    if (data && !data.error) renderPredict(data);
    else showStatus(t("err.queryFail", { msg: localErrStr(data && data.error || "无响应") }), true, true);
  } catch (e) {
    showStatus(queryTransportError(e), true, true);
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = t("search.btn");
  }
}

// 最近 10 天图：指标切换（区间到达/终点/最大/逐站）
document.querySelectorAll(".chart-toggles .toggle-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    chart10dMetric = btn.dataset.metric;
    chart10dUserPicked = true; // 手动选择后，后续查询不再自动切回区间视图
    document.querySelectorAll(".chart-toggles .toggle-btn").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
    const sel = document.getElementById("stationSelect");
    if (sel) sel.classList.toggle("hidden", chart10dMetric !== "station");
    if (currentData) drawChart10d(currentData, chart10dMetric);
  });
});
const stationSelectEl = document.getElementById("stationSelect");
if (stationSelectEl) {
  stationSelectEl.addEventListener("change", function () {
    if (currentData) drawChart10d(currentData, chart10dMetric);
  });
}

/* ===== 全局页面切换：单车次预测 / 站对站查询 / 行程晚点与接续预测 =====
   - hash 直达（#train / #route / #journey），刷新与分享链接保持当前页
   - localStorage 记忆上次所在页
   - 切换时中止各页未完成请求，结果区互不污染
   - #status/#predict/#results 为动态结果层：跟随触发查询所在页挂载 */
var VIEW_STORAGE_KEY = "td_view";
var currentView = "train";
var _VIEW_NAMES = ["train", "route", "journey"];
var _viewTabTrain = document.getElementById("viewTabTrain");
var _viewTabRoute = document.getElementById("viewTabRoute");
var _viewTabJourney = document.getElementById("viewTabJourney");
var _viewTrainEl = document.getElementById("viewTrain");
var _viewRouteEl = document.getElementById("viewRoute");
var _viewJourneyEl = document.getElementById("viewJourney");
var _RESULT_LAYER_IDS = ["status", "predict", "results"];

function viewResultsHost(view) {
  var id = view === "route" ? "routeResultsHost" : view === "journey" ? "journeyResultsHost" : "trainResultsHost";
  return document.getElementById(id);
}
function placeResultsLayer(view) {
  var host = viewResultsHost(view);
  if (!host) return; // journey 页不承载结果层（其结果渲染在 journeyResult 内）
  _RESULT_LAYER_IDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentElement !== host) host.appendChild(el);
  });
}
function applyViewDom(view) {
  if (_viewTrainEl) _viewTrainEl.classList.toggle("hidden", view !== "train");
  if (_viewRouteEl) _viewRouteEl.classList.toggle("hidden", view !== "route");
  if (_viewJourneyEl) _viewJourneyEl.classList.toggle("hidden", view !== "journey");
  [[_viewTabTrain, "train"], [_viewTabRoute, "route"], [_viewTabJourney, "journey"]].forEach(function (p) {
    if (p[0]) {
      p[0].classList.toggle("active", p[1] === view);
      p[0].setAttribute("aria-selected", String(p[1] === view));
    }
  });
}
function resetViewBusyState() {
  // 先使进行中的查询作废（generation 自增让旧流程 catch 静默），再中止网络请求
  if (activeSearchController) { searchGeneration++; activeSearchController.abort(); activeSearchController = null; }
  if (activeJourneyController) { activeJourneyController.abort(); activeJourneyController = null; }
  if (searchBtn) { searchBtn.disabled = false; searchBtn.textContent = t("search.btn"); }
  if (journeyPredictBtn) journeyPredictBtn.disabled = false;
  var _js = document.getElementById("journeyStatus");
  if (_js) _js.className = "status hidden";
}
function switchView(view, opts) {
  if (_VIEW_NAMES.indexOf(view) < 0) view = "train";
  if (view === currentView) { applyViewDom(view); return; }
  resetViewBusyState();
  currentView = view;
  applyViewDom(view);
  _placeServiceResults(); // 班次列表宿主跟随视图（站对站卡片内 / 预测区）
  // 跨页残留清理（2026-09-14）：页脚「在 Zugfinder 查看 XX 详情」是全局 footer 里的
  // 元素，只在预测成功时被 updateZugLink 显示，却没人负责隐藏 ——
  // 从单车次页切到行程页后它仍挂着上一个车次（如行程页底部残留 ICE 847 链接），
  // 既误导又和当前页内容无关。切视图时一律收起，需要时由新页面的预测结果重新点亮。
  const _zl = document.getElementById("zugLink");
  if (_zl) _zl.classList.add("hidden");
  // 分栏隔离：评论区与分享按钮跟随当前栏的上下文
  loadComments();
  updateShareVisibility();
  try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch (e) {}
  var wantHash = "#" + view;
  if (location.hash !== wantHash) {
    try { history.replaceState(null, "", wantHash); }
    catch (e) { location.hash = view; } // 降级：触发 hashchange，其 handler 会幂等收敛
  }
  window.scrollTo({ top: 0, behavior: opts && opts.smooth ? "smooth" : "auto" });
}
if (_viewTabTrain) _viewTabTrain.addEventListener("click", function () { switchView("train"); });
if (_viewTabRoute) _viewTabRoute.addEventListener("click", function () { switchView("route"); });
if (_viewTabJourney) _viewTabJourney.addEventListener("click", function () { switchView("journey"); });
var _VIEW_TABS = [_viewTabTrain, _viewTabRoute, _viewTabJourney].filter(Boolean);
_VIEW_TABS.forEach(function (tab, idx) {
  tab.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    var next = _VIEW_TABS[(idx + (e.key === "ArrowRight" ? 1 : _VIEW_TABS.length - 1)) % _VIEW_TABS.length];
    next.focus(); next.click();
  });
});
window.addEventListener("hashchange", function () {
  var h = (location.hash || "").replace("#", "");
  if (_VIEW_NAMES.indexOf(h) >= 0 && h !== currentView) switchView(h);
});
// 初始页：URL 显式单车次参数（?train=/?share=）> hash > localStorage > 默认
(function initView() {
  var _h = (location.hash || "").replace("#", "");
  var _p0 = new URLSearchParams(location.search);
  if (_p0.has("j")) { // 行程分享链接：强制行程栏（须先于 train 判断——链接可能不含车次）
    currentView = "journey";
    if (_h && _h !== "journey") { try { history.replaceState(null, "", "#journey"); } catch (e) {} }
  } else if (_p0.has("from") && _p0.has("to")) { // 站对站分享链接：强制站对站栏（其 train= 参数属区间过滤，非单车次直查）
    currentView = "route";
    if (_h && _h !== "route") { try { history.replaceState(null, "", "#route"); } catch (e) {} }
  } else if (_p0.has("train") || _p0.has("share")) {
    currentView = "train";
    if (_h && _h !== "train") { try { history.replaceState(null, "", "#train"); } catch (e) {} }
  } else if (_VIEW_NAMES.indexOf(_h) >= 0) {
    currentView = _h;
  } else {
    var _saved = null;
    try { _saved = localStorage.getItem(VIEW_STORAGE_KEY); } catch (e) {}
    currentView = _VIEW_NAMES.indexOf(_saved) >= 0 ? _saved : "train";
  }
  applyViewDom(currentView);
})();

// 晚点分析 FAB：× 收起为半透明小圆钮（记忆到 localStorage），点圆钮恢复展开；
// 展开态点击主体仍正常跳转分析页。
(function initFabCollapse() {
  var fab = document.getElementById("delayAnalysisFab");
  if (!fab) return;
  var setCollapsed = function (c) {
    fab.classList.toggle("fab-collapsed", c);
    try { localStorage.setItem("td_fab_collapsed", c ? "1" : "0"); } catch (e) {}
  };
  try { if (localStorage.getItem("td_fab_collapsed") === "1") fab.classList.add("fab-collapsed"); } catch (e) {}
  fab.addEventListener("click", function (ev) {
    if (fab.classList.contains("fab-collapsed")) {
      ev.preventDefault(); // 收起态：点击恢复展开，不跳转
      setCollapsed(false);
      return;
    }
    var tEl = ev.target;
    if (tEl && tEl.classList && tEl.classList.contains("fab-close")) {
      ev.preventDefault(); // × ：仅收起，不跳转
      setCollapsed(true);
    }
  });
})();

// URL 参数直接查询
const params = new URLSearchParams(location.search);

// Explicit URLs take precedence over the anonymous draft restored in this tab.
if (!params.has("share") && !params.has("train") && !params.has("from") && !params.has("j")) restoreQueryDraft();

// ===== 分享链接打开端：站对站（?from=&to=&mode=delay|services[&train=]#route） =====
if (params.has("from") && params.has("to") && currentView === "route") {
  fromInput.value = params.get("from") || "";
  toInput.value = params.get("to") || "";
  syncStationClears(); // 分享链接还原为程序化赋值，同步 × 显隐
  // mode=services（旧「查车次」Tab 分享链接）已无直达查询，回落为 delay 语义
  const _rdt = document.getElementById("routeDelayTrain");
  if (_rdt && params.get("train")) { _rdt.value = params.get("train"); if (_rdt._syncTrainClear) _rdt._syncTrainClear(); }
  // 发车时间（rt=）：分享方已选定班次 → 视为已选定，predictRouteDelay 直接区间预测，
  // 复用号不再弹出班次列表让接收方重选（rt 由后端 resolve_ride 精确定位班次）
  if (params.get("rt")) {
    window._routeDelayRideTime = params.get("rt");
    window._routeDelaySvcPicked = true;
  }
  // 分享链接携带完整查询意图（车次+区间[+发车时间]）→ 直接调 search 进区间预测。
  // 不走 predictRouteDelay()：短号（ICE 847 等）未选班次时会被「先选班次」守卫改道
  // 班次列表分支，from/to 被整体丢弃 → 接收方拿到的是无区间参数的整段终点预测
  // （2026-09-11 用户反馈「区间晚点依然判定返回为整段晚点」的真正根因）。
  // search() 带 rideFrom 时必直接进预测（后端 resolve_ride 按区间+时间定位班次）。
  setTimeout(function () {
    try {
      const _tr = (_rdt && _rdt.value) || "";
      if (_tr) {
        showPageLoading(t("route.overlayPredict"), t("route.overlayPredictSub"));
        search(_tr, toInput.value, fromInput.value, toInput.value,
               window._routeDelayRideTime || "", { onSettled: hidePageLoading });
      } else {
        predictRouteDelay(); // 无车次号：常规区间预测（提示/班次列表引导）
      }
    } catch (e) {}
  }, 150);
}

// ===== 分享链接打开端：行程（?j=<legs JSON>#journey） =====
// 行程参数还原为单行文本（兼容粘贴解析），直接渲染预测
if (params.has("j") && currentView === "journey") {
  try {
    const _jp = JSON.parse(decodeURIComponent(params.get("j")));
    if (_jp && Array.isArray(_jp.legs) && _jp.legs.length) {
      const _txt = _jp.legs.map(function (l) {
        return (l.service || "") + " From " + (l.dep || "") + " " + (l.from || "") +
               " To " + (l.arr || "") + " " + (l.to || "");
      }).join(" ");
      journeyUrlInput.value = _txt;
      if (_jp.date) journeyUrlInput.value += " " + _jp.date.slice(8, 10) + "." + _jp.date.slice(5, 7) + "." + _jp.date.slice(0, 4);
      setTimeout(function () { try { predictJourney(_jp.legs, _jp.date || "", null); } catch (e) {} }, 150);
    }
  } catch (e) { /* 非法行程参数：忽略，按普通打开处理 */ }
}

// 分享链接：?share=<id> —— 直接加载预测快照（不重新查询）
if (params.has("share")) {
  (async () => {
    hideStatus();
    searchBtn.disabled = true;
    try {
      const resp = await fetch(`/api/share/${encodeURIComponent(params.get("share"))}`);
      const r = await resp.json();
      if (!resp.ok || !r.data) {
        showStatus(t("status.shareNotFound", { msg: (r.error || resp.status) }), true);
        return;
      }
      trainInput.value = r.data.train || "";
      if (trainInput._syncTrainClear) trainInput._syncTrainClear();
      renderPredict(r.data);
      // 分享快照保留线路联邦州指纹（同名车次多线路识别），避免快照页掩盖跨线问题
      const ln = r.data.line || {};
      let shareMeta = t("share.snapshotMeta", { t: (r.created_at || "").slice(0, 16).replace("T", " ") });
      if (ln.main_states && ln.main_states.length) {
        shareMeta += t("meta.line", { states: ln.main_states.join(" · ") });
        if (ln.conflict && ln.destination_auto && ln.queried_destination) {
          shareMeta += t("meta.lineConflict", { orig: ln.queried_destination, auto: ln.destination_auto });
        }
        if (ln.cross_line_filtered_days > 0) {
          shareMeta += t("meta.lineFiltered", { n: ln.cross_line_filtered_days });
        }
      }
      document.getElementById("pMeta").textContent = shareMeta;
      showShareTip(t("status.shareSnapshot"), true);
    } catch (e) {
      showStatus(t("status.shareLoadFail", { msg: e.message }), true);
    } finally {
      searchBtn.disabled = false;
    }
  })();
} else if (params.has("train") && !params.has("from") && !params.has("j")) {
  // 单车次直查（?train=）。route 分享链接的 train= 是区间过滤参数，不是直查——
  // 由上方 ?from=&to= 恢复块处理，避免双查询/串栏。
  //
  // 局部变量原名 t，与全局 i18n 函数 t() 同名并遮蔽它 —— 块内任何 t("key")
  // 都会变成 "字符串 is not a function"，报错信息还指不到根因。改名为 trainQ。
  const trainQ = params.get("train");
  trainInput.value = trainQ;
  if (trainInput._syncTrainClear) trainInput._syncTrainClear();
  search(trainQ);
}

// 页面加载后即预拉取通用站名（避免首次 focus 需等待异步）
ensureUniversalStations();

// 起终点是否由车次数据自动填充（单向线路 → 禁止 ⇄ 交换）
var stationsAutoFilled = false;
var swapBtn = document.getElementById("swapBtn");
if (swapBtn) {
  swapBtn.addEventListener("click", function () {
    if (stationsAutoFilled) {
      showStatus(t("swap.locked"), true);
      return;
    }
    var tmp = fromInput.value;
    fromInput.value = sanitizeStation(toInput.value);
    toInput.value = sanitizeStation(tmp);
    // 交换后是用户自定义方向，不再视为车次自动填充
    stationsAutoFilled = false;
    syncStationClears(); // 交换为程序化赋值，同步 × 显隐
    // 交换后刷新 toInput 的站点下拉（from 已变，用通用站名重建）
    fillStationDatalistNow(toInput);
    // 视觉反馈：短暂高亮
    swapBtn.style.color = "var(--brand)";
    setTimeout(function () { swapBtn.style.color = ""; }, 300);
  });
}
// 用户手动编辑起终点 → 视为自定义站对站输入，解除车次单向锁定
if (fromInput) fromInput.addEventListener("input", function () { stationsAutoFilled = false; });
if (toInput) toInput.addEventListener("input", function () { stationsAutoFilled = false; });

/* ===== 深色 / 浅色主题切换 ===== */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("theme", theme); } catch (e) {}
  var btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  // 关闭 lightbox（其图表颜色需随主题刷新，重开即更新）
  if (typeof closeChartLightbox === "function") closeChartLightbox();
  // 重绘主图：读取新的刻度 / 网格颜色
  if (currentData) {
    drawChart10d(currentData, chart10dMetric);
    drawStations(currentData);
  }
}
(function initTheme() {
  var btn = document.getElementById("themeToggle");
  var cur = document.documentElement.getAttribute("data-theme") || "light";
  if (btn) {
    btn.textContent = cur === "dark" ? "☀️" : "🌙";
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }
})();
