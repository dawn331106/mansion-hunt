/**
 * Drive a real two-player match.
 *
 * Multiplayer bugs are invisible to a typechecker and to a single browser:
 * everything about this only exists once two peers are talking. So this opens
 * two browsers, hosts in one, joins from the other, starts the match, and
 * checks the thing that actually matters — that the client's world moves when
 * the host's does, and that the host sees the client's input.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5174/';
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const errs = [];
const mk = async (label) => {
  const p = await browser.newPage({ viewport: { width: 640, height: 400 } });
  p.on('pageerror', (e) => errs.push(`${label}: ${e.message}`));
  await p.goto(URL, { waitUntil: 'networkidle' });
  return p;
};

const A = await mk('host');
const B = await mk('client');

// --- Host opens a room. ---
await A.click('#mp-host');
await A.waitForFunction(
  () => /^[A-Z0-9]{6}$/.test(document.getElementById('lobby-code').textContent || ''),
  null, { timeout: 25000 },
);
const code = await A.$eval('#lobby-code', (e) => e.textContent.trim());
console.log('room code:', code);

// --- Client joins. ---
await B.click('#mp-join');
await B.fill('#join-code', code);
await B.click('#join-go');
await B.waitForFunction(
  () => getComputedStyle(document.getElementById('lobby')).display !== 'none',
  null, { timeout: 25000 },
);
console.log('client reached the lobby');

// Both should now list two players.
await A.waitForFunction(
  () => document.querySelectorAll('#lobby-players li').length === 2,
  null, { timeout: 15000 },
);
const names = await A.$$eval('#lobby-players li', (ls) => ls.map((l) => l.textContent.trim()));
console.log('lobby shows:', names.length, 'players');

// --- Start, and fake pointer lock on both so the loop runs. ---
await A.click('#lobby-start');
const lock = (p) => p.evaluate(() => {
  const c = document.getElementById('gl');
  Object.defineProperty(document, 'pointerLockElement', { get: () => c, configurable: true });
  document.dispatchEvent(new Event('pointerlockchange'));
});
await A.waitForFunction(() => window.__match, null, { timeout: 25000 });
await B.waitForFunction(() => window.__match, null, { timeout: 25000 });
await lock(A); await lock(B);
await A.waitForTimeout(1500);
console.log('waiting out the ghost head start...');
await A.waitForFunction(()=>window.__match.time > 12, null, {timeout:40000});

const roles = {
  host: await A.evaluate(() => window.__match.role),
  client: await B.evaluate(() => window.__match.role),
};
console.log('roles:', JSON.stringify(roles));

/*
 * The test that matters: does the client's world track the host's?
 *
 * A client that simulated locally would drift; one that is genuinely being
 * fed snapshots stays within interpolation distance of the host indefinitely.
 */
const ghostAt = (p) => p.evaluate(() => {
  const m = window.__match;
  return { x: +m.ghost.x.toFixed(2), z: +m.ghost.z.toFixed(2), t: +m.time.toFixed(1) };
});

// Move the host's player, so the world is definitely changing.
await A.keyboard.down('KeyW');
await A.waitForTimeout(2500);
await A.keyboard.up('KeyW');
await A.waitForTimeout(600);

const ga = await ghostAt(A);
const gb = await ghostAt(B);
const gap = Math.hypot(ga.x - gb.x, ga.z - gb.z);
console.log(`ghost host=(${ga.x},${ga.z}) client=(${gb.x},${gb.z})  gap=${gap.toFixed(2)}m`);

// Does the host see the client moving?
const before = await A.evaluate(() => {
  const m = window.__match;
  const s = m.survivors ?? [];
  return s.map((v) => `${v.id}:${v.pos.x.toFixed(1)},${v.pos.z.toFixed(1)}`).join(' ');
});
await B.keyboard.down('KeyW');
await B.waitForTimeout(2000);
await B.keyboard.up('KeyW');
await A.waitForTimeout(500);
const after = await A.evaluate(() => {
  const m = window.__match;
  const s = m.survivors ?? [];
  return s.map((v) => `${v.id}:${v.pos.x.toFixed(1)},${v.pos.z.toFixed(1)}`).join(' ');
});
const clientMoved = before !== after;
console.log('host sees client input:', clientMoved);
console.log('  before:', before);
console.log('  after :', after);
const diag = await A.evaluate(()=>({
  selfId: window.__match.selfId ?? '?',
  survivors: (window.__match.survivors??[]).map(v=>v.id),
}));
console.log('  host diag:', JSON.stringify(diag));
const bdiag = await B.evaluate(()=>({ selfId: window.__match.selfId ?? '?' }));
console.log('  client diag:', JSON.stringify(bdiag));

const ok = gap < 2.5 && clientMoved && errs.length === 0;
console.log('\nerrors:', errs.length ? errs.join(' | ') : 'none');
console.log(ok ? 'MULTIPLAYER OK' : 'MULTIPLAYER FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
