// ===================== auth.js —— 登录 / 注册 / 查询历史 =====================
// 从 app.js 拆出（2026-09-18，QA ENG-11）：app.js 已 24 万字节，按功能切分便于维护。
// 加载顺序：i18n.js → app.js → auth.js → comments.js（index.html 中依次 defer/sync）。
// 本文件与 app.js 共享全局作用域：函数/变量均为全局声明，跨文件调用发生在事件回调中，
// 不依赖「谁先定义」，只依赖「都已在触发前加载完成」——这点由 HTML 中的顺序保证。
/* ===================== 登录 / 注册 / 查询历史 ===================== */

var AUTH_TOKEN_KEY = "td_token";
var currentUser = null;
var authTab = "login";

function updateAuthUI(user) {
  currentUser = user;
  var info = document.getElementById("userInfo");
  var loginBtn = document.getElementById("loginBtn");
  var logoutBtn = document.getElementById("logoutBtn");
  var histBtn = document.getElementById("historyBtn");
  if (!info || !loginBtn) return;
  if (user) {
    info.textContent = user.email;
    info.classList.remove("hidden");
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");
    histBtn.classList.remove("hidden");
  } else {
    info.textContent = "";
    info.classList.add("hidden");
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
    histBtn.classList.add("hidden");
  }
}

