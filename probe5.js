const {chromium}=require('playwright');const fs=require('fs');
const exe=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined;
(async()=>{
const b=await chromium.launch({args:['--no-sandbox'],executablePath:exe});
const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p=await c.newPage();
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#searchBtn');await p.fill('#trainInput','ICE 847');await p.click('#searchBtn');
await p.waitForTimeout(3500);
// 整图亮度直方图：均值 + 浅色占比 + 深色占比
async function hist(sel){return await p.evaluate((s)=>{const c=document.querySelector(s);if(!c)return null;const ctx=c.getContext('2d');const d=ctx.getImageData(0,0,c.width,c.height).data;let sum=0,n=0,light=0,dark=0,transp=0;for(let i=0;i<d.length;i+=4){const a=d[i+3];if(a<10){transp++;continue;}const lum=(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114);sum+=lum;n++;if(lum>180)light++;if(lum<60)dark++;}const tot=d.length/4;return{avgLum:+(sum/n).toFixed(1),lightPct:+(light/tot*100).toFixed(1),darkPct:+(dark/tot*100).toFixed(1),transpPct:+(transp/tot*100).toFixed(1),pixels:tot};},sel);}
console.log('LIGHT chart10d:',JSON.stringify(await hist('#chart10d')));
console.log('LIGHT chartStations:',JSON.stringify(await hist('#chartStations')));
await p.click('#themeToggle');await p.waitForTimeout(2000);
console.log('DARK  chart10d:',JSON.stringify(await hist('#chart10d')));
console.log('DARK  chartStations:',JSON.stringify(await hist('#chartStations')));
console.log('theme attr:',await p.evaluate(()=>document.documentElement.getAttribute('data-theme')));
// 检查 chart 配置里是否有主题相关色
console.log('canvas parent bg:',await p.evaluate(()=>{const c=document.querySelector('#chart10d');return getComputedStyle(c.parentElement).backgroundColor;}));
await p.screenshot({path:'/workspace/mobile-report/dark-chart-compare.png',fullPage:false});
await b.close();
})();
