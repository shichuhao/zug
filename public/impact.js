/* impact.js —— 施工 / 天气对晚点的影响页（参考 delay_viewer 布局） */
(function () {
  "use strict";

  var REGION_KEY = {
    de_nord: "impact.region.nord", de_ost: "impact.region.ost",
    de_west: "impact.region.west", de_sued: "impact.region.sued",
    de_mitte: "impact.region.mitte",
  };
  var impactData = null;
  var CAUSE_LABELS = {
    zh: { kaskade: "前车/先前晚点连锁", ausfall: "列车停运/车辆停用", bau: "施工/维护/减速限速", wagen: "改编组", fahrzeug: "列车车辆技术故障", infrastruktur: "设施/信号/道岔/接触网故障", passagier: "乘客相关（候补/医疗/上下客）", einsatz: "紧急部门介入（警察/消防/医疗/官方）", bereitstellung: "晚备车/营运组织/用人", wetter: "天气/自然灾害", sonstiges: "其他/未归类", strecke: "线路障碍（落树/异物/动物）", ausland: "跨境/边境管制", keine: "无原因说明", ersatz: "替代交通/绕行" },
    en: { kaskade: "Knock-on delay from preceding services", ausfall: "Service or vehicle cancellation", bau: "Construction, maintenance and speed restrictions", wagen: "Train formation changes", fahrzeug: "Rolling-stock faults", infrastruktur: "Infrastructure, signalling and overhead-line faults", passagier: "Passenger-related incidents", einsatz: "Emergency-service intervention", bereitstellung: "Operational staffing and rolling-stock provision", wetter: "Weather and natural hazards", sonstiges: "Other or uncategorized", strecke: "Track obstructions", ausland: "Cross-border and border control", keine: "No reason stated", ersatz: "Replacement transport and diversions" },
    de: { kaskade: "Folgeverspätung durch vorherige Züge", ausfall: "Zug- oder Fahrzeugausfall", bau: "Bau, Instandhaltung und Langsamfahrstellen", wagen: "Wagenreihungsänderungen", fahrzeug: "Fahrzeugstörungen", infrastruktur: "Infrastruktur-, Signal- und Oberleitungsstörungen", passagier: "Fahrgastbezogene Ereignisse", einsatz: "Einsatz von Rettungs- und Sicherheitskräften", bereitstellung: "Betrieb, Personal und Bereitstellung", wetter: "Wetter und Naturereignisse", sonstiges: "Sonstiges oder nicht zugeordnet", strecke: "Hindernisse auf der Strecke", ausland: "Grenzverkehr und Grenzkontrollen", keine: "Keine Ursache angegeben", ersatz: "Ersatzverkehr und Umleitungen" }
  };
  var SUBCATEGORY_LABELS = {
    zh: { bauarbeiten: "施工", signal_rep: "信号设备维修", strecke_rep: "线路维修", weiche_rep: "道岔维修", oberleitung_rep: "接触网维修", sperrung: "线路封锁", langsamfahrt: "临时限速", haltezeit: "延长停站", bruecke: "桥梁损坏" },
    en: { bauarbeiten: "Construction works", signal_rep: "Signal-system maintenance", strecke_rep: "Track maintenance", weiche_rep: "Switch maintenance", oberleitung_rep: "Overhead-line maintenance", sperrung: "Line closure", langsamfahrt: "Temporary speed restriction", haltezeit: "Extended station stop", bruecke: "Bridge damage" },
    de: { bauarbeiten: "Bauarbeiten", signal_rep: "Signalanlagen-Instandhaltung", strecke_rep: "Gleisinstandhaltung", weiche_rep: "Weicheninstandhaltung", oberleitung_rep: "Oberleitungs-Instandhaltung", sperrung: "Streckensperrung", langsamfahrt: "Langsamfahrt", haltezeit: "Verlängerter Aufenthalt", bruecke: "Brückenschaden" }
  };
  var INCIDENT_CAUSE_LABELS = {
    zh: { "Witterungsbedingte Einflüsse": "天气因素", "Bauarbeiten": "施工", "Technische Störung": "技术故障" },
    en: { "Witterungsbedingte Einflüsse": "Weather-related factors", "Bauarbeiten": "Construction works", "Technische Störung": "Technical fault" },
    de: { "Witterungsbedingte Einflüsse": "Witterungsbedingte Einflüsse", "Bauarbeiten": "Bauarbeiten", "Technische Störung": "Technische Störung" }
  };

  function regionLabel(region) {
    return REGION_KEY[region] ? t(REGION_KEY[region]) : region;
  }

  function localizedLabel(labels, key, fallback) {
    return (labels[getLang()] && labels[getLang()][key]) || fallback || key;
  }

  function incidentCauseLabel(cause, fallback) {
    return localizedLabel(INCIDENT_CAUSE_LABELS, cause, fallback || cause);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ===== 深色 / 浅色切换（与主页共用 localStorage key: theme，互通） ===== */
  (function () {
    var btn = document.getElementById("themeToggle");
    if (!btn) return;
    var cur = document.documentElement.getAttribute("data-theme") || "light";
    btn.textContent = cur === "dark" ? "☀️" : "🌙";
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) {}
      btn.textContent = next === "dark" ? "☀️" : "🌙";
    });
  })();

  /* 重试按钮：局部重新 fetch，不做整页刷新 */
  function retryBtn() {
    var b = document.createElement("button");
    b.className = "user-btn";
    b.type = "button";
    b.textContent = t("impact.retry");
    b.addEventListener("click", function () { load(); });
    return b;
  }

  /* 时间戳 locale 跟随应用语言 */
  var LOCALE = { zh: "zh-CN", en: "en-GB", de: "de-DE" };

  /* 加载骨架屏：4 张指标卡 + 1 块面板 */
  function loadingSkeleton() {
    var h = '<div class="impact-metrics" style="animation:none">';
    for (var i = 0; i < 4; i++) {
      h += '<div class="skeleton"><div class="sk-line"></div><div class="sk-line big"></div></div>';
    }
    h += '</div><div class="skeleton panel-sk"></div>';
    return h;
  }

  function fmt(n, digits) {
    if (n == null || isNaN(n)) return "-";
    return Number(n).toFixed(digits == null ? 1 : digits);
  }

  function pctBar(value, max, cls) {
    var w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return '<div class="bar-bg"><div class="bar-fill' + (cls ? " " + cls : "") +
      '" style="width:' + w + '%"></div></div>';
  }

  function lvlBadge(level) {
    var cls = level === "high" ? "lvl-high"
      : level === "medium" ? "lvl-medium" : "lvl-low";
    var label = level === "high" ? t("impact.lvl.high")
      : level === "medium" ? t("impact.lvl.medium") : t("impact.lvl.low");
    return '<span class="lvl-badge ' + cls + '">' + esc(label) + "</span>";
  }

  function metrics(d) {
    var bau = d.bau || {}, wx = d.weather || {};
    document.getElementById("mBau").innerHTML =
      fmt(bau.percent, 2) + "% <small>· " + (bau.count || 0).toLocaleString() +
      " " + esc(t("impact.unit.remarks")) + "</small>";
    document.getElementById("mWx").innerHTML =
      fmt(wx.percent, 2) + "% <small>· " + (wx.count || 0).toLocaleString() +
      " " + esc(t("impact.unit.remarks")) + "</small>";
    document.getElementById("mRisk").textContent =
      (wx.risk_days || 0) + " " + t("impact.unit.days");
    document.getElementById("mMax").innerHTML =
      fmt(wx.max_delay_min, 1) + " <small>" + esc(t("impact.unit.min")) + "</small>";
  }

  function renderCauses(d) {
    var max = 0;
    (d.causes || []).forEach(function (c) { if (c.percent > max) max = c.percent; });
    var html = '<div class="impact-panel">';
    html += '<h2>' + esc(t("impact.otherCauses")) + '</h2>';
    html += '<table><thead><tr><th>' + esc(t("impact.causeRank")) + "</th>" +
      "<th>" + esc(t("impact.colCause")) + "</th>" +
      "<th>" + esc(t("impact.colCount")) + "</th>" +
      "<th>" + esc(t("impact.colPercent")) + "</th></tr></thead><tbody>";
    (d.causes || []).forEach(function (c) {
      html += "<tr><td>" + c.rank + "</td><td>" + esc(localizedLabel(CAUSE_LABELS, c.category, c.cn)) +
        "</td><td>" + (c.count || 0).toLocaleString() + "</td><td>" +
        pctBar(c.percent, max) + ' <span style="font-size:12px">' +
        fmt(c.percent, 2) + "%</span></td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function renderBau(d) {
    var bau = d.bau;
    if (!bau || !bau.subcategories || !bau.subcategories.length) return "";
    var max = 0;
    bau.subcategories.forEach(function (s) { if (s.count > max) max = s.count; });
    var rank = (d.causes || []).find(function (c) { return c.category === "bau"; }) || {};
    /* 备注文案数据驱动：施工之上若是其他类别则点名，施工居首则用专用文案 */
    var above = (d.causes || []).find(function (c) { return c.rank < rank.rank; });
    var noteKey = above ? "impact.bauNote" : "impact.bauNoteTop";
    var noteParams = above
      ? { rank: rank.rank, top1: localizedLabel(CAUSE_LABELS, above.category, above.cn) }
      : {};
    var html = '<div class="impact-panel">';
    html += "<h2>" + esc(t("impact.bauTitle")) + "</h2>";
    html += '<p class="note">' + esc(t(noteKey, noteParams)) + "</p>";
    html += '<table><thead><tr><th>' + esc(t("impact.colCause")) + "</th>" +
      "<th>" + esc(t("impact.colCount")) + "</th>" +
      "<th>" + esc(t("impact.colPercent")) + "</th></tr></thead><tbody>";
    bau.subcategories.forEach(function (s) {
      html += "<tr><td>" + esc(localizedLabel(SUBCATEGORY_LABELS, s.subcategory, s.cn)) + "</td><td>" +
        (s.count || 0).toLocaleString() + "</td><td>" +
        pctBar(s.count, max) + ' <span style="font-size:12px">' +
        fmt(s.pct_cat, 1) + "%</span></td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function renderWeather(d) {
    var wx = d.weather;
    if (!wx || !wx.by_region || !wx.by_region.length) return "";
    var maxSum = 0;
    wx.by_region.forEach(function (r) { if (r.sum > maxSum) maxSum = r.sum; });
    var html = '<div class="impact-panel">';
    html += "<h2>" + esc(t("impact.wxTitle")) + "</h2>";
    html += '<p class="note">' + esc(t("impact.wxNote")) + "</p>";
    html += '<table><thead><tr><th>' + esc(t("impact.colRegion")) + "</th>" +
      "<th>" + esc(t("impact.colAvg")) + "</th>" +
      "<th>" + esc(t("impact.colSum")) + "</th>" +
      "<th>" + esc(t("impact.colMax")) + "</th>" +
      "<th>" + esc(t("impact.colDays")) + "</th></tr></thead><tbody>";
    wx.by_region.forEach(function (r) {
      html += "<tr><td class=\"region-name\">" + esc(regionLabel(r.region)) +
        "</td><td>" + fmt(r.avg, 2) + "</td><td>" +
        pctBar(r.sum, maxSum, "wx") + ' <span style="font-size:12px">' +
        fmt(r.sum, 1) + "</span></td><td>" + fmt(r.max, 1) + "</td><td>" +
        r.delay_days + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function renderIncidents(d) {
    if (!d.incidents || !d.incidents.length) return "";
    var html = '<div class="impact-panel">';
    html += "<h2>" + esc(t("impact.incidentTitle")) + "</h2>";
    html += '<p class="note">' + esc(t("impact.wxRegionNote")) + "</p>";
    html += '<table><thead><tr><th>' + esc(t("impact.colPeriod")) + "</th>" +
      "<th>" + esc(t("impact.colRegion")) + "</th>" +
      "<th>" + esc(t("impact.colCause")) + "</th>" +
      "<th>" + esc(t("impact.colSeverity")) + "</th>" +
      "<th>" + esc(t("impact.colDelay")) + "</th></tr></thead><tbody>";
    d.incidents.forEach(function (x) {
      html += "<tr><td>" + esc(x.start_date) + " → " + esc(x.end_date) +
        "</td><td>" + esc(regionLabel(x.region)) + "</td><td>" +
        esc(incidentCauseLabel(x.cause, x.incident_type)) + "</td><td>" + lvlBadge(x.severity) +
        "</td><td>" + (x.delay_min == null ? "-" : fmt(x.delay_min, 0)) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function render(d) {
    lastMissing = null; /* 数据恢复后清除缺失态缓存，否则切语言又渲染回缺失提示 */
    /* 数据可用才显示指标卡（缺失/失败时保持 hidden，不留 "-" 空卡） */
    var mRow = document.getElementById("metricsRow");
    if (mRow) mRow.hidden = false;
    metrics(d);
    var body = document.getElementById("impactBody");
    body.innerHTML = renderBau(d) + renderWeather(d) + renderIncidents(d) + renderCauses(d);
    var foot = document.getElementById("impactFoot");
    foot.textContent = t("impact.generated") + ": " +
      (d.generated_at ? new Date(d.generated_at).toLocaleString(LOCALE[getLang()] || undefined) : "-") +
      " · " + t("impact.totalRemarks") + ": " + (d.total_remarks || 0).toLocaleString();
  }

  function load() {
    var body = document.getElementById("impactBody");
    var mRow = document.getElementById("metricsRow");
    if (mRow) mRow.hidden = true; /* 重取期间先藏指标卡 */
    body.innerHTML = loadingSkeleton();
    fetch("/api/impact", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (d && d.available === false) { renderMissing(d); return; }
        if (d.error) throw new Error(d.error);
        impactData = d;
        render(d);
      })
      .catch(function (e) {
        body.innerHTML = '<div class="impact-error">' + esc(t("impact.loadFail")) +
          " (" + esc(e.message) + ") </div>";
        var box = body.querySelector(".impact-error");
        if (box) box.appendChild(retryBtn());
      });
  }

  /* 数据文件未部署：明确列出缺失文件与存放目录 */
  var lastMissing = null;
  function renderMissing(d) {
    lastMissing = d;
    var body = document.getElementById("impactBody");
    if (!body) return;
    var files = (d.missing || []).join(", ");
    body.innerHTML = '<div class="impact-error">' +
      esc(t("impact.dataMissing", { files: files, dir: d.dir || "data/impact/" })) + "</div>";
    var box = body.querySelector(".impact-error");
    if (box) box.appendChild(retryBtn());
  }

  /* 语言切换时重渲染 */
  _onLangChange = function () {
    document.title = t("impact.title") + " · " + t("impact.link");
    if (lastMissing) { renderMissing(lastMissing); return; }
    if (impactData) render(impactData);
  };

  initLangSelect && initLangSelect();
  applyI18n && applyI18n(document);
  document.title = t("impact.title") + " · " + t("impact.link");
  load();
})();
