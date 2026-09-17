const {chromium}=require('playwright');const fs=require('fs');
const exe=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined;
(async()=>{
const b=await chromium.launch({args:['--no-sandbox'],executablePath:exe});
const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p=await c.newPage();
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#searchBtn');await p.fill('#trainInput','ICE 847');await p.click('#searchBtn');
await p.waitForTimeout(3000);
// 逐站图：先切到 station 指标让它可见
await p.click('[data-metric="station"]').catch(()=>{});
await p.waitForTimeout(1500);
const cs=await p.$('#chartStations');
const box=await cs.boundingBox();
console.log('chartStations box:',JSON.stringify(box));
// 点击图表中部（数据点区域）
await p.mouse.click(box.x+box.width*0.5, box.y+box.height*0.5);
await p.waitForTimeout(1200);
const lb=await p.evaluate(()=>{const l=document.querySelector('.chart-lightbox');return l?{exists:true,display:getComputedStyle(l).display,hasCanvas:!!l.querySelector('canvas')}:{exists:false}});
console.log('lightbox after data-point click:',JSON.stringify(lb));
// 深色模式像素：图表面板区域采样
await p.keyboard.press('Escape');await p.waitForTimeout(500);
const lightPix=await p.evaluate(()=>{const c=document.querySelector('#chart10d');const ctx=c.getContext('2d');let dark=0,tot=0;for(let x=0;x<c.width;x+=20){for(let y=0;y<c.height;y+=20){const d=ctx.getImageData(x,y,1,1).data;tot++;if(d[0]+d[1]+d[2]<120)dark++;}}return{darkPixels:dark,total:tot,ratio:+(dark/tot).toFixed(2),bg:getComputedStyle(document.body).backgroundColor}});
console.log('LIGHT chart10d nonWhiteRatio:',JSON.stringify(lightPix));
await p.click('#themeToggle');await p.waitForTimeout(1500);
const darkPix=await p.evaluate(()=>{const c=document.querySelector('#chart10d');const ctx=c.getContext('2d');let dark=0,tot=0;for(let x=0;x<c.width;x+=20){for(let y=0;y<c.height;y+=20){const d=ctx.getImageData(x,y,1,1).data;tot++;if(d[0]+d[1]+d[2]<120)dark++;}}return{darkPixels:dark,total:tot,ratio:+(dark/tot).toFixed(2),theme:document.documentElement.getAttribute('data-theme')}});
console.log('DARK chart10d darkRatio:',JSON.stringify(darkPix));
await b.close();
})();
