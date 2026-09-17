const pw = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
fs.mkdirSync(OUT, { recursive: true });

const MOBILE = { vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };

const E = async (p, fn, arg) => { try { return await p.evaluate(fn, arg); } catch (e) { return { _err: e.message }; } };

async function measure(page) {
  const home = {
    overflow: await E(page, () => {
      const iw = window.innerWidth;
      const bad = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > iw + 1 && getComputedStyle(el).overflowX !== 'auto' && getComputedStyle(el.parentElement || el).overflowX !== 'auto')
          bad.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: (el.className || '').toString().slice(0, 40), right: Math.round(r.right) });
      }
      return { iw, docScrollW: document.documentElement.scrollWidth, docOverflow: document.documentElement.scrollWidth > iw + 1, hardClip: bad.slice(0, 8) };
    }),
    langBtns: await E(page, () => [...document.querySelectorAll('.lang-btn')].length),
    themeBefore: await E(page, () => document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme') || ''),
  };
  return home;
}

async function testEngine(engineName, browserType, opts) {
  const rep = { engine: engineName, steps: {}, errors: [] };
  let browser;
  try {
    browser = await browserType.launch(opts.launch);
  } catch (e) {
    rep.errors.push('LAUNCH FAIL: ' + e.message.split('\n')[0]);
    return rep;
  }
  const ctx = await browser.newContext({ viewport: { width: MOBILE.vw, height: MOBILE.vh }, deviceScaleFactor: MOBILE.dpr, isMobile: MOBILE.isMobile, hasTouch: true, userAgent: MOBILE.ua });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') rep.errors.push('console: ' + m.text().slice(0, 120)); });
  page.on('pageerror', e => rep.errors.push('pageerror: ' + String(e).slice(0, 120)));

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('#searchBtn', { timeout: 20000 });
    await page.waitForTimeout(1200);
    rep.steps.home = await measure(page);

    // --- 1. 搜索单车次 ---
    await page.fill('#trainInput', 'ICE 847');
    await page.click('#searchBtn');
    await page.waitForFunction(() => { const c = document.querySelector('#chart10d'); return c && c.width > 0; }, undefined, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    rep.steps.search = {
      chart10d: await E(page, () => { const c = document.querySelector('#chart10d'); const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bitmapW: c.width }; }),
      chartStations: await E(page, () => { const c = document.querySelector('#chartStations'); const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bitmapW: c.width }; }),
      predCards: await E(page, () => { const g = document.querySelector('#predictionCards'); return g ? g.children.length : 0; }),
      pointText: await E(page, () => (document.querySelector('#pPoint') || {}).textContent || ''),
      overflow: await E(page, () => ({ doc: document.documentElement.scrollWidth, iw: window.innerWidth })),
    };
    await page.screenshot({ path: `${OUT}/${engineName}-cross-01-result.png` }).catch(() => {});

    // --- 2. 指标切换 ---
    await page.click('#metricStationBtn').catch(() => {});
    await page.waitForTimeout(600);
    await page.click('#metricMaxBtn').catch(() => {});
    await page.waitForTimeout(600);
    rep.steps.metric = await E(page, () => ({ active: [...document.querySelectorAll('.toggle-btn')].filter(b => b.classList.contains('active')).map(b => b.dataset.metric) }));

    // --- 3. 语言切换（含 bind/collation 兼容） ---
    await page.click('.lang-btn[data-lang="de"]').catch(() => {});
    await page.waitForTimeout(1000);
    const deTitle = await E(page, () => (document.querySelector('#searchBtn') || {}).textContent || '');
    await page.click('.lang-btn[data-lang="en"]').catch(() => {});
    await page.waitForTimeout(800);
    const enTitle = await E(page, () => (document.querySelector('#searchBtn') || {}).textContent || '');
    await page.click('.lang-btn[data-lang="zh"]').catch(() => {});
    await page.waitForTimeout(600);
    rep.steps.lang = {
      de: deTitle, en: enTitle,
      deOK: deTitle && deTitle !== '查询',
      activeZh: await E(page, () => [...document.querySelectorAll('.lang-btn')].map(b => ({ l: b.dataset.lang, a: b.classList.contains('active') }))),
    };

    // --- 4. 主题切换 ---
    const tb = await E(page, () => document.documentElement.getAttribute('data-theme'));
    await page.click('#themeToggle').catch(() => {});
    await page.waitForTimeout(600);
    const ta = await E(page, () => document.documentElement.getAttribute('data-theme'));
    rep.steps.theme = { before: tb, after: ta, changed: tb !== ta };

    // --- 5. 分享弹窗 ---
    await page.click('#shareBtn').catch(() => {});
    await page.waitForTimeout(800);
    rep.steps.shareModal = await E(page, () => { const m = document.querySelector('#shareModal'); if (!m) return { found: false }; const r = m.getBoundingClientRect(); return { found: true, hidden: m.classList.contains('hidden'), display: getComputedStyle(m).display, w: Math.round(r.width), h: Math.round(r.height), overflows: r.bottom > window.innerHeight + 1 }; });
    await page.screenshot({ path: `${OUT}/${engineName}-cross-02-share.png` }).catch(() => {});
    await page.click('#shareModalClose').catch(() => {});
    await page.waitForTimeout(400);

    // --- 6. 登录弹窗 ---
    await page.click('#loginBtn').catch(() => {});
    await page.waitForTimeout(800);
    rep.steps.authModal = await E(page, () => { const m = document.querySelector('#authModal'); if (!m) return { found: false }; const r = m.getBoundingClientRect(); return { found: true, hidden: m.classList.contains('hidden'), w: Math.round(r.width), h: Math.round(r.height), overflows: r.bottom > window.innerHeight + 1 }; });
    await page.screenshot({ path: `${OUT}/${engineName}-cross-03-auth.png` }).catch(() => {});
    await page.click('#authClose').catch(() => {});
    await page.waitForTimeout(400);

    // --- 7. 站对站 tab ---
    await page.click('#viewTabRoute').catch(() => {});
    await page.waitForTimeout(700);
    rep.steps.routeTab = await E(page, () => { const t = document.querySelector('#viewTabRoute'); const p = document.querySelector('#viewRoute'); return { tabActive: t && t.classList.contains('active'), pageHidden: p && p.classList.contains('hidden'), overflow: document.documentElement.scrollWidth, iw: window.innerWidth }; });

    // --- 8. 行程 tab ---
    await page.click('#viewTabJourney').catch(() => {});
    await page.waitForTimeout(700);
    rep.steps.journeyTab = await E(page, () => { const p = document.querySelector('#viewJourney'); return { hidden: p && p.classList.contains('hidden'), hasInput: !!document.querySelector('#journeyUrlInput') }; });
    await page.screenshot({ path: `${OUT}/${engineName}-cross-04-journey.png` }).catch(() => {});

    // --- 9. 关键 Web API 兼容性探测 ---
    rep.steps.apiSupport = await E(page, () => ({
      ResizeObserver: typeof ResizeObserver !== 'undefined',
      IntersectionObserver: typeof IntersectionObserver !== 'undefined',
      canvasToBlob: !!HTMLCanvasElement.prototype.toBlob,
      navigatorShare: typeof navigator.share === 'function',
      navigatorCanShare: typeof navigator.canShare === 'function',
      clipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
      IntlCollator: (() => { try { return new Intl.Collator('de').compare('ä', 'z'); } catch (e) { return 'ERR'; } })(),
      IntersectionObserverRootMargin: typeof IntersectionObserver !== 'undefined',
      CSSsupports_gap: CSS.supports('gap', '1px'),
      CSSsupports_sticky: CSS.supports('position', 'sticky'),
    }));
  } catch (e) {
    rep.errors.push('RUN ERROR: ' + e.message.split('\n')[0]);
  }
  await ctx.close();
  await browser.close();
  return rep;
}

(async () => {
  const out = {};
  const engines = [
    ['chromium', pw.chromium, { launch: { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined } }],
    ['firefox', pw.firefox, { launch: { args: [] } }],
    ['webkit', pw.webkit, { launch: { args: [] } }],
  ];
  for (const [name, bt, opts] of engines) {
    process.stdout.write(`\n>>> Testing ${name} ...\n`);
    out[name] = await testEngine(name, bt, opts);
    console.log(`[${name}] errors=${out[name].errors.length}`);
  }
  await pw.chromium.launch({ args: ['--no-sandbox'] }).then(b => b.close()).catch(() => {});
  fs.writeFileSync(`${OUT}/cross-engine-report.json`, JSON.stringify(out, null, 2));
  console.log('\n=== CROSS-ENGINE COMPLETE ===');
  for (const [n, r] of Object.entries(out)) {
    console.log(`\n### ${n} — errors=${r.errors.length}`);
    if (r.errors.length) r.errors.slice(0, 8).forEach(e => console.log('   !', e));
  }
})();
