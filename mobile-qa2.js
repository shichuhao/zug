const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;

const DEVICES = [
  { name: 'iPhone13',  vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  { name: 'iPhoneSE',  vw: 375, vh: 667, dpr: 2, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1' },
  { name: 'GalaxyS21', vw: 412, vh: 915, dpr: 3, ua: 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.77 Mobile Safari/537.36' },
];

async function checkScroll(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { sel: s, found: false };
    const canScroll = el.scrollWidth > el.clientWidth + 1;
    const before = el.scrollLeft;
    el.scrollLeft = 99999;
    const after = el.scrollLeft;
    el.scrollLeft = before;
    return { sel: s, found: true, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      canScroll, scrolledTo: after, visibleRatio: +(el.clientWidth / el.scrollWidth).toFixed(2) };
  }, sel);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: exe });
  const results = {};
  for (const dev of DEVICES) {
    const ctx = await browser.newContext({ viewport: { width: dev.vw, height: dev.vh }, deviceScaleFactor: dev.dpr, isMobile: true, hasTouch: true, userAgent: dev.ua });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#searchBtn', { timeout: 15000 });
    await page.fill('#trainInput', 'ICE 847');
    await page.click('#searchBtn');
    // DETERMINISTIC: wait until chartStations has non-zero display width
    let csInfo;
    try {
      await page.waitForFunction(() => { const c = document.querySelector('#chartStations'); const r = c && c.getBoundingClientRect(); return r && r.width > 10; }, undefined, { timeout: 20000 });
      csInfo = await page.evaluate(() => { const c = document.querySelector('#chartStations'); const r = c.getBoundingClientRect(); return { dispW: Math.round(r.width), dispH: Math.round(r.height), bitmapW: c.width, bitmapH: c.height, visible: r.width > 0 }; });
    } catch (e) { csInfo = { error: 'TIMEOUT waiting chartStations render', msg: e.message }; }
    const c10 = await page.evaluate(() => { const c = document.querySelector('#chart10d'); const r = c.getBoundingClientRect(); return { dispW: Math.round(r.width), dispH: Math.round(r.height), bitmapW: c.width, bitmapH: c.height }; });
    const wrapW = await page.evaluate(() => { const w = document.querySelector('.chart-fixed-wrap'); return w ? Math.round(w.getBoundingClientRect().width) : null; });
    const viewTabs = await checkScroll(page, '.view-tabs');
    const chartBox = await checkScroll(page, '.chart-box');
    const todayTable = await checkScroll(page, '#todayRows');
    // station count to explain targetW
    const stationCount = await page.evaluate(() => { const s = document.querySelector('#chartStations'); return s ? null : 0; }).catch(() => null);
    results[dev.name] = { csInfo, c10, wrapW, viewTabs, chartBox, todayTable };
    console.log(`[done] ${dev.name}`);
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(`${OUT}/qa-report2.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})();
