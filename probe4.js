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
await p.evaluate(()=>document.querySelector('#chartStations').scrollIntoView({block:'center'}));
await p.waitForTimeout(600);
const box=await (await p.$('#chartStations')).boundingBox();
await p.mouse.click(box.x+box.width*0.5, box.y+box.height*0.5);
await p.waitForTimeout(1200);
console.log('lightbox open:',await p.evaluate(()=>!!document.querySelector('.chart-lightbox')));
// 测试 ESC
await p.keyboard.press('Escape');await p.waitForTimeout(800);
console.log('after ESC, lightbox exists:',await p.evaluate(()=>!!document.querySelector('.chart-lightbox')));
// 测试关闭按钮
const closeBtn=await p.$('.chart-lightbox-close');
if(closeBtn){await closeBtn.click();await p.waitForTimeout(600);}
console.log('after close-btn click, lightbox exists:',await p.evaluate(()=>!!document.querySelector('.chart-lightbox')));
// 重开测背景点击关闭
if(!await p.evaluate(()=>!!document.querySelector('.chart-lightbox'))){
  await p.mouse.click(box.x+box.width*0.5, box.y+box.height*0.5);await p.waitForTimeout(1000);
}
console.log('reopened:',await p.evaluate(()=>!!document.querySelector('.chart-lightbox')));
// 点 overlay 角落（非卡片区）
const ov=await p.$('.chart-lightbox');
await p.mouse.click(5,5);await p.waitForTimeout(700);
console.log('after overlay-corner click, lightbox exists:',await p.evaluate(()=>!!document.querySelector('.chart-lightbox')));
await b.close();
})();
