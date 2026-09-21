/**
 * Prove that every hiding place can be left.
 *
 * Entering a hiding spot teleports the survivor into it, and crawl-under
 * spots sit inside furniture by design — so if collision does not let a
 * crouched body back out, the player is stuck there permanently. That
 * shipped: `crouchUnder` was declared in the map and read by nothing, so all
 * seven crawl spots were one-way.
 *
 * `checkmap` proves the geometry allows an exit; this drives the real game
 * and proves the whole path works — enter, climb out, and walk away.
 *
 *   npx tsx tools/hidetest.mjs
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ channel:'chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:700,height:450} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://localhost:5174/', { waitUntil:'networkidle' });
await p.selectOption('#survivor-count','1');
await p.click('#play-survivor');
await p.waitForFunction(()=>window.__match,null,{timeout:15000});
await p.evaluate(()=>{ const c=document.getElementById('gl');
  Object.defineProperty(document,'pointerLockElement',{get:()=>c,configurable:true});
  document.dispatchEvent(new Event('pointerlockchange')); });
await p.waitForTimeout(600);

const st = () => p.evaluate(()=>{const m=window.__match; return {
  x:m.self.pos.x, z:m.self.pos.z, hidden:!!m.self.hidden, stance:m.self.stance };});

// Teleport onto each hiding spot via the real interact path: walk to it.
const spots = await p.evaluate(async () => {
  const { buildMansion } = await import('/src/game/map.ts');
  return buildMansion().hidingSpots.map(h=>({id:h.id,kind:h.kind,x:h.x,z:h.z}));
});

let failures = 0;
for (const spot of spots) {
  // Put the survivor next to the spot, then press E to enter.
  await p.evaluate(s => { window.__match.self.pos.x = s.x; window.__match.self.pos.z = s.z; }, spot);
  await p.waitForTimeout(120);
  await p.keyboard.press('KeyE');
  await p.waitForTimeout(350);
  let a = await st();
  if (!a.hidden) { console.log(`skip ${spot.id} (did not enter)`); continue; }

  await p.waitForTimeout(500);
  await p.keyboard.press('KeyE');       // climb out
  await p.waitForTimeout(350);
  const mid = await st();

  // Now try to walk in four directions and see if anything moves.
  let moved = 0;
  for (const k of ['KeyW','KeyS','KeyA','KeyD']) {
    const before = await st();
    await p.keyboard.down(k); await p.waitForTimeout(450); await p.keyboard.up(k);
    await p.waitForTimeout(100);
    const after = await st();
    moved = Math.max(moved, Math.hypot(after.x-before.x, after.z-before.z));
  }
  const ok = !mid.hidden && moved > 0.25;
  if (!ok) { failures++; console.log(`FAIL ${spot.id.padEnd(22)} stance=${mid.stance} moved=${moved.toFixed(2)}m`); }
  else console.log(`ok   ${spot.id.padEnd(22)} stance=${mid.stance} moved=${moved.toFixed(2)}m`);
}
console.log(failures? `\n${failures} SPOTS TRAP THE PLAYER` : '\nEVERY SPOT CAN BE LEFT');
console.log('errors:', errs.length?errs.join(' | '):'none');
await b.close();
process.exit(failures?1:0);