function showAuthMsg(msg, isError) {
  var el = document.getElementById("authMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = isError ? "var(--red)" : "var(--green)";
}

// 认证结果顶部横幅（注册/登录/登出成功）：显示在 header 下方，3.5s 后自动隐藏
function showAuthTopMsg(msg, isError) {
  var el = document.getElementById("authTopMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("hidden", "ok", "err");
  if (!msg) { el.classList.add("hidden"); return; }
  el.classList.add(isError ? "err" : "ok");
  if (el._timer) clearTimeout(el._timer);
  el._timer = setTimeout(function () { el.classList.add("hidden"); }, 3500);
}

function openAuth(tab) {
  authTab = tab || "login";
  var modal = document.getElementById("authModal");
  if (modal) {
    modal._returnFocus = document.activeElement;
    modal.classList.remove("hidden");
  }
  var loginBtn = document.getElementById("loginBtn");
  if (loginBtn) loginBtn.classList.add("hidden");
  var emailEl = document.getElementById("authEmail");
  if (emailEl) emailEl.value = "";
  var pwEl = document.getElementById("authPassword");
  if (pwEl) pwEl.value = "";
  showAuthMsg("");
  syncAuthTabs();
  if (emailEl) emailEl.focus();
}

function closeAuth() {
  var modal = document.getElementById("authModal");
  if (modal) modal.classList.add("hidden");
  var fallbackFocus = null;
  if (!currentUser) {
    var loginBtn = document.getElementById("loginBtn");
    if (loginBtn) {
      loginBtn.classList.remove("hidden");
      fallbackFocus = loginBtn;
    }
  }
  var returnFocus = modal && modal._returnFocus;
  if (returnFocus && document.contains(returnFocus) && !returnFocus.classList.contains("hidden")) {
    returnFocus.focus();
  } else if (fallbackFocus) {
    fallbackFocus.focus();
  }
}

// 密码强度规则：与服务端 PASSWORD_RULE_MSG 保持一致（8–128 位 + 字母 + 数字）
function passwordStrong(pw) {
  var s = String(pw || "");
  return s.length >= 8 && s.length <= 128 && /[A-Za-z]/.test(s) && /[0-9]/.test(s);
}

function syncAuthTabs() {
  var tabLogin = document.getElementById("tabLogin");
  var tabReg = document.getElementById("tabRegister");
  var submit = document.getElementById("authSubmit");
  if (tabLogin) tabLogin.classList.toggle("active", authTab === "login");
  if (tabReg) tabReg.classList.toggle("active", authTab === "register");
  if (submit) submit.textContent = authTab === "login" ? t("auth.tabLogin") : t("auth.tabRegister");
}

async function submitAuth() {
  var emailEl = document.getElementById("authEmail");
  var pwEl = document.getElementById("authPassword");
  var email = (emailEl.value || "").trim();
  var pw = pwEl.value || "";
  if (!email || !pw) {
    showAuthMsg(t("auth.needEmailPw"), true);
    return;
  }
  // 前端预校验密码强度（服务端还有一层硬校验，这里只是把反馈提前到输入阶段）
  if (authTab === "register" && !passwordStrong(pw)) {
    showAuthMsg(t("auth.pwRule"), true);
    return;
  }
  var submit = document.getElementById("authSubmit");
  if (submit) submit.disabled = true;
  try {
    var resp = await fetch(authTab === "login" ? "/api/login" : "/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",   // 接收并保存 httpOnly 会话 Cookie
      body: JSON.stringify({ email: email, password: pw })
    });
    var data = null;
    try { data = await resp.json(); } catch (e) {}
    if (!resp.ok || !data || !data.token) {
      showAuthMsg((data && data.error) ? localErrStr(data.error) : t("auth.fail"), true);
      return;
    }
    // 会话已在 httpOnly Cookie 中，前端不再持有 token。
    // 顺手清掉旧版本遗留在 localStorage 里的 token（历史上写过 td_token）。
    try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
    closeAuth();
    updateAuthUI(data.user);
    showAuthTopMsg(authTab === "register" ? t("auth.registerOk") + data.user.email : t("auth.loginOk") + data.user.email, false);
  } catch (e) {
    showAuthMsg(t("err.network", { msg: e.message }), true);
  } finally {
    if (submit) submit.disabled = false;
  }
}

function logout() {
  fetch("/api/logout", { method: "POST", headers: authHeaders(), credentials: "same-origin" }).catch(function () {});
  try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
  updateAuthUI(null);
  closeHistory();
  showAuthTopMsg(t("auth.logoutOk"), false);
}

/* ---------- 查询历史 ---------- */

function historyLabel(r) {
  if (!r) return "查询";
  switch (r.type) {
    case "train":
      return t("hist.train") + escapeHtml(r.train || "") +
        (r.destination ? " → " + escapeHtml(r.destination) : "") +
        (r.date ? "（" + escapeHtml(r.date) + "）" : "");
    case "services":
      return t("hist.services") + escapeHtml(r.line || "");
    case "routes":
      return t("hist.routes") + escapeHtml(r.from || "") + " → " + escapeHtml(r.to || "") +
        (r.time ? " @" + escapeHtml(r.time) : "");
    case "routes_live":
      return t("hist.routesLive") + escapeHtml(r.from || "") + " → " + escapeHtml(r.to || "") +
        (r.time ? " @" + escapeHtml(r.time) : "");
    default:
      return t("hist.query");
  }
}

// 误差着色（|误差|：≤3 绿，≤10 黄，>10 红）
function errorCls(err) {
  const a = Math.abs(err);
  if (a <= 3) return "err-ok";
  if (a <= 10) return "err-warn";
  return "err-bad";
}

// 历史条目的附加信息（预测 vs 实际）
function historyExtra(r) {
  if (r.type !== "train") return "";
  const pred = r.prediction || {};
  const est = pred.point_estimate;
  if (r._backfilling) {
    return '<div class="h-extra err-pending">' + t("history.backfilling") + '</div>';
  }
  if (r.actual && r.actual.needs_backfill) {
      return '<div class="h-extra err-pending">' + t("history.needBackfill") +
      '<button type="button" class="h-backfill" data-id="' + escapeHtml(r.id) + '">' + t("history.backfillBtn") + '</button></div>';
  }
  if (r.actual && r.actual.end_delay != null) {
    if (r.actual.canceled) {
      return '<div class="h-extra">' + t("history.pred") + ' <b>' + (est != null ? est + " " + t("unit.min") : "—") +
        '</b> · ' + t("history.actual") + ' <b class="err-bad">' + t("history.canceled") + '</b></div>';
    }
    const err = r.actual.error;
    const errHtml = (err != null)
      ? '<span class="' + errorCls(err) + '">' + t("history.error") + ' ' + (err >= 0 ? "+" : "") + err + " " + t("unit.min") + '</span>'
      : '<span class="err-pending">' + t("history.known") + '</span>';
    return '<div class="h-extra">' + t("history.pred") + ' <b>' + (est != null ? est + " " + t("unit.min") : "—") +
      '</b> · ' + t("history.actual") + ' <b>' + r.actual.end_delay + " " + t("unit.min") + '</b> · ' + errHtml + '</div>';
  }
  // 预测日未到
  const pd = pred.prediction_date || "";
  return '<div class="h-extra err-pending">' + t("history.pending", { pd: escapeHtml(pd) }) + '</div>';
}

function openHistory() {
  var panel = document.getElementById("historyPanel");
  if (!panel) return;
  panel.classList.remove("hidden");
  loadHistory();
}

function closeHistory() {
  var panel = document.getElementById("historyPanel");
  if (panel) panel.classList.add("hidden");
}

function loadHistory() {
  var listEl = document.getElementById("historyList");
  if (!listEl) return;
  listEl.innerHTML = '<div class="history-empty">' + t("history.loading") + '</div>';
  fetchJSON("/api/history").then(function (d) {
    if (!d || !d.history) {
      listEl.innerHTML = '<div class="history-empty">' + t("history.loginFail") + '</div>';
      return;
    }
    renderHistory(d.history);
    autoBackfill(d.history);
  });
}

// 自动回填：对"预测日已过但无实际值"的记录串行回填（最多 3 条，避免长时间占用）
function autoBackfill(list) {
  var targets = (list || []).filter(function (r) {
    return r.type === "train" && r.actual && r.actual.needs_backfill && !r._backfilling;
  }).slice(0, 3);
  if (!targets.length) return;
  targets.reduce(function (p, r) {
    return p.then(function () { return backfillHistory(r.id); });
  }, Promise.resolve());
}

function backfillHistory(id) {
  return fetch("/api/history/backfill", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
    body: JSON.stringify({ id: id })
  }).then(function () { loadHistory(); }).catch(function () { loadHistory(); });
}

