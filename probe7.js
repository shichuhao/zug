const {chromium}=require('playwright');const fs=require('fs');
const exe=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined;
(async()=>{
const b=await chromium.launch({args:['--no-sandbox'],executablePath:exe});
const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p=await c.newPage();
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('#searchBtn');await p.fill('#trainInput','ICE 847');await p.click('#searchBtn');
await p.waitForTimeout(3500);
async function probe(){return await p.evaluate(()=>{
  const cs=getComputedStyle(document.documentElement);
  const chartGrid=cs.getPropertyValue('--chart-grid').trim();
  const chartTick=cs.getPropertyValue('--chart-tick').trim();
  const cv=document.getElementById('chart10d');
  const ch=window.Chart.getChart(cv);
  const sk=Object.keys(ch.scales)[0];const sc=ch.scales[sk];
  // Chart.js 实际生效的 grid color
  let effGrid=null;
  try{ effGrid = sc.grid && sc.grid.color ? sc.grid.color : (sc.options.grid?sc.options.grid.color:null); }catch(e){effGrid='err';}
  return { theme:document.documentElement.getAttribute('data-theme'), cssVarGrid:chartGrid, cssVarTick:chartTick, chartConfigGrid: ch.options.scales, scaleGridColor: effGrid };
});}
const L=await probe();
console.log('LIGHT cssVar --chart-grid:',L.cssVarGrid,'--chart-tick:',L.cssVarTick);
console.log('LIGHT parse scales:',JSON.stringify(L.chartConfigGrid));
await p.click('#themeToggle');await p.waitForTimeout(2200);
const D=await probe();
console.log('DARK  cssVar --chart-grid:',D.cssVarGrid,'--chart-tick:',D.cssVarTick,'theme:',D.theme);
await b.close();
})();
