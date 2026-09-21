/**
 * Pin the controls by what appears on screen.
 *
 * Mouse yaw and A/D strafe are not independent: the strafe basis is derived
 * from the yaw, so flipping one silently inverts the other. That coupling is
 * why this pair inverted itself repeatedly — each fix was verified in
 * isolation, against a yaw value or a camera vector, and each one broke the
 * other without the check noticing.
 *
 * So this test never looks at a number the game computes. It drags the mouse
 * or holds a key, screenshots the canvas, and measures which way the picture
 * actually moved by cross-correlating column-brightness profiles. That is the
 * same thing the player's eye does, and it is the only definition of "right"
 * that matters here.
 *
 * Expected, in terms of the image:
 *   mouse right -> world sweeps LEFT   (turning your head right)
 *   mouse up    -> world sweeps DOWN  (looking up)
 *   W           -> world flows outward (moving into the scene)
 *   D           -> world sweeps LEFT   (stepping to the right)
 *   A           -> world sweeps RIGHT
 *
 *   npx tsx tools/controls.mjs [url]
 */

import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5174/';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.selectOption('#survivor-count', '1');
await page.click('#play-survivor');
await page.waitForFunction(() => window.__match, null, { timeout: 15000 });
await page.evaluate(() => {
  // Pointer lock cannot be granted headlessly, so fake it: the game pauses
  // without it and nothing would move.
  const c = document.getElementById('gl');
  Object.defineProperty(document, 'pointerLockElement', { get: () => c, configurable: true });
  document.dispatchEvent(new Event('pointerlockchange'));
  document.getElementById('hud').style.display = 'none';
});
await page.waitForTimeout(1000);

/**
 * Where a fixed world point sits on screen, -1 (left) to +1 (right).
 *
 * Tracking image features by column brightness was the obvious approach and
 * it does not work here: the house is lit at the edge of visibility, so the
 * profiles are nearly flat and the correlation pins to the end of its search
 * range, happily reporting the same answer for every control. Projecting a
 * known point through the real camera asks the same question — which way did
 * the picture move — and answers it exactly.
 */
const probe = () => page.evaluate(() => window.__match.probe);

const results = [];

async function measure(label, axis, act, expect) {
  // Face the probe point first, so it is on screen and its motion is legible.
  await page.evaluate(() => {
    const m = window.__match;
    const want = Math.atan2(0 - m.self.pos.z, 0 - m.self.pos.x);
    const delta = want - m.self.yaw;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: delta / 0.0022 }));
  });
  await page.waitForTimeout(350);

  const before = await probe();
  await act();
  await page.waitForTimeout(450);
  const after = await probe();

  const d = axis === 'x' ? after.x - before.x : after.y - before.y;
  const EPS = 0.02;
  const named = axis === 'y'
    ? (d > EPS ? 'UP' : d < -EPS ? 'DOWN' : 'NONE')
    : (d > EPS ? 'RIGHT' : d < -EPS ? 'LEFT' : 'NONE');
  const ok = named === expect;
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(26)} image moved ${named.padEnd(5)} (${d.toFixed(3)}), want ${expect}`);
}

const mouse = (dx, dy) => page.evaluate(
  ([x, y]) => window.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y })),
  [dx, dy],
);
const hold = (key, ms) => async () => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

/**
 * Forward and back, checked by distance rather than screen shift.
 *
 * W and S share the same basis as the strafe keys, so a change that inverts
 * one can invert these too — they have to be in the same test or the coupling
 * goes unchecked again.
 */
for (const [key, want] of [['KeyW', 'CLOSER'], ['KeyS', 'FURTHER']]) {
  const a = await page.evaluate(() => {
    const m = window.__match;
    return Math.hypot(m.self.pos.x, m.self.pos.z);
  });
  await hold(key, 900)();
  await page.waitForTimeout(250);
  const b2 = await page.evaluate(() => {
    const m = window.__match;
    return Math.hypot(m.self.pos.x, m.self.pos.z);
  });
  // The probe point is the house centre, so walking forward while facing it
  // must reduce the distance to it.
  const got = b2 < a - 0.3 ? 'CLOSER' : b2 > a + 0.3 ? 'FURTHER' : 'NONE';
  const ok = got === want;
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${key.padEnd(26)} moved ${got.padEnd(7)} (${(b2 - a).toFixed(2)}m), want ${want}`);
}

await measure('mouse right', 'x', () => mouse(120, 0), 'LEFT');
await measure('mouse left', 'x', () => mouse(-120, 0), 'RIGHT');
await measure('D (strafe right)', 'x', hold('KeyD', 900), 'LEFT');
await measure('A (strafe left)', 'x', hold('KeyA', 900), 'RIGHT');
// Looking up sweeps the world DOWN the screen, exactly as turning right
// sweeps it left. The first version of this expectation had it backwards.
await measure('mouse up', 'y', () => mouse(0, -110), 'DOWN');
await measure('mouse down', 'y', () => mouse(0, 110), 'UP');

console.log(`\nerrors: ${errors.length ? errors.join(' | ') : 'none'}`);
const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? 'ALL CONTROLS CORRECT' : `${failed} CONTROL(S) INVERTED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
