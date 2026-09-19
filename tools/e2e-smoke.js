#!/usr/bin/env node
// 前端端到端冒烟（2026-09-18，QA ENG-11 拆分回归用）
//
// 背景：app.js 被拆成 app.js / auth.js / comments.js 三个文件，靠 HTML 里的
// 加载顺序维持全局作用域约定。这种「隐式契约」最容易在后续改动里被悄悄打破
// （例如误删某个 <script>、或把 defer 顺序调换），而 node --check 只查语法，
// 查不出「函数根本没加载」。这个脚本就是那份回归网。
//
// 用法：
//   1) 另开一个终端起服务：node server.js
//   2) NODE_PATH=<含 playwright 的 node_modules> node tools/e2e-smoke.js
//   环境变量：
//     E2E_BASE   被测站点，默认 http://127.0.0.1:3000
//     E2E_HEADFUL=1  显示浏览器窗口（调试用）
//
// 检查项：控制台/页面错误、跨文件符号是否真的可用、登录弹窗、评论区、
//         图表键盘可达性、主题切换、PWA manifest。
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3000";

(async () => {
  const results = [];
  const ok = (name, pass, detail) => {
    results.push({ name, pass: !!pass, detail: detail === undefined ? "" : String(detail) });
  };

  const browser = await chromium.launch({ headless: !process.env.E2E_HEADFUL });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  // 1) 首页可达
  let resp = null;
  try {
    resp = await page.goto(BASE, { waitUntil: "load", timeout: 30000 });
  } catch (e) {
    console.log("FATAL: 无法打开 " + BASE + " —— " + e.message);
    await browser.close();
    process.exit(2);
  }
  ok("首页 HTTP 200", resp && resp.status() === 200, resp && resp.status());

  // 2) 拆分后的三个文件都真的加载了（跨文件符号可见）
  const syms = await page.evaluate(() => ({
    // i18n.js
    t: typeof window.t,
    // app.js
    fetchJSON: typeof fetchJSON,
    authHeaders: typeof authHeaders,
    // auth.js
    updateAuthUI: typeof updateAuthUI,
    initAuth: typeof initAuth,
    // comments.js
    initComments: typeof initComments,
    renderComments: typeof renderComments,
    // 顶层启动点是否执行过（currentUser 由 auth.js 初始化为 null）
    currentUserDefined: typeof currentUser !== "undefined",
  }));
  ok("i18n.js 已加载 (t)", syms.t === "function", syms.t);
  ok("app.js 已加载 (fetchJSON)", syms.fetchJSON === "function", syms.fetchJSON);
  ok("auth.js 已加载 (initAuth/updateAuthUI)",
    syms.initAuth === "function" && syms.updateAuthUI === "function",
    syms.initAuth + "/" + syms.updateAuthUI);
  ok("comments.js 已加载 (initComments)",
    syms.initComments === "function" && syms.renderComments === "function",
    syms.initComments + "/" + syms.renderComments);
  ok("auth.js 顶层已执行 (currentUser)", syms.currentUserDefined, syms.currentUserDefined);

  // 3) 登录弹窗可打开（auth.js 的事件绑定生效）
  await page.click("#loginBtn");
  await page.waitForTimeout(200);
  const modalOpen = await page.evaluate(() => {
    const m = document.getElementById("authModal");
    return !!m && !m.classList.contains("hidden");
  });
  ok("点击登录按钮弹出对话框", modalOpen, modalOpen);
  if (modalOpen) {
    // 表单提交校验：弱密码应被前端拦下（本轮的 SEC-02）
    await page.fill("#authEmail", "smoke@test.local");
    await page.fill("#authPassword", "123");
    const tabReg = await page.evaluate(() => {
      const b = document.getElementById("tabRegister");
      if (b) { b.click(); return true; }
      return false;
    });
    if (tabReg) {
      // 切到注册 tab 后应显示图形验证码，并从 /api/captcha 拿到内联 SVG（SEC-01）
      await page.waitForTimeout(600);
      const cap = await page.evaluate(() => {
        const row = document.getElementById("authCaptchaRow");
        const img = document.getElementById("authCaptchaImg");
        return {
          visible: !!row && !row.classList.contains("hidden"),
          src: img ? String(img.getAttribute("src") || "").slice(0, 24) : "",
        };
      });
      ok("注册 tab 显示图形验证码", cap.visible && cap.src.indexOf("data:image/svg") === 0,
        JSON.stringify(cap));

      // 弱密码应被前端拦下（服务端还有一层硬校验）
      await page.fill("#authPassword", "123");
      await page.click("#authSubmit").catch(() => {});
      await page.waitForTimeout(300);
      const msg = await page.textContent("#authMsg").catch(() => "");
      ok("注册弱密码被前端拦截", /8|字母|数字|位/.test(msg || ""), (msg || "").trim().slice(0, 60));
    }
    await page.click("#authClose").catch(() => {});
    await page.waitForTimeout(150);
  }

  // 4) 图表 canvas 键盘可达（ENG-13）
  const canvasA11y = await page.evaluate(() => {
    const c = document.getElementById("chartStations");
    if (!c) return { found: false };
    return { found: true, tabindex: c.getAttribute("tabindex"), role: c.getAttribute("role") };
  });
  ok("逐站图表 canvas 有 tabindex/role",
    canvasA11y.found && canvasA11y.tabindex === "0" && canvasA11y.role === "img",
    JSON.stringify(canvasA11y));

  // 5) 主题切换 + 过渡（ENG-14）
  const themeBefore = await page.getAttribute("html", "data-theme");
  await page.click("#themeToggle");
  await page.waitForTimeout(300);
  const themeAfter = await page.getAttribute("html", "data-theme");
  ok("主题可切换", themeBefore && themeAfter && themeBefore !== themeAfter, themeBefore + " → " + themeAfter);
  const hasTransition = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return s.transitionProperty || s.transition;
  });
  ok("body 存在颜色过渡", /background-color|color/.test(hasTransition || ""), (hasTransition || "").slice(0, 80));

  // 6) PWA manifest + 图标（ENG-12）
  const mresp = await page.request.get(BASE + "/manifest.json");
  ok("manifest.json 可访问", mresp.status() === 200, mresp.status());
  const iresp = await page.request.get(BASE + "/icon-192.png");
  ok("icon-192.png 可访问", iresp.status() === 200, iresp.status());
  const manifestLink = await page.evaluate(() => {
    const l = document.querySelector('link[rel="manifest"]');
    return !!l;
  });
  ok("页面声明 manifest", manifestLink);

  // 7) 控制台错误（拆分后最典型的失败形式就是 ReferenceError）
  ok("无控制台/页面错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();

  // 输出
  let failed = 0;
  console.log("\n== E2E 冒烟结果 (" + BASE + ") ==");
  for (const r of results) {
    if (!r.pass) failed++;
    console.log((r.pass ? "PASS  " : "FAIL  ") + r.name + (r.detail ? "  → " + r.detail : ""));
  }
  console.log("\n合计: " + (results.length - failed) + "/" + results.length + " 通过");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("E2E 异常:", e);
  process.exit(3);
});
