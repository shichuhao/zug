const {chromium}=require('playwright');const fs=require('fs');
const exe=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined;
(async()=>{
const b=await chromium.launch({args:['--no-sandbox'],executablePath:exe});
const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p=await c.newPage();
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#searchBtn');await p.fill('#trainInput','ICE 847');await p.click('#searchBtn');
await p.waitForTimeout(3500);
async function chartColors(){return await p.evaluate(()=>{
  const res={};
  for(const id of ['chart10d','chartStations']){
    const cv=document.getElementById(id);
    if(!cv||!window.Chart){res[id]='no-chart-lib';continue;}
    const ch=window.Chart.getChart(cv);
    if(!ch){res[id]='no-instance';continue;}
    const sk=Object.keys(ch.scales)[0];const sc=ch.scales[sk];
    res[id]={
      tickColor: sc&&sc.options&&sc.options.ticks?sc.options.ticks.color:'?',
      gridColor: sc&&sc.options&&sc.options.grid?sc.options.grid.color:'?',
      legendColor: ch.options.plugins&&ch.options.plugins.legend&&ch.options.plugins.legend.labels?(ch.options.plugins.legend.labels.color||'(unset→default #666)'):'n/a',
      bodyTextColor: getComputedStyle(document.body).color,
    };
  }
  return res;
});}
console.log('LIGHT:',JSON.stringify(await chartColors()));
await p.click('#themeToggle');await p.waitForTimeout(2200);
console.log('DARK :',JSON.stringify(await chartColors()));
await b.close();
})();
