import { chromium } from 'playwright';
const b = await chromium.launch({ channel:'chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:800,height:500} });
const errs=[]; p.on('pageerror', e=>errs.push(e.message));
await p.goto('http://localhost:5174/', { waitUntil:'networkidle' });

const lock = () => p.evaluate(() => {
  const c=document.getElementById('gl');
  Object.defineProperty(document,'pointerLockElement',{get:()=>c,configurable:true});
  document.dispatchEvent(new Event('pointerlockchange'));
});
const vis = (id) => p.evaluate(i=>getComputedStyle(document.getElementById(i)).display, id);

// Round 1: play as ghost until the match ends.
await p.click('#play-ghost'); await lock();
let ended=false;
for (let i=0;i<200;i++){ await p.waitForTimeout(1000);
  if (await vis('end') !== 'none'){ ended=true; console.log('round 1 ended at ~'+i+'s'); break; } }
if(!ended) console.log('round 1 did NOT end');

// Click Again -> menu should appear and STAY.
await p.click('#play-again');
await p.waitForTimeout(1500);
console.log('after Again: menu='+await vis('menu'), 'end='+await vis('end'));

// Round 2 must start and actually run.
await p.click('#play-survivor'); await lock();
await p.waitForTimeout(3000);
console.log('round 2: menu='+await vis('menu'), 'end='+await vis('end'));
const running = await p.evaluate(()=>{
  const c=document.getElementById('hud');
  return c.width>0 && c.height>0;
});
console.log('round 2 rendering:', running);

// Round 3, straight from the end screen path again.
await p.waitForTimeout(1000);
console.log('errors:', errs.length? errs.join(' | ') : 'none');
await b.close();
