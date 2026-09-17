const pw = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
const M = { vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };
const E = (p, fn, a) => p.evaluate(fn, a).catch(e => ({ _err: e.message }));

async function run(name, bt, opts) {
  const rep = { engine: name, checks: {}, errors: [] };
  let browser;
  try { browser = await bt.launch(opts); } catch (e) { rep.errors.push('LAUNCH: ' + e.message.split('\n')[0]); return rep; }
  const ctx = await browser.newContext({ viewport: { width: M.vw, height: M.vh }, deviceScaleFactor: M.dpr, isMobile: true, hasTouch: true, userAgent: M.ua });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') rep.errors.push('console: ' + m.text().slice(0, 120)); });
  page.on('pageerror', e => rep.errors.push('pageerror: ' + String(e).slice(0, 120)));
  const C = rep.checks;
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('#searchBtn', { timeout: 20000 });
    C.loadOK = true;

    // 1. 搜索
    await page.fill('#trainInput', 'ICE 847');
    await page.click('#searchBtn');
    await page.waitForFunction(() => { const c = document.querySelector('#chart10d'); return c && c.width > 0; }, undefined, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    C.search = await E(page, () => ({ point: (document.querySelector('#pPoint') || {}).textContent, cards: document.querySelector('#predictionCards').children.length, stationW: Math.round(document.querySelector('#chartStations').getBoundingClientRect().width), noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 }));

    // 2. 指标切换
    await page.click('[data-metric="max"]'); await page.waitForTimeout(700);
    C.metricMax = await E(page, () => [...document.querySelectorAll('.toggle-btn.active')].map(b => b.dataset.metric));
    await page.click('[data-metric="station"]'); await page.waitForTimeout(700);
    C.metricStation = await E(page, () => ({ active: [...document.querySelectorAll('.toggle-btn.active')].map(b => b.dataset.metric), stationSelect: !document.querySelector('#stationSelect').classList.contains('hidden') }));

    // 3. 语言
    await page.click('.lang-btn[data-lang="de"]'); await page.waitForTimeout(900);
    C.langDE = await E(page, () => (document.querySelector('#searchBtn') || {}).textContent);
    await page.click('.lang-btn[data-lang="zh"]'); await page.waitForTimeout(600);

    // 4. 主题 + 图表重绘
    const before = await E(page, () => getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim());
    await page.click('#themeToggle'); await page.waitForTimeout(1600);
    const after = await E(page, () => getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim());
    C.theme = { before, after, changed: before !== after };
    await page.click('#themeToggle'); await page.waitForTimeout(900);

    // 5. Lightbox
    await page.evaluate(() => document.querySelector('#chartStations').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(700);
    const b1 = await (await page.$('#chartStations')).boundingBox();
    if (b1) await page.mouse.click(b1.x + b1.width * 0.5, b1.y + b1.height * 0.5);
    await page.waitForTimeout(1200);
    const opened = await E(page, () => !!document.querySelector('.chart-lightbox'));
    if (opened) { await page.keyboard.press('Escape'); await page.waitForTimeout(700); }
    C.lightbox = { opened, escClosed: opened ? await E(page, () => !document.querySelector('.chart-lightbox')) : null };

    // 6. 分享图生成
    await page.click('#shareImgQuickBtn'); await page.waitForTimeout(3200);
    C.shareImage = await E(page, () => { const t = document.querySelector('#shareTip'); return { tipVisible: t && !t.classList.contains('hidden'), hasDownloadLink: t ? !!t.querySelector('a[download]') : false }; });

    // 7. 分享弹窗 + 复制
    await page.click('#shareBtn'); await page.waitForTimeout(700);
    C.shareModal = await E(page, () => { const m = document.querySelector('#shareModal'); const r = m.getBoundingClientRect(); return { ok: !m.classList.contains('hidden'), noOverflow: r.bottom <= window.innerHeight + 1 }; });
    await page.click('#shareCopyBtn').catch(() => {}); await page.waitForTimeout(900);
    C.copyTip = await E(page, () => { const t = document.querySelector('#shareTip'); return t && !t.classList.contains('hidden'); });
    await page.click('#shareModalClose'); await page.waitForTimeout(500);

    // 8. 登录弹窗
    await page.click('#loginBtn'); await page.waitForTimeout(800);
    C.authModal = await E(page, () => { const m = document.querySelector('#authModal'); const r = m.getBoundingClientRect(); return { ok: !m.classList.contains('hidden'), noOverflow: r.bottom <= window.innerHeight + 1 }; });
    await page.click('#authClose'); await page.waitForTimeout(500);

    // 9. Tab 切换
    await page.click('#viewTabRoute'); await page.waitForTimeout(700);
    C.routeTab = await E(page, () => ({ active: document.querySelector('#viewTabRoute').classList.contains('active'), noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 }));
    await page.click('#viewTabJourney'); await page.waitForTimeout(700);
    C.journeyTab = await E(page, () => ({ hasInput: !!document.querySelector('#journeyUrlInput'), hidden: document.querySelector('#viewJourney').classList.contains('hidden') }));

    // 10. API
    C.api = await E(page, () => ({ RO: typeof ResizeObserver !== 'undefined', toBlob: !!HTMLCanvasElement.prototype.toBlob, Offscreen: typeof OffscreenCanvas !== 'undefined', IntlNum: (() => { try { return (1234.5).toLocaleString('de-DE'); } catch (e) { return 'ERR'; } })() }));
  } catch (e) { rep.errors.push('RUN: ' + e.message.split('\n')[0]); }
  await ctx.close(); await browser.close();
  return rep;
}

(async () => {
  const out = {};
  for (const [n, bt, o] of [
    ['chromium', pw.chromium, { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined }],
    ['firefox', pw.firefox, {}],
    ['webkit', pw.webkit, {}],
  ]) { process.stdout.write(`>>> ${n} ... `); out[n] = await run(n, bt, o); console.log(`errors=${out[n].errors.length}`); }
  fs.writeFileSync(`${OUT}/cross-engine-final.json`, JSON.stringify(out, null, 2));
  // 一致性对比
  const keys = ['search', 'metricMax', 'metricStation', 'langDE', 'theme', 'lightbox', 'shareImage', 'shareModal', 'copyTip', 'authModal', 'routeTab', 'journeyTab', 'api'];
  console.log('\n=== 跨内核一致性矩阵 ===');
  console.log('check'.padEnd(16) + '| ' + ['chromium', 'firefox', 'webkit'].map(x => x.padEnd(26)).join('| '));
  for (const k of keys) {
    const vals = ['chromium', 'firefox', 'webkit'].map(e => JSON.stringify(out[e].checks[k]));
    const same = new Set(vals).size === 1;
    console.log(k.padEnd(16) + '| ' + vals.map(v => (v || '').slice(0, 25).padEnd(26)).join('| ') + (same ? '  ✓一致' : '  ⚠️差异'));
  }
})();
