const pw = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const M = { vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };

(async () => {
  const b = await pw.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: exe });
  const ctx = await b.newContext({ viewport: { width: M.vw, height: M.vh }, deviceScaleFactor: M.dpr, isMobile: true, hasTouch: true, userAgent: M.ua });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#searchBtn');
  await p.fill('#trainInput', 'ICE 847');
  await p.click('#searchBtn');
  await p.waitForTimeout(4000);
  // 展开成分分析
  await p.click('#viewTabTrain').catch(() => {});
  // 找懒加载按钮
  const lazy = await p.$('#bdLazyBtn');
  if (lazy) { await lazy.click().catch(() => {}); await p.waitForTimeout(2500); }
  await p.waitForTimeout(1500);

  const result = {};
  for (const lang of ['zh', 'en', 'de']) {
    await p.click(`.lang-btn[data-lang="${lang}"]`).catch(() => {});
    await p.waitForTimeout(1200);
    result[lang] = await p.evaluate(() => {
      const box = document.getElementById('bdZfCats');
      if (!box) return { found: false };
      const title = document.querySelector('.panel-title, .bd-section-title');
      const names = [...box.querySelectorAll('.zf-name')].map(e => e.textContent.trim());
      // 找 zfTitle 所在的标题
      let zfTitle = null;
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length === 0 && /Ursachen|原因|Delay causes/.test(el.textContent) && el.textContent.length < 40) zfTitle = el.textContent.trim();
      });
      return { found: true, names, sample: names.slice(0, 5), anyChinese: names.some(n => /[\u4e00-\u9fa5]/.test(n)), zfTitle };
    });
    await p.screenshot({ path: `${OUT}/zf-i18n-${lang}.png`, fullPage: false }).catch(() => {});
  }
  await b.close();
  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync(`${OUT}/zf-i18n-verify.json`, JSON.stringify(result, null, 2));
})();
