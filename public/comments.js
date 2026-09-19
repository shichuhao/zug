// ===================== comments.js —— 评论区 + 访客统计 =====================
// 从 app.js 拆出（2026-09-18，QA ENG-11）。
// 依赖 app.js 的 fetchJSON / localErrStr / t() 等全局函数与 auth.js 的 currentUser。
// 末尾的 initAuth() / initComments() / trackVisitor() 是本文件的顶层启动点：
// 顺序必须保持（先绑事件，再渲染评论，最后上报访客）。
/* ===================== 评论区 ===================== */

function fmtCommentTime(ts) {
  try {
    return new Date(ts).toLocaleString(localeOf(), { hour12: false });
  } catch (e) { return ""; }
}

function maskEmail(email) {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 1) return email;
  return email.slice(0, 2) + "***" + email.slice(at);
}

// ===== 分栏上下文（评论桶 + 分享共用）=====
// 每栏独立的查询上下文：train=单车次结果(currentData)；route/journey=最近查询的起终点
var routeCtx = { from: "", to: "" };
var journeyCtx = { from: "", to: "" };
function normCtxKey(s) {
  return String(s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}
// 当前栏的评论归属：
//   train 栏   → 查询了车次 → TRAIN_KEY；未查询 → ""（首页全局桶，现状保留）
//   route 栏   → 查询了起终点 → ROUTE_<FROM>__<TO>；未查询 → ROUTE 专属桶
//   journey 栏 → 分析了行程 → JOURNEY_<FROM>__<TO>；未查询 → JOURNEY 专属桶
// route/journey 未查询不可用空 key——否则会串到首页全局评论。
function commentContext() {
  if (currentView === "route") {
    if (routeCtx.from && routeCtx.to) {
      return { key: "ROUTE_" + normCtxKey(routeCtx.from) + "__" + normCtxKey(routeCtx.to), name: routeCtx.from + " → " + routeCtx.to };
    }
    return { key: "ROUTE", title: t("comment.titleRouteTab") };
  }
  if (currentView === "journey") {
    if (journeyCtx.from && journeyCtx.to) {
      return { key: "JOURNEY_" + normCtxKey(journeyCtx.from) + "__" + normCtxKey(journeyCtx.to), name: journeyCtx.from + " → " + journeyCtx.to };
    }
    return { key: "JOURNEY", title: t("comment.titleJourneyTab") };
  }
  var t8 = currentData && currentData.train ? String(currentData.train).trim() : "";
  return { key: t8 ? normCtxKey(t8) : "", name: t8 };
}

function loadComments() {
  var listEl = document.getElementById("commentList");
  if (!listEl) return;
  var ctx = commentContext();
  listEl.innerHTML = '<div class="history-empty">' + t("comment.loading") + '</div>';
  fetchJSON("/api/comments" + (ctx.key ? "?train=" + encodeURIComponent(ctx.key) : "")).then(function (d) {
    if (!d || !d.comments) {
      listEl.innerHTML = '<div class="history-empty">' + t("comment.loadFail") + '</div>';
      return;
    }
    renderComments(d.comments, d.total, ctx);
  });
}

function renderComments(list, total, ctx) {
  var listEl = document.getElementById("commentList");
  var countEl = document.getElementById("commentCount");
  var titleEl = document.querySelector(".comments-title");
  if (!listEl) return;
  if (titleEl) {
    if (ctx && ctx.key) titleEl.textContent = ctx.title || t("comment.titleTrain", { train: ctx.name || ctx.key });
    else titleEl.textContent = t("comment.titleHome");
  }
  if (countEl) countEl.textContent = total ? t("comment.count", { n: total }) : "";
  if (!list || !list.length) {
    listEl.innerHTML = '<div class="history-empty">' + t("comment.emptyList") + '</div>';
    return;
  }
  var me = currentUser ? currentUser.email : "";
  listEl.innerHTML = list.map(function (c) {
    var delBtn = (me && c.email === me)
      ? '<button type="button" class="c-del" data-id="' + escapeHtml(c.id) + '" title="' + t("comment.delTitle") + '">' + t("comment.delMine") + '</button>'
      : "";
    var likeBtn = '<button type="button" class="c-like' + (c.liked ? " liked" : "") +
      '" data-id="' + escapeHtml(c.id) + '" title="' + escapeHtml(t("comment.like")) + '">' +
      t("comment.like") + ' <span class="c-like-n">' + (c.likes || 0) + "</span></button>";
    var replyBtn = '<button type="button" class="c-reply-btn" data-id="' + escapeHtml(c.id) + '">' + t("comment.reply") + "</button>";
    var repliesHtml = (c.replies && c.replies.length)
      ? '<div class="c-replies">' + c.replies.map(function (r) {
          var rDel = (me && r.email === me)
            ? '<button type="button" class="c-reply-del" data-cid="' + escapeHtml(c.id) +
              '" data-rid="' + escapeHtml(r.id) + '" title="' + escapeHtml(t("comment.delTitle")) + '">' +
              t("comment.delMine") + "</button>"
            : "";
          return '<div class="c-reply" data-rid="' + escapeHtml(r.id) + '">' +
            '<div class="c-head"><span class="c-email">' + escapeHtml(maskEmail(r.email)) +
            '</span><span class="c-time">' + escapeHtml(fmtCommentTime(r.ts)) + "</span>" + rDel + "</div>" +
            '<div class="c-body">' + escapeHtml(r.content) +
            (r.image ? '<img class="c-img" src="' + escapeHtml(r.image) + '" alt="' + escapeHtml(t("comments.imageAlt")) + '">' : "") +
            "</div></div>";
        }).join("") + "</div>"
      : "";
    return '<div class="comment-item" data-id="' + escapeHtml(c.id) + '">' +
      '<div class="c-head"><span class="c-email">' + escapeHtml(maskEmail(c.email)) +
      '</span><span class="c-time">' + escapeHtml(fmtCommentTime(c.ts)) + "</span>" + delBtn + "</div>" +
      '<div class="c-body">' + escapeHtml(c.content) +
      (c.image ? '<img class="c-img" src="' + escapeHtml(c.image) + '" alt="' + escapeHtml(t("comments.imageAlt")) + '">' : "") +
      "</div>" +
      '<div class="c-actions">' + likeBtn + replyBtn + "</div>" +
      repliesHtml +
      "</div>";
  }).join("");
  listEl.querySelectorAll(".c-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.dataset.id;
      var msgEl = document.getElementById("commentMsg");
      if (!window.confirm(t("comment.delConfirm"))) return;  // 二次确认，避免误删
      btn.disabled = true;
      fetch("/api/comments?id=" + encodeURIComponent(id), {
        method: "DELETE", headers: authHeaders()
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && d.ok) {
            if (msgEl) { msgEl.textContent = t("comment.delOk"); msgEl.style.color = "var(--green)"; }
            setTimeout(function () { if (msgEl) msgEl.textContent = ""; }, 3000);
          } else if (msgEl) {
            msgEl.textContent = (d && d.error) ? localErrStr(d.error) : t("comment.delFail");
            msgEl.style.color = "var(--red)";
          }
          loadComments();
        })
        .catch(function () {
          if (msgEl) { msgEl.textContent = t("comment.delFail"); msgEl.style.color = "var(--red)"; }
          loadComments();
        });
    });
  });
  // 评论配图点击放大查看
  listEl.querySelectorAll(".c-img").forEach(function (img) {
    img.addEventListener("click", function () { openCommentLightbox(img.getAttribute("src")); });
  });
  // 删除回复（仅本人；二次确认）
  listEl.querySelectorAll(".c-reply-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var cid = btn.dataset.cid, rid = btn.dataset.rid;
      var msgEl = document.getElementById("commentMsg");
      if (!window.confirm(t("comment.delReplyConfirm"))) return;
      btn.disabled = true;
      fetch("/api/comments/" + encodeURIComponent(cid) + "/reply/" + encodeURIComponent(rid), {
        method: "DELETE", headers: authHeaders()
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && d.ok) {
            if (msgEl) { msgEl.textContent = t("comment.delOk"); msgEl.style.color = "var(--green)"; }
            setTimeout(function () { if (msgEl) msgEl.textContent = ""; }, 3000);
          } else if (msgEl) {
            msgEl.textContent = (d && d.error) ? localErrStr(d.error) : t("comment.delFail");
            msgEl.style.color = "var(--red)";
          }
          loadComments();
        })
        .catch(function () {
          if (msgEl) { msgEl.textContent = t("comment.delFail"); msgEl.style.color = "var(--red)"; }
          loadComments();
        });
    });
  });  // 点赞（按登录用户去重，可再次点击取消）
  listEl.querySelectorAll(".c-like").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!currentUser) { commentMsgShow(t("comment.loginRequired"), "var(--red)"); openAuth("login"); return; }
      var id = btn.dataset.id;
      fetch("/api/comments/" + encodeURIComponent(id) + "/like", { method: "POST", headers: authHeaders() })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && typeof d.likes === "number") {
            btn.querySelector(".c-like-n").textContent = d.likes;
            btn.classList.toggle("liked", !!d.liked);
          }
        }).catch(function () {});
    });
  });
  // 回复（一层嵌套；点击展开内联回复框，再次点击收起）
  listEl.querySelectorAll(".c-reply-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!currentUser) { commentMsgShow(t("comment.loginRequired"), "var(--red)"); openAuth("login"); return; }
      var item = btn.closest(".comment-item");
      var id = btn.dataset.id;
      var existing = item.querySelector(".c-reply-box");
      if (existing) { pendingReplyImage = null; existing.remove(); return; }
      pendingReplyImage = null;
      var box = document.createElement("div");
      box.className = "c-reply-box";
      box.innerHTML =
        '<textarea class="c-reply-input" rows="2" maxlength="500" placeholder="' + escapeHtml(t("comment.replyPlaceholder")) + '"></textarea>' +
        '<div class="comment-img-preview c-reply-img-preview hidden"></div>' +
        '<div class="composer-bar">' +
          '<button type="button" class="composer-icon-btn c-reply-img-btn" title="' + escapeHtml(t("comments.attachImage")) +
            '" aria-label="' + escapeHtml(t("comments.attachImage")) + '">' + COMMENT_ICON_SVG + '</button>' +
          '<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="c-reply-img-input" hidden>' +
          '<button type="button" class="comment-submit c-reply-submit" data-id="' + escapeHtml(id) + '">' +
            t("comment.replySubmit") + "</button>" +
        "</div>";
      item.appendChild(box);
      var ta = box.querySelector(".c-reply-input");
      ta.focus();
      // 回复配图：图标按钮 → 选图 → 压缩 → 预览
      var imgBtn = box.querySelector(".c-reply-img-btn");
      var imgInput = box.querySelector(".c-reply-img-input");
      if (imgBtn && imgInput) {
        imgBtn.addEventListener("click", function () { imgInput.click(); });
        imgInput.addEventListener("change", function () {
          var f = imgInput.files && imgInput.files[0];
          if (f) handleCommentImageFile(f, function (d) { pendingReplyImage = d; renderReplyImgPreview(box); });
          imgInput.value = "";
        });
      }
      box.querySelector(".c-reply-submit").addEventListener("click", function () {
        var txt = ta.value.trim();
        if (!txt && !pendingReplyImage) { commentMsgShow(t("comment.empty"), "var(--red)"); return; }
        if (pendingReplyImage && pendingReplyImage.length > COMMENT_IMG_MAX_BYTES) {
          commentMsgShow(t("comments.imgTooBig"), "var(--red)"); return;
        }
        fetch("/api/comments/" + encodeURIComponent(id) + "/reply", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify({ content: txt, image: pendingReplyImage || undefined }),
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (d) {
            if (d && d.replies) { pendingReplyImage = null; loadComments(); }
            else commentMsgShow(t("comment.fail"), "var(--red)");
          })
          .catch(function () { commentMsgShow(t("comment.fail"), "var(--red)"); });
      });
    });
  });
}

