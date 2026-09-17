const { chromium } = require('playwright');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
fs.mkdirSync(OUT, { recursive: true });

const DEVICES = [
  { name: 'iPhone13',  vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  { name: 'iPhoneSE',  vw: 375, vh: 667, dpr: 2, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1' },
  { name: 'GalaxyS21', vw: 412, vh: 915, dpr: 3, ua: 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.77 Mobile Safari/537.36' },
];

const E = async (p, fn, arg) => { try { return await p.evaluate(fn, arg); } catch (e) { return { _err: e.message }; } };

async function overflow(page) {
  return E(page, () => {
    const iw = window.innerWidth;
    const docOverflow = document.documentElement.scrollWidth > iw + 1;
    const right = [];
    const innerH = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > iw + 1)
        right.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50), id: el.id, right: Math.round(r.right), bottom: Math.round(r.bottom) });
      if (el.scrollWidth > el.clientWidth + 1)
        innerH.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50), id: el.id, sw: el.scrollWidth, cw: el.clientWidth });
    }
    const map = {};
    for (const x of right) { const k = x.tag + '|' + x.cls + '|' + x.id; if (!map[k] || map[k].right < x.right) map[k] = x; }
    return {
      docOverflow, iw, docScrollW: document.documentElement.scrollWidth,
      rightCount: right.length,
      rightSamples: Object.values(map).sort((a, b) => b.right - a.right).slice(0, 20),
      innerHorizontal: innerH.slice(0, 20),
    };
  });
}

async function chartStretch(page, sel) {
  return E(page, (s) => {
    const c = document.querySelector(s);
    if (!c) return { sel: s, found: false };
    const bw = c.width, bh = c.height, r = c.getBoundingClientRect();
    const dw = r.width, dh = r.height, ba = bw / bh, da = dw / dh;
    return {
      sel: s, found: true, bitmapW: bw, bitmapH: bh, dispW: Math.round(dw), dispH: Math.round(dh),
      bitmapAspect: +ba.toFixed(3), dispAspect: +da.toFixed(3),
      stretchPct: +Math.abs(ba - da) * 100, stretched: Math.abs(ba - da) > 0.04,
      rightEdge: Math.round(r.right), bottomEdge: Math.round(r.bottom),
      parentWrap: c.parentElement ? (c.parentElement.className || '') : '',
    };
  }, sel);
}

async function currentModal(page) {
  return E(page, () => {
    const ms = [...document.querySelectorAll('.modal')];
    const m = ms.find(x => { const cs = getComputedStyle(x); return cs.display !== 'none' && !x.classList.contains('hidden') && cs.visibility !== 'hidden'; });
    if (!m) return { found: false };
    const cs = getComputedStyle(m), r = m.getBoundingClientRect();
    const iw = window.innerWidth, ih = window.innerHeight;
    return {
      found: true, id: m.id, cls: (m.className || '').toString().slice(0, 40),
      position: cs.position, left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height),
      iw, ih, overflowsViewport: r.right > iw + 1 || r.bottom > ih + 1 || r.left < -1 || r.top < -1,
      contentOverflowsVertical: m.scrollHeight > m.clientHeight + 1,
      scrollable: /auto|scroll/.test(cs.overflowY),
    };
  });
}

async function tapTargets(page, sels) {
  return E(page, (ss) => ss.map(s => {
    const e = document.querySelector(s);
    if (!e) return { sel: s, found: false };
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { sel: s, found: true, w: Math.round(r.width), h: Math.round(r.height), fontSize: cs.fontSize, visible: cs.display !== 'none' && r.width > 0 };
  }), sels);
}