// 历史记录缓存（详情弹窗用）
var historyRecordMap = {};

function renderHistory(list) {
  var listEl = document.getElementById("historyList");
  if (!listEl) return;
  if (!list || !list.length) {
    listEl.innerHTML = '<div class="history-empty">' + t("history.empty") + '</div>';
    return;
  }
  // 把当前列表记录缓存，供详情弹窗使用
  historyRecordMap = {};
  list.forEach(function (r) { historyRecordMap[r.id] = r; });
  listEl.innerHTML = list.map(function (r) {
    var time = "";
    try { time = new Date(r.ts).toLocaleString(localeOf(), { hour12: false }); } catch (e) {}
    return '<div class="history-item" data-id="' + escapeHtml(r.id) + '">' +
      '<div class="h-main">' +
      '<div class="h-label">' + historyLabel(r) + "</div>" +
      historyExtra(r) +
      "</div>" +
      '<div class="h-meta">' + escapeHtml(time) + "</div>" +
      '<button type="button" class="h-del" title="' + t("history.delTitle") + '">' + t("history.del") + '</button>' +
      "</div>";
  }).join("");
  listEl.querySelectorAll(".history-item").forEach(function (item) {
    item.addEventListener("click", function (e) {
      if (e.target.closest(".h-del") || e.target.closest(".h-backfill")) return;
      var rec = historyRecordMap[item.dataset.id];
      if (rec) openHistoryDetail(rec);
    });
    item.querySelector(".h-del").addEventListener("click", function () {
      var id = item.dataset.id;
      fetch("/api/history?id=" + encodeURIComponent(id), {
        method: "DELETE", headers: authHeaders()
      }).then(function () { loadHistory(); }).catch(function () { loadHistory(); });
    });
    var bf = item.querySelector(".h-backfill");
    if (bf) bf.addEventListener("click", function () {
      bf.disabled = true;
      bf.textContent = t("history.backfillNow");
      backfillHistory(item.dataset.id);
    });
  });
}

function renderHistoryDetail(r) {
  function row(label, value) {
    return '<div class="hd-row"><div class="hd-label">' + escapeHtml(label) + '</div>' +
           '<div class="hd-value">' + escapeHtml(String(value || "—")) + '</div></div>';
  }
  function actualValue(rec) {
    if (rec._backfilling) return t("history.statusBackfilling");
    if (rec.actual && rec.actual.needs_backfill) return t("history.statusNeedBackfill");
    if (rec.actual && rec.actual.canceled) return t("history.statusCanceled");
    if (rec.actual && rec.actual.end_delay != null) return rec.actual.end_delay + " " + t("unit.min");
    if (rec.actual === null && rec.type === "train") {
      var pd = rec.prediction && rec.prediction.prediction_date;
      return t("history.statusPending", { pd: pd || "" });
    }
    return "—";
  }
  function errorValue(rec) {
    if (rec.actual && rec.actual.error != null) {
      var err = rec.actual.error;
      return (err >= 0 ? "+" : "") + err + " " + t("unit.min");
    }
    return "—";
  }

  var rows = [];
  var typeLabel = "";
  switch (r.type) {
    case "train": typeLabel = t("history.valueTrain"); break;
    case "services": typeLabel = t("history.valueServices"); break;
    case "routes": typeLabel = t("history.valueRoute"); break;
    case "routes_live": typeLabel = t("history.valueRouteLive"); break;
    default: typeLabel = r.type || "—";
  }
  rows.push(row(t("history.fieldType"), typeLabel));
  var time = "";
  try { time = new Date(r.ts).toLocaleString(localeOf(), { hour12: false }); } catch (e) {}
  rows.push(row(t("history.fieldTime"), time));

  if (r.type === "train") {
    rows.push(row(t("history.fieldTrain"), r.train));
    rows.push(row(t("history.fieldDestination"), r.destination));
    var pred = r.prediction || {};
    rows.push(row(t("history.fieldDate"), pred.prediction_date || r.date));
    rows.push(row(t("history.fieldPred"), (pred.point_estimate != null ? pred.point_estimate + " " + t("unit.min") : null)));
    rows.push(row(t("history.fieldActual"), actualValue(r)));
    rows.push(row(t("history.fieldError"), errorValue(r)));
  } else if (r.type === "services") {
    rows.push(row(t("history.fieldLine"), r.line));
  } else if (r.type === "routes" || r.type === "routes_live") {
    rows.push(row(t("history.fieldFrom"), r.from));
    rows.push(row(t("history.fieldTo"), r.to));
    rows.push(row(t("history.fieldDeparture"), r.time));
  }
  return '<div class="hd-rows">' + rows.join("") + '</div>';
}

