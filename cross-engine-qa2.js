const pw = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = '/workspace/mobile-report';
const MOBILE = { vw: 390, vh: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };
const E = async (p, fn, arg) => { try { return await p.evaluate(fn, arg); } catch (e) { return { _err: e.message }; } };

async function run(engineName, browserType, launchOpts) {
  const rep = { engine: engineName, steps: {}, errors: [] };
  let browser;
  try { browser = await browserType.launch(launchOpts); }
  catch (e) { rep.errors.push('LAUNCH FAIL: ' + e.message.split('\n')[0]); return rep; }
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

    // === A. 指标切换（正确选择器：[data-metric]）===
    const metrics = ['end', 'max', 'station'];
    rep.steps.metricToggle = [];
    for (const m of metrics) {
      const ok = await page.click(`[data-metric="${m}"]`, { timeout: 4000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(900);
      const state = await E(page, (mm) => {
        const btns = [...document.querySelectorAll('.toggle-btn')];
        const act = btns.filter(b => b.classList.contains('active')).map(b => b.dataset.metric);
        const st = document.querySelector('#stationSelect');
        const stVisible = st && !st.classList.contains('hidden') && getComputedStyle(st).display !== 'none';
        const c = document.querySelector('#chart10d');
        const st2 = document.querySelector('#chartStations');
        return {
          active: act,
          activeIsTarget: act.length === 1 && act[0] === mm,
          stationSelectVisible: stVisible,
          stationSelectOptions: st ? st.options.length : 0,
          chart10dBitmapW: c ? c.width : 0,
          chartStationsVisible: st2 ? (st2.getBoundingClientRect().width > 0) : false,
        };
      }, m);
      rep.steps.metricToggle.push({ metric: m, clickOK: ok, ...state });
    }
    await page.screenshot({ path: `${OUT}/${engineName}-x2-01-station-metric.png` }).catch(() => {});

    // === B. 逐站图 + lightbox 点击 ===
    const chartBox = await page.$('.chart-box');
    if (chartBox) {
      await chartBox.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1000);
      rep.steps.lightbox = await E(page, () => {
        const lb = document.querySelector('.chart-lightbox');
        return lb ? { exists: true, visible: getComputedStyle(lb).display !== 'none' && !lb.classList.contains('hidden') } : { exists: false };
      });
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }

    // === C. 分享图片生成（canvas toBlob 跨内核关键路径）===
    await page.click('#shareImgQuickBtn').catch(() => {});
    await page.waitForTimeout(3500);
    rep.steps.shareImage = await E(page, () => {
      const tip = document.querySelector('#shareTip');
      const extra = [...document.querySelectorAll('canvas')].filter(c => !['chart10d', 'chartStations'].includes(c.id));
      return {
        tipVisible: tip && !tip.classList.contains('hidden'),
        tipHasDownloadLink: tip ? !!tip.querySelector('a[download]') : false,
        tipLinkHref: tip && tip.querySelector('a[download]') ? (tip.querySelector('a[download]').href || '').slice(0, 40) : '',
        generatedCanvasSizes: extra.map(c => ({ id: c.id || '(anon)', w: c.width, h: c.height })),
      };
    });
    await page.screenshot({ path: `${OUT}/${engineName}-x2-02-shareimg.png` }).catch(() => {});

    // === D. 深色模式渲染（含图表重绘）===
    await page.click('#themeToggle').catch(() => {});
    await page.waitForTimeout(1200);
    rep.steps.darkMode = await E(page, () => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const c = document.querySelector('#chart10d');
      const ctx = c && c.getContext('2d');
      let sample = null;
      try { const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; sample = [d[0], d[1], d[2]]; } catch (e) { sample = 'CORS/err'; }
      return { theme: document.documentElement.getAttribute('data-theme'), bodyBg: bg, chartRedrawn: c ? c.width > 0 : false, centerPixel: sample };
    });
    await page.screenshot({ path: `${OUT}/${engineName}-x2-03-dark.png` }).catch(() => {});
    await page.click('#themeToggle').catch(() => {});
    await page.waitForTimeout(600);

    // === E. 区域设置（Intl / 排序）与日期选择器 ===
    rep.steps.dateSelect = await E(page, () => {
      const s = document.querySelector('#predictDate');
      return s ? { options: s.options.length, firstText: s.options[0] ? s.options[0].textContent : '' } : null;
    });

    // === F. 复制分享链接（clipboard 跨内核）===
    await page.click('#shareBtn').catch(() => {});
    await page.waitForTimeout(700);
    const copyOK = await page.click('#shareCopyBtn', { timeout: 4000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1200);
    rep.steps.copyLink = await E(page, (ok) => ({ clickOK: ok, tipVisible: (() => { const t = document.querySelector('#shareTip'); return t && !t.classList.contains('hidden'); })() }), copyOK);
    await page.click('#shareModalClose').catch(() => {});
    await page.waitForTimeout(400);

    // === G. 评论输入（未登录态）===
    rep.steps.comment = await E(page, () => {
      const ta = document.querySelector('#commentText');
      const btn = document.querySelector('#commentSubmit');
      return ta ? { hasTextarea: true, placeholder: ta.placeholder.slice(0, 40), submitDisabled: btn ? btn.disabled : null } : { hasTextarea: false };
    });

    // === H. 视图模型 API 一致性 ===
    rep.steps.apiSupport = await E(page, () => ({
      ResizeObserver: typeof ResizeObserver !== 'undefined',
      canvasToBlob: !!HTMLCanvasElement.prototype.toBlob,
      OffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      ElementAnimate: !!Element.prototype.animate,
      CSSgap: CSS.supports('gap', '1px'),
      CSSpositionSticky: CSS.supports('position', 'sticky'),
      CSSaspectRatio: CSS.supports('aspect-ratio', '1/1'),
      IntlNumberFormat: (() => { try { return new Intl.NumberFormat('de-DE').format(1234.5); } catch (e) { return 'ERR'; } })(),
      IntlDateTimeFormat: (() => { try { return new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(new Date('2026-01-05')); } catch (e) { return 'ERR'; } })(),
      toLocaleString: (() => (1234.5).toLocaleString('de-DE')),
      structuredClone: typeof structuredClone !== 'undefined',
      AbortController: typeof AbortController !== 'undefined',
    }));
  } catch (e) {
    rep.errors.push('RUN ERROR: ' + e.message.split('\n')[0]);
  }
  await ctx.close(); await browser.close();
  return rep;
}

(async () => {
  const out = {};
  const engines = [
    ['chromium', pw.chromium, { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined }],
    ['firefox', pw.firefox, {}],
    ['webkit', pw.webkit, {}],
  ];
  for (const [name, bt, opts] of engines) {
    process.stdout.write(`\n>>> ${name} ...\n`);
    out[name] = await run(name, bt, opts);
    console.log(`[${name}] errors=${out[name].errors.length}`, out[name].errors.slice(0, 3));
  }
  fs.writeFileSync(`${OUT}/cross-engine-report2.json`, JSON.stringify(out, null, 2));
  console.log('\n=== DONE ===');
})();
