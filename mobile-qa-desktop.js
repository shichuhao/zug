const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const DEV = [
  { name: 'Desktop1280', vw: 1280, vh: 800, dpr: 1, ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
  { name: 'Tablet768', vw: 768, vh: 1024, dpr: 2, ua: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
];
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: exe });
  const res = {};
  for (const d of DEV) {
    const ctx = await browser.newContext({ viewport: { width: d.vw, height: d.vh }, deviceScaleFactor: d.dpr, userAgent: d.ua });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#searchBtn');
    await page.fill('#trainInput', 'ICE 847');
    await page.click('#searchBtn');
    await page.waitForFunction(() => { const c = document.querySelector('#chartStations'); const r = c && c.getBoundingClientRect(); return r && r.width > 10; }, undefined, { timeout: 20000 }).catch(() => {});
    const cs = await page.evaluate(() => { const c = document.querySelector('#chartStations'); const r = c.getBoundingClientRect(); return { dispW: Math.round(r.width), dispH: Math.round(r.height), visible: r.width > 0 }; });
    const wrap = await page.evaluate(() => { const w = document.querySelector('.chart-fixed-wrap'); return w ? Math.round(w.getBoundingClientRect().width) : null; });
    const boxScroll = await page.evaluate(() => { const cs = [...document.querySelectorAll('.chart-box')]; const b = cs[cs.length - 1]; return b ? { sw: b.scrollWidth, cw: b.clientWidth, scrollable: b.scrollWidth > b.clientWidth + 1 } : null; });
    const vt = await page.evaluate(() => { const e = document.querySelector('.view-tabs'); return { sw: e.scrollWidth, cw: e.clientWidth, scrollable: e.scrollWidth > e.clientWidth + 1 }; });
    res[d.name] = { chartStations: cs, wrap, chartBox: boxScroll, viewTabs: vt, consoleErrors: errs.length };
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync('/workspace/mobile-report/qa-desktop.json', JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})();
