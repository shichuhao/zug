const {chromium}=require('playwright');const fs=require('fs');
const exe=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined;
(async()=>{
const b=await chromium.launch({args:['--no-sandbox'],executablePath:exe});
const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p=await c.newPage();
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#searchBtn');await p.fill('#trainInput','ICE 847');await p.click('#searchBtn');
await p.waitForTimeout(3500);
async function bcolors(){return await p.evaluate(()=>{
  const out={};
  for(const id of ['chart10d','chartStations']){
    const ch=window.Chart.getChart(document.getElementById(id));
    const sc=ch.scales[Object.keys(ch.scales)[1]]; // y轴
    out[id]={ yGrid:sc.options.grid.color, yTick:sc.options.ticks.color, border:sc.options.border?sc.options.border.color:'?' };
  }
  return out;
});}
console.log('LIGHT:',JSON.stringify(await bcolors()));
await p.click('#themeToggle');await p.waitForTimeout(2200);
console.log('DARK :',JSON.stringify(await bcolors()));
await b.close();
})();