(async () => {
  const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome'
    : (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const deviceReports = {};

  for (const dev of DEVICES) {
    const ctx = await browser.newContext({ viewport: { width: dev.vw, height: dev.vh }, deviceScaleFactor: dev.dpr, isMobile: true, hasTouch: true, userAgent: dev.ua });
    const page = await ctx.newPage();
    const errs = [], perr = [], freq = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => perr.push(String(e)));
    page.on('requestfailed', r => freq.push(r.url() + ' :: ' + (r.failure() && r.failure().errorText)));
    page.on('response', r => { if (r.status() >= 400) freq.push(r.status() + ' ' + r.url()); });

    const rep = { device: dev.name, vw: dev.vw, vh: dev.vh, dpr: dev.dpr };

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#searchBtn', { timeout: 15000 });
      await page.waitForTimeout(1500);
    } catch (e) { rep.loadError = e.message; }

    rep.home = {
      overflow: await overflow(page),
      tap: await tapTargets(page, ['#trainInput', '#searchBtn', '#loginBtn', '#viewTabTrain', '#viewTabRoute', '#viewTabJourney', '#themeToggle', '.lang-btn']),
      langActive: await E(page, () => [...document.querySelectorAll('.lang-btn')].map(b => ({ lang: b.dataset.lang, active: b.classList.contains('active') }))),
      bodyFont: await E(page, () => getComputedStyle(document.body).fontSize),
    };
    await page.screenshot({ path: `${OUT}/${dev.name}-01-home.png` }).catch(() => {});

    try {
      await page.fill('#trainInput', 'ICE 847');
      await page.click('#searchBtn');
      await page.waitForFunction(() => { const c = document.querySelector('#chart10d'); return c && c.width > 0; }, undefined, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(3500);
    } catch (e) { rep.queryError = e.message; }

    rep.result = {
      overflow: await overflow(page),
      chart10d: await chartStretch(page, '#chart10d'),
      chartStations: await chartStretch(page, '#chartStations'),
      wrapW: await E(page, () => { const w = document.querySelector('.chart-fixed-wrap'); return w ? Math.round(w.getBoundingClientRect().width) : null; }),
      cards: await E(page, () => { const g = document.querySelector('#predictionCards'); return g ? { count: g.children.length, font: getComputedStyle(g.querySelector('.mcard-value') || g).fontSize } : null; }),
    };
    await page.screenshot({ path: `${OUT}/${dev.name}-02-result.png` }).catch(() => {});

    try {
      await page.click('#metricStationBtn').catch(() => {});
      await page.waitForTimeout(700);
      await page.click('#metricSegmentBtn').catch(() => {});
      await page.waitForTimeout(700);
    } catch (e) {}
    rep.metricToggle = { overflow: await overflow(page) };
    await page.screenshot({ path: `${OUT}/${dev.name}-03-metric.png` }).catch(() => {});

    try { await page.click('.lang-btn[data-lang="de"]'); await page.waitForTimeout(1200); } catch (e) { rep.langError = e.message; }
    rep.langDE = {
      overflow: await overflow(page),
      langActive: await E(page, () => [...document.querySelectorAll('.lang-btn')].map(b => ({ lang: b.dataset.lang, active: b.classList.contains('active') }))),
    };
    await page.screenshot({ path: `${OUT}/${dev.name}-04-lang-de.png` }).catch(() => {});
    await page.click('.lang-btn[data-lang="zh"]').catch(() => {});
    await page.waitForTimeout(600);

    try { await page.click('#shareImgQuickBtn'); await page.waitForTimeout(3000); } catch (e) { rep.shareImgError = e.message; }
    rep.shareImg = {
      tip: await E(page, () => { const t = document.querySelector('#shareTip'); return t ? { hidden: t.classList.contains('hidden'), hasLink: !!t.querySelector('a[download]') } : null; }),
      newCanvas: await E(page, () => [...document.querySelectorAll('canvas')].filter(c => !['chart10d', 'chartStations'].includes(c.id)).map(c => ({ id: c.id, w: c.width, h: c.height, dispW: Math.round(c.getBoundingClientRect().width), dispH: Math.round(c.getBoundingClientRect().height) }))),
    };
    await page.screenshot({ path: `${OUT}/${dev.name}-05-share-img.png` }).catch(() => {});

    try { await page.click('#shareBtn'); await page.waitForTimeout(1000); } catch (e) {}
    rep.shareModal = await currentModal(page);
    await page.screenshot({ path: `${OUT}/${dev.name}-06-share-modal.png` }).catch(() => {});
    await page.click('#shareModalClose').catch(() => {});
    await page.waitForTimeout(400);

    try { await page.click('#loginBtn'); await page.waitForTimeout(1000); } catch (e) { rep.authError = e.message; }
    rep.authModal = await currentModal(page);
    rep.authInputs = await tapTargets(page, ['#authEmail', '#authPassword', '#authSubmit']);
    try {
      await page.focus('#authEmail');
      const before = await E(page, () => ({ sy: window.scrollY, iw: window.innerWidth }));
      await page.waitForTimeout(300);
      const after = await E(page, () => ({ sy: window.scrollY, iw: window.innerWidth }));
      rep.authFocusJump = { before, after, iwChanged: before.iw !== after.iw, scrolled: Math.abs(before.sy - after.sy) > 2 };
    } catch (e) {}
    await page.screenshot({ path: `${OUT}/${dev.name}-07-auth-modal.png` }).catch(() => {});
    await page.click('#authClose').catch(() => {});
    await page.waitForTimeout(400);

    try { await page.click('#viewTabRoute'); await page.waitForTimeout(800); } catch (e) {}
    rep.routeTab = { overflow: await overflow(page) };
    try {
      await page.fill('#fromInput', 'München Hbf'); await page.waitForTimeout(500);
      await page.fill('#toInput', 'Augsburg Hbf'); await page.waitForTimeout(500);
    } catch (e) {}
    await page.screenshot({ path: `${OUT}/${dev.name}-08-route.png` }).catch(() => {});

    rep.consoleErrors = errs;
    rep.pageErrors = perr;
    rep.failedRequests = freq;
    deviceReports[dev.name] = rep;
    await ctx.close();
    console.log(`[done] ${dev.name}`);
  }

  await browser.close();
  fs.writeFileSync(`${OUT}/qa-report.json`, JSON.stringify(deviceReports, null, 2));
  console.log(`\n=== QA complete. Reports in ${OUT} ===`);
  for (const [name, r] of Object.entries(deviceReports)) {
    const ov = r.home?.overflow?.docOverflow || r.result?.overflow?.docOverflow;
    console.log(`\n### ${name} (${r.vw}x${r.vh} dpr${r.dpr})`);
    console.log(`  consoleErrors=${r.consoleErrors.length} pageErrors=${r.pageErrors.length} failedReq=${r.failedRequests.length}`);
    console.log(`  homeDocOverflow=${r.home?.overflow?.docOverflow} resultDocOverflow=${r.result?.overflow?.docOverflow}`);
    if (r.result?.chartStations) console.log(`  chartStations stretched=${r.result.chartStations.stretched} (${r.result.chartStations.stretchPct}%) bitmapA=${r.result.chartStations.bitmapAspect} dispA=${r.result.chartStations.dispAspect}`);
    if (r.result?.chart10d) console.log(`  chart10d stretched=${r.result.chart10d.stretched} (${r.result.chart10d.stretchPct}%)`);
    if (r.shareModal) console.log(`  shareModal overflowsViewport=${r.shareModal.overflowsViewport} bottom=${r.shareModal.bottom}/${r.shareModal.ih}`);
    if (r.authModal) console.log(`  authModal overflowsViewport=${r.authModal.overflowsViewport} bottom=${r.authModal.bottom}/${r.authModal.ih} contentOverflow=${r.authModal.contentOverflowsVertical}`);
    if (r.authFocusJump) console.log(`  authFocusJump iwChanged=${r.authFocusJump.iwChanged} scrolled=${r.authFocusJump.scrolled}`);
  }
})();