function openHistoryDetail(r) {
  var modal = document.getElementById("historyDetailModal");
  var body = document.getElementById("historyDetailBody");
  if (!modal || !body) return;
  body.innerHTML = renderHistoryDetail(r);
  modal.classList.remove("hidden");
}

function closeHistoryDetail() {
  var modal = document.getElementById("historyDetailModal");
  if (modal) modal.classList.add("hidden");
}

// 评论图片点击放大（lightbox）
function openCommentLightbox(src) {
  var modal = document.getElementById("commentLightbox");
  var img = document.getElementById("commentLightboxImg");
  if (!modal || !img) return;
  // QA ENG-15：记录触发元素，关闭时把焦点还回去（键盘/读屏用户不会"掉"到 body）
  modal._returnFocus = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;
  img.src = src || "";
  modal.classList.remove("hidden");
  var closeBtn = document.getElementById("commentLightboxClose");
  if (closeBtn) closeBtn.focus();
}
function closeCommentLightbox() {
  var modal = document.getElementById("commentLightbox");
  if (!modal) return;
  modal.classList.add("hidden");
  var rf = modal._returnFocus;
  if (rf && document.contains(rf)) { try { rf.focus(); } catch (e) {} }
  modal._returnFocus = null;
}

/* ---------- 初始化 ---------- */

function initAuth() {
  // 会话改由 httpOnly Cookie 承载，前端看不到 token 是否存在，
  // 只能问一次服务端：已登录则渲染用户信息，否则渲染未登录态。
  fetchJSON("/api/me").then(function (d) {
    if (d && d.user) {
      updateAuthUI(d.user);
    } else {
      updateAuthUI(null);
    }
  }).catch(function () {
    updateAuthUI(null);
  });

  var loginBtn = document.getElementById("loginBtn");
  if (loginBtn) loginBtn.addEventListener("click", function () { openAuth("login"); });
  var logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);
  var histBtn = document.getElementById("historyBtn");
  if (histBtn) histBtn.addEventListener("click", openHistory);
  var authClose = document.getElementById("authClose");
  if (authClose) authClose.addEventListener("click", closeAuth);
  var histClose = document.getElementById("historyClose");
  if (histClose) histClose.addEventListener("click", closeHistory);
  var tabLogin = document.getElementById("tabLogin");
  if (tabLogin) tabLogin.addEventListener("click", function () { authTab = "login"; syncAuthTabs(); });
  var tabReg = document.getElementById("tabRegister");
  if (tabReg) tabReg.addEventListener("click", function () { authTab = "register"; syncAuthTabs(); });
  var authForm = document.getElementById("authForm");
  if (authForm) authForm.addEventListener("submit", function (e) {
    e.preventDefault();
    submitAuth();
  });
  var modal = document.getElementById("authModal");
  if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) closeAuth(); });

  var histDetailClose = document.getElementById("historyDetailClose");
  if (histDetailClose) histDetailClose.addEventListener("click", closeHistoryDetail);
  var histDetailModal = document.getElementById("historyDetailModal");
  if (histDetailModal) histDetailModal.addEventListener("click", function (e) { if (e.target === histDetailModal) closeHistoryDetail(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeHistoryDetail(); });

  // 评论图片 lightbox：关闭按钮 / 点遮罩 / ESC
  var cmtLbClose = document.getElementById("commentLightboxClose");
  if (cmtLbClose) cmtLbClose.addEventListener("click", closeCommentLightbox);
  var cmtLb = document.getElementById("commentLightbox");
  if (cmtLb) cmtLb.addEventListener("click", function (e) { if (e.target === cmtLb) closeCommentLightbox(); });
}