function submitComment() {
  var msgEl = document.getElementById("commentMsg");
  var txtEl = document.getElementById("commentText");
  if (!txtEl) return;
  if (!currentUser) {
    if (msgEl) {
      msgEl.textContent = t("comment.loginRequired");
      msgEl.style.color = "var(--red)";
    }
    openAuth("login");
    return;
  }
  var content = (txtEl.value || "").trim();
  if (!content && !pendingCommentImage) {
    if (msgEl) { msgEl.textContent = t("comment.empty"); msgEl.style.color = "var(--red)"; }
    return;
  }
  // 双保险：预览里的图若超限（理论上压缩后不会），提交前就拦下并说明是图片问题
  if (pendingCommentImage && pendingCommentImage.length > COMMENT_IMG_MAX_BYTES) {
    if (msgEl) { msgEl.textContent = t("comments.imgTooBig"); msgEl.style.color = "var(--red)"; }
    return;
  }
  var btn = document.getElementById("commentSubmit");
  if (btn) { btn.disabled = true; btn.textContent = t("comments.publishing"); }
  var hadImage = !!pendingCommentImage;
  var ctx = commentContext();
  fetch("/api/comments", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
    body: JSON.stringify({ content: content, train: ctx.key || undefined, image: pendingCommentImage || undefined })
  }).then(function (resp) { return resp.json().catch(function () { return {}; }); })
    .then(function (d) {
      if (d && d.comment) {
        txtEl.value = "";
        clearCommentImage();
        autoGrowCommentTextarea();
        if (msgEl) { msgEl.textContent = t("comment.success"); msgEl.style.color = "var(--green)"; }
        setTimeout(function () { if (msgEl) msgEl.textContent = ""; }, 3000);
        loadComments();
      } else {
        // 带图失败时把归因说清楚，别再只冒一个"发布失败"
        var base = (d && d.error) ? localErrStr(d.error) : t("comment.fail");
        if (hadImage && d && d.error && /图片|image/i.test(String(d.error))) {
          base = String(d.error) + " " + t("comments.imgTip");
        }
        if (msgEl) { msgEl.textContent = base; msgEl.style.color = "var(--red)"; }
      }
    })
    .catch(function (e) {
      var m = t("err.network", { msg: e.message });
      if (hadImage) m += " " + t("comments.imgTip");
      if (msgEl) { msgEl.textContent = m; msgEl.style.color = "var(--red)"; }
    })
    .finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = t("comments.submit"); }
    });
}

