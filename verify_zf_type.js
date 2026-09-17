// verify_zf_type.js —— 端到端验证车型感知的原因图表（真实用户路径）
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  // 抓取 breakdown 响应，验证车型上下文
  let bdResp = null;
  page.on("response", async (r) => {
    if (r.url().includes("/api/breakdown")) {
      try { bdResp = await r.json(); } catch (e) { /* ignore */ }
    }
  });

  const train = "RE 49127";
  await page.goto("http://localhost:3000/?train=" + encodeURIComponent(train), {
    waitUntil: "domcontentloaded", timeout: 60000,
  });
  // 等待预测与懒加载的 breakdown
  await page.waitForTimeout(25000);

  const info = await page.evaluate(() => {
    const box = document.querySelector(".zf-cats, [data-zf-cats], .zf-box");
    const toggles = document.querySelectorAll(".zf-tbtn");
    const rows = document.querySelectorAll(".zf-row");
    const ratios = document.querySelectorAll(".zf-ratio");
    return {
      boxFound: !!box,
      nToggles: toggles.length,
      nRows: rows.length,
      nRatios: ratios.length,
      top3: Array.from(rows).slice(0, 3).map((r) => (r.textContent || "").trim().slice(0, 60)),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  });

  const meta = bdResp && bdResp.zf_meta ? bdResp.zf_meta : null;
  const cats = (bdResp && bdResp.zf_cats) || [];

  console.log(JSON.stringify({
    train,
    // 后端车型上下文
    zf_train_type: meta ? meta.train_type : null,
    zf_type_source: meta ? meta.type_source : null,
    zf_type_base: meta ? meta.type_base : null,
    nCats: cats.length,
    catRatios: cats.slice(0, 5).map((c) => ({
      key: c.key, impact_ratio: c.impact_ratio,
      type_impact_ratio: c.type_impact_ratio,
    })),
    // 前端渲染
    ui: info,
    errs,
  }, null, 1));

  await browser.close();
})();
