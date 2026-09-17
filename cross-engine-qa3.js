const pw = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
const MOBILE = { vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };
const E = async (p, fn, arg) => { try { return await p.evaluate(fn, arg); } catch (e) { return { _err: e.message }; } };

// 采样 canvas 中央区域平均色（排除透明边缘）
const canvasCenter = (page, sel) => E(page, (s) => {
  const c = document.querySelector(s); if (!c) return null;
  const ctx = c.getContext('2d');
  const x0 = Math.floor(c.width * 0.3), y0 = Math.floor(c.height * 0.3);
  const w = Math.floor(c.width * 0.4), h = Math.floor(c.height * 0.4);
  try {
    const d = ctx.getImageData(x0, y0, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), lum: Math.round((r + g + b) / (3 * n)) };
  } catch (e) { return { err: e.message.slice(0, 40) }; }
}, sel);

async function run(name, bt, opts) {
  const rep = { engine: name, steps: {}, errors: [] };
  let browser;
  try { browser = await bt.launch(opts); } catch (e) { rep.errors.push('LAUNCH FAIL: ' + e.message.split('\n')[0]); return rep; }
  const ctx = await browser.newContext({ viewport: { width: MOBILE.vw, height: MOBILE.vh }, deviceScaleFactor: MOBILE.dpr, isMobile: true, hasTouch: true, userAgent: MOBILE.ua });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') rep.errors.push('console: ' + m.text().slice(0, 150)); });
  page.on('pageerror', e => rep.errors.push('pageerror: ' + String(e).slice(0, 150)));
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('#searchBtn', { timeout: 20000 });
    await page.fill('#trainInput', 'ICE 847');
    await page.click('#searchBtn');
    await page.waitForFunction(() => { const c = document.querySelector('#chart10d'); return c && c.width > 0; }, undefined, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.click('[data-metric="station"]').catch(() => {});
    await page.waitForTimeout(1500);

    // 深色模式图表重绘：先采样亮色，切暗色再采样
    rep.steps.chartLight = await canvasCenter(page, '#chart10d');
    await page.click('#themeToggle'); await page.waitForTimeout(1800);
    rep.steps.chartDark = await canvasCenter(page, '#chart10d');
    rep.steps.chartDarkRedrawn = rep.steps.chartLight && rep.steps.chartDark &&
      Math.abs((rep.steps.chartLight.lum || 0) - (rep.steps.chartDark.lum || 0)) > 10;
    await page.screenshot({ path: `${OUT}/${name}-x3-dark.png` }).catch(() => {});
    await page.click('#themeToggle'); await page.waitForTimeout(1000);

    // Lightbox：滚动到可见 → 点击数据点 → 验证打开/ESC/关闭按钮
    await page.evaluate(() => document.querySelector('#chartStations').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(700);
    const b1 = await (await page.$('#chartStations')).boundingBox();
    if (b1) await page.mouse.click(b1.x + b1.width * 0.5, b1.y + b1.height * 0.5);
    await page.waitForTimeout(1200);
    const opened = await E(page, () => !!document.querySelector('.chart-lightbox'));
    let escClosed = null, btnClosed = null;
    if (opened) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(800);
      escClosed = await E(page, () => !document.querySelector('.chart-lightbox'));
      if (!escClosed) { const cb = await page.$('.chart-lightbox-close'); if (cb) { await cb.click(); await page.waitForTimeout(600); } btnClosed = await E(page, () => !document.querySelector('.chart-lightbox')); }
    }
    rep.steps.lightbox = { opened, escCloses: escClosed, closeBtnCloses: btnClosed };
    await page.screenshot({ path: `${OUT}/${name}-x3-lightbox.png` }).catch(() => {});
    if (!escClosed && !btnClosed) { /* 仍在 lightbox，跳过后续 */ }
  } catch (e) { rep.errors.push('RUN ERROR: ' + e.message.split('\n')[0]); }
  await ctx.close(); await browser.close();
  return rep;
}

(async () => {
  const out = {};
  for (const [name, bt, opts] of [
    ['chromium', pw.chromium, { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined }],
    ['firefox', pw.firefox, {}],
    ['webkit', pw.webkit, {}],
  ]) {
    process.stdout.write(`\n>>> ${name} ...\n`);
    out[name] = await run(name, bt, opts);
    console.log(`[${name}] errors=${out[name].errors.length}`);
  }
  fs.writeFileSync(`${OUT}/cross-engine-report3.json`, JSON.stringify(out, null, 2));
  console.log('\n=== DONE ===');
  for (const [n, r] of Object.entries(out)) {
    console.log(`\n### ${n}`);
    console.log('  chartLight:', JSON.stringify(r.steps.chartLight), 'chartDark:', JSON.stringify(r.steps.chartDark), 'redrawn:', r.steps.chartDarkRedrawn);
    console.log('  lightbox:', JSON.stringify(r.steps.lightbox));
    if (r.errors.length) r.errors.forEach(e => console.log('   !', e));
  }
})();