// 评论配图：待发送图片（data URL）与预览
var pendingCommentImage = null;
var pendingReplyImage = null; // 回复框当前待发送图片（同一时刻只有一个回复框打开）
var COMMENT_IMG_MAX_BYTES = 3 * 1024 * 1024; // 与服务端 COMMENT_IMG_MAX_BYTES 对齐
// 图片图标 SVG（与 index.html 主输入框内的一致），供动态生成的回复框复用
var COMMENT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false">' +
  '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
  '<circle cx="9" cy="9.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
  '<path d="M5 17.2l4.3-4.1a1.6 1.6 0 0 1 2.2 0l2.3 2.2 1.5-1.4a1.6 1.6 0 0 1 2.2 0L20 16.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

// 图片压缩：手机直出照片常 4~8MB，服务端上限 3MB，直接发必失败。
// 用 canvas 等比缩到最长边 <=1600，JPEG 质量 0.82，循环降质直到 <=3MB。
function compressCommentImage(file, cb) {
  var reader = new FileReader();
  reader.onerror = function () { cb(null, t("comments.imgReadFail")); };
  reader.onload = function () {
    var dataUrl = String(reader.result || "");
    // 原图已经够小就直接用，避免无谓重编码（GIF 动图也走这条路，重编码会丢动画）
    if (dataUrl.length <= COMMENT_IMG_MAX_BYTES && (file.type === "image/gif" || file.size <= 512 * 1024)) {
      return cb(dataUrl, null);
    }
    var img = new Image();
    img.onerror = function () { cb(null, t("comments.imgReadFail")); };
    img.onload = function () {
      var MAXEDGE = 1600;
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (!w || !h) return cb(null, t("comments.imgReadFail"));
      var scale = Math.min(1, MAXEDGE / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var cv = document.createElement("canvas");
      cv.width = cw; cv.height = ch;
      var ctx = cv.getContext("2d");
      // JPEG 无透明通道：先铺白底，否则 PNG 透明区会变黑
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      var quality = 0.82;
      var out = cv.toDataURL("image/jpeg", quality);
      while (out.length > COMMENT_IMG_MAX_BYTES && quality > 0.4) {
        quality -= 0.12;
        out = cv.toDataURL("image/jpeg", quality);
      }
      if (out.length <= COMMENT_IMG_MAX_BYTES) return cb(out, null);
      // 还是太大：把边长减半再压一轮
      cw = Math.max(1, Math.round(cw / 2));
      ch = Math.max(1, Math.round(ch / 2));
      cv.width = cw; cv.height = ch;
      var ctx2 = cv.getContext("2d");
      ctx2.fillStyle = "#fff";
      ctx2.fillRect(0, 0, cw, ch);
      ctx2.drawImage(img, 0, 0, cw, ch);
      out = cv.toDataURL("image/jpeg", 0.7);
      if (out.length <= COMMENT_IMG_MAX_BYTES) return cb(out, null);
      cb(null, t("comments.imgTooBig"));
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

function clearCommentImage() {
  pendingCommentImage = null;
  var inp = document.getElementById("commentImgInput");
  if (inp) inp.value = "";
  renderCommentImgPreview();
}
function renderCommentImgPreview() {
  var box = document.getElementById("commentImgPreview");
  if (!box) return;
  if (!pendingCommentImage) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.innerHTML =
    '<img src="' + escapeHtml(pendingCommentImage) + '" alt="preview">' +
    '<button type="button" class="img-remove">' + t("comments.removeImage") + "</button>";
  box.classList.remove("hidden");
  var rm = box.querySelector(".img-remove");
  if (rm) rm.addEventListener("click", clearCommentImage);
}
function commentMsgShow(text, color) {
  var el = document.getElementById("commentMsg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = color || "var(--red)";
  if (text) setTimeout(function () { if (el.textContent === text) el.textContent = ""; }, 3000);
}

// textarea 随内容长高（微信式：框体自适应，最多 200px 后内部滚动）
function autoGrowCommentTextarea() {
  var ta = document.getElementById("commentText");
  if (!ta || ta.offsetParent === null) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(200, ta.scrollHeight) + "px";
}

function initComments() {
  loadComments();
  var submit = document.getElementById("commentSubmit");
  if (submit) submit.addEventListener("click", submitComment);
  var txt = document.getElementById("commentText");
  if (txt) {
    txt.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitComment(); // Ctrl+Enter 发布
    });
    txt.addEventListener("input", autoGrowCommentTextarea);
    autoGrowCommentTextarea();
  }
  // 粘贴图片直接进预览（微信习惯）
  var box = document.querySelector(".comment-composer .composer-box") ||
            document.querySelector(".composer-box");
  if (txt && box) {
    txt.addEventListener("paste", function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          var f = items[i].getAsFile();
          if (!f) continue;
          e.preventDefault();
          handleCommentImageFile(f, function (d) { pendingCommentImage = d; renderCommentImgPreview(); });
          return;
        }
      }
    });
  }
  // 评论配图：选择图片 → 压缩 → 预览
  var imgBtn = document.getElementById("commentImgBtn");
  var imgInput = document.getElementById("commentImgInput");
  if (imgBtn && imgInput) {
    imgBtn.addEventListener("click", function () { imgInput.click(); });
    imgInput.addEventListener("change", function () {
      var f = imgInput.files && imgInput.files[0];
      if (f) handleCommentImageFile(f, function (d) { pendingCommentImage = d; renderCommentImgPreview(); });
      imgInput.value = "";
    });
  }
}

