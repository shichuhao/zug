const pw = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
const M = { vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };
const E = (p, fn) => p.evaluate(fn).catch(e => ({ _err: e.message }));

async function check(name, bt, opts) {
  const rep = { engine: name, errors: [] };
  let b;
  try { b = await bt.launch(opts); } catch (e) { rep.errors.push('launch: ' + e.message.split('\n')[0]); return rep; }
  const ctx = await b.newContext({ viewport: { width: M.vw, height: M.vh }, deviceScaleFactor: M.dpr, isMobile: true, hasTouch: true, userAgent: M.ua });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') rep.errors.push('console: ' + m.text().slice(0, 120)); });
  p.on('pageerror', e => rep.errors.push('pageerror: ' + String(e).slice(0, 120)));
  try {
    await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await p.waitForSelector('#bmcBtn', { timeout: 15000 });
    // 页脚赞助按钮
    rep.btn = await E(p, () => {
      const a = document.getElementById('bmcBtn');
      const r = a.getBoundingClientRect();
      return { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent.trim(), visible: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height) };
    });
    // 打开二维码弹窗
    await p.click('#bmcQrBtn');
    await p.waitForTimeout(700);
    rep.modal = await E(p, () => {
      const m = document.getElementById('bmcModal');
      const r = m.getBoundingClientRect();
      const img = document.getElementById('bmcQrImg');
      const ir = img.getBoundingClientRect();
      return { open: !m.classList.contains('hidden'), noOverflow: r.bottom <= window.innerHeight + 1, qrVisible: ir.width > 0, qrSrc: img.getAttribute('src'), linkHref: (document.querySelector('.bmc-link-btn') || {}).getAttribute ? document.querySelector('.bmc-link-btn').getAttribute('href') : null };
    });
    await p.screenshot({ path: `${OUT}/${name}-bmc-light.png` }).catch(() => {});
    // ESC 关闭
    await p.keyboard.press('Escape'); await p.waitForTimeout(500);
    rep.escClosed = await E(p, () => document.getElementById('bmcModal').classList.contains('hidden'));
    // 深色模式截图
    await p.click('#themeToggle'); await p.waitForTimeout(800);
    await p.click('#bmcQrBtn'); await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}/${name}-bmc-dark.png` }).catch(() => {});
    // 德语
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.click('.lang-btn[data-lang="de"]'); await p.waitForTimeout(700);
    rep.deLabel = await E(p, () => document.querySelector('#bmcBtn').textContent.trim());
    await p.click('#bmcQrBtn'); await p.waitForTimeout(500);
    rep.deTitle = await E(p, () => document.querySelector('#bmcModal .modal-title span').textContent.trim());
  } catch (e) { rep.errors.push('run: ' + e.message.split('\n')[0]); }
  await ctx.close(); await b.close();
  return rep;
}

(async () => {
  const out = {};
  for (const [n, bt, o] of [
    ['chromium', pw.chromium, { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined }],
    ['firefox', pw.firefox, {}],
    ['webkit', pw.webkit, {}],
  ]) { process.stdout.write(`>>> ${n} ... `); out[n] = await check(n, bt, o); console.log(`errors=${out[n].errors.length}`); }
  fs.writeFileSync(`${OUT}/bmc-verify.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
