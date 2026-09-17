const {chromium}=require('playwright');const fs=require('fs');
const exe=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined;
(async()=>{
const b=await chromium.launch({args:['--no-sandbox'],executablePath:exe});
const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p=await c.newPage();
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#searchBtn');await p.fill('#trainInput','ICE 847');await p.click('#searchBtn');
await p.waitForTimeout(3000);
await p.click('[data-metric="station"]').catch(()=>{});
await p.waitForTimeout(1500);
// 滚到 chartStations 可见
await p.evaluate(()=>document.querySelector('#chartStations').scrollIntoView({block:'center'}));
await p.waitForTimeout(800);
const box=await (await p.$('#chartStations')).boundingBox();
console.log('box after scroll:',JSON.stringify(box));
await p.mouse.click(box.x+box.width*0.5, box.y+box.height*0.5);
await p.waitForTimeout(1500);
const lb=await p.evaluate(()=>{const l=document.querySelector('.chart-lightbox');return l?{exists:true,display:getComputedStyle(l).display,hasCanvas:!!l.querySelector('canvas'),cls:l.className}:{exists:false}});
console.log('lightbox after scroll+click:',JSON.stringify(lb));

// canvas 背景色采样（左上角 4x4 平均）
async function bgSample(sel){return await p.evaluate((s)=>{const c=document.querySelector(s);const ctx=c.getContext('2d');const d=ctx.getImageData(2,2,4,4).data;let r=0,g=0,b=0;for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}const n=d.length/4;return{r:Math.round(r/n),g:Math.round(g/n),b:Math.round(b/n)};},sel);}
console.log('LIGHT chart10d bg:',JSON.stringify(await bgSample('#chart10d')));
console.log('LIGHT chartStations bg:',JSON.stringify(await bgSample('#chartStations')));
await p.click('#themeToggle');await p.waitForTimeout(1800);
console.log('DARK  chart10d bg:',JSON.stringify(await bgSample('#chart10d')));
console.log('DARK  chartStations bg:',JSON.stringify(await bgSample('#chartStations')));
console.log('body bg dark:',await p.evaluate(()=>getComputedStyle(document.body).backgroundColor));
await p.screenshot({path:'/workspace/mobile-report/darkmode-probe.png'});
await b.close();
})();