// 统一的图片入口：格式校验 → 压缩 → 回调（三语文案）。onReady(dataUrl) 由调用方决定存到哪
function handleCommentImageFile(f, onReady) {
  if (!f) return;
  if (!/^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(f.type || "")) {
    commentMsgShow(t("comments.imgUnsupported"), "var(--red)");
    return;
  }
  compressCommentImage(f, function (dataUrl, err) {
    if (!dataUrl) { commentMsgShow(err || t("comments.imgUnsupported"), "var(--red)"); return; }
    if (typeof onReady === "function") onReady(dataUrl);
  });
}

// 回复框图片预览（复用 .comment-img-preview 样式，渲染到当前回复框内的预览容器）
function renderReplyImgPreview(box) {
  var pv = box && box.querySelector(".c-reply-img-preview");
  if (!pv) return;
  if (!pendingReplyImage) { pv.classList.add("hidden"); pv.innerHTML = ""; return; }
  pv.innerHTML =
    '<img src="' + escapeHtml(pendingReplyImage) + '" alt="preview">' +
    '<button type="button" class="img-remove">' + t("comments.removeImage") + "</button>";
  pv.classList.remove("hidden");
  var rm = pv.querySelector(".img-remove");
  if (rm) rm.addEventListener("click", function () { pendingReplyImage = null; renderReplyImgPreview(box); });
}

