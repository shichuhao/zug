const {chromium}=require('playwright');const fs=require('fs');
const exe=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined;
(async()=>{
const b=await chromium.launch({args:['--no-sandbox'],executablePath:exe});
const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p=await c.newPage();
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#searchBtn');await p.fill('#trainInput','ICE 847');await p.click('#searchBtn');
await p.waitForTimeout(3000);
const info=await p.evaluate(()=>{
  const btns=[...document.querySelectorAll('.toggle-btn')];
  return {
    toggleBtns: btns.map(x=>({metric:x.dataset.metric,hidden:x.classList.contains('hidden'),disp:getComputedStyle(x).display,active:x.classList.contains('active'),rect:(()=>{const r=x.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}})()})),
    metricSegmentBtn: (()=>{const e=document.getElementById('metricSegmentBtn');return e?{hidden:e.classList.contains('hidden'),disp:getComputedStyle(e).display}:null})(),
    stationSelectHidden: (()=>{const e=document.getElementById('stationSelect');return e?{hidden:e.classList.contains('hidden')}:null})(),
  };
});
console.log(JSON.stringify(info,null,2));
await b.close();
})();