// 语言切换时重渲染已显示内容（动态文案不走 data-i18n，需手动刷新）
_onLangChange = function () {
  // 预测结果
  if (currentData && predictEl && !predictEl.classList.contains("hidden")) {
    renderPredict(currentData);
  }
  // 晚点成分分析面板（zfCats/线路特征/本车次成分等动态文案需随语言刷新）
  var bdPanel = document.getElementById("breakdownPanel");
  if (bdPanel && !bdPanel.classList.contains("hidden") && window._lastBreakdownPayload) {
    renderBreakdown(window._lastBreakdownPayload);
  }
  // 线路班次结果
  if (serviceResults && !serviceResults.classList.contains("hidden") && lastSvcData) {
    renderServices(lastSvcData.line, lastSvcData.svc, lastSvcData.destination, lastSvcData.opts);
  }
  // 历史面板（若打开）
  var hp = document.getElementById("historyPanel");
  if (hp && !hp.classList.contains("hidden")) loadHistory();
  // 评论区（若已加载过）
  var cl = document.getElementById("commentList");
  if (cl && cl.querySelector && cl.querySelector(".comment-item")) loadComments();
};

document.addEventListener("keydown", function (e) {
  if (e.key === "Tab") {
    const modal = ["shareModal", "authModal"].map(function (id) {
      return document.getElementById(id);
    }).find(function (el) { return el && !el.classList.contains("hidden"); });
    if (modal) {
      const focusables = Array.from(modal.querySelectorAll("button, input, textarea, select, a[href]"))
        .filter(function (el) { return !el.disabled && !el.hidden; });
      if (focusables.length) {
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }
  if (e.key !== "Escape") return;
  const shareModal = document.getElementById("shareModal");
  if (shareModal && !shareModal.classList.contains("hidden")) {
    closeShareModal();
    return;
  }
  const bmcModal = document.getElementById("bmcModal");
  if (bmcModal && !bmcModal.classList.contains("hidden")) {
    closeBmcModal();
    return;
  }
  const authModal = document.getElementById("authModal");
  if (authModal && !authModal.classList.contains("hidden")) {
    closeAuth();
    return;
  }
  // 详情弹窗叠在历史面板之上：ESC 只关最上层的详情弹窗，不当作关闭整个历史面板
  const histDetail = document.getElementById("historyDetailModal");
  if (histDetail && !histDetail.classList.contains("hidden")) {
    closeHistoryDetail();
    return;
  }
  // 评论图片 lightbox 在最上层：ESC 只关它
  const cmtLb = document.getElementById("commentLightbox");
  if (cmtLb && !cmtLb.classList.contains("hidden")) {
    closeCommentLightbox();
    return;
  }
  const historyPanel = document.getElementById("historyPanel");
  if (historyPanel && !historyPanel.classList.contains("hidden")) closeHistory();
});

// initAuth() 已移至 auth.js 末尾（认证初始化属该模块职责，避免"改评论区把登录按钮搞坏"）
initComments();

// 访问人数统计：生成稳定 visitorId（localStorage 持久），首次访问上报后端去重计数
function trackVisitor() {
  try {
    var KEY = "td_visitor_id";
    var id = "";
    try { id = localStorage.getItem(KEY) || ""; } catch (e) {}
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "v" + Date.now() + Math.random().toString(16).slice(2);
      try { localStorage.setItem(KEY, id); } catch (e) {}
    }
    fetch("/api/visitors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var el = document.getElementById("visitorCount");
        if (el && d && typeof d.count === "number") {
          el.textContent = d.count.toLocaleString();
        }
      })
      .catch(function () {});
  } catch (e) {}
}
trackVisitor();
