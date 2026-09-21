/**
 * End-to-end check: can a joining survivor move?
 *
 * The bug this pins down was invisible to the host. A client's match begins on
 * a network message rather than a click, so the browser refuses the pointer
 * lock that follows, and input that was gated on the lock never left the
 * machine. The host, whose start *is* a click, was unaffected — which is why
 * "I could move as the ghost" and "the survivor is frozen" were the same bug.
 *
 * So the assertion is deliberately narrow: drive the join with the keyboard
 * while unlocked, and require the host's authoritative state to show the
 * survivor somewhere else. Reading the host's view, not the client's, is the
 * point — it proves the intent actually crossed the wire.
 *
 * Run: node tools/e2e-multiplayer.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.MH_URL ?? 'http://localhost:4173/';
const dist = (x, y) => Math.hypot(x.x - y.x, x.z - y.z);

const log = (...a) => console.log(...a);
let failures = 0;
function check(name, ok, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 650 } });
  const hostPage = await ctx.newPage();
  const joinPage = await ctx.newPage();

  // Collect console errors from the joining client; 404s and unhandled
  // rejections both showed up here in the original report.
  const joinErrors = [];
  joinPage.on('console', (m) => { if (m.type() === 'error') joinErrors.push(m.text()); });
  joinPage.on('pageerror', (e) => joinErrors.push(String(e)));

  // --- Host a room -------------------------------------------------------
  await hostPage.goto(URL, { waitUntil: 'load' });
  await hostPage.click('#mp-host');
  await hostPage.waitForSelector('#lobby', { state: 'visible', timeout: 30000 });
  await hostPage.waitForFunction(
    () => /^[A-Z0-9]{6}$/.test(document.getElementById('lobby-code')?.textContent?.trim() ?? ''),
    null, { timeout: 30000 },
  );
  const code = (await hostPage.textContent('#lobby-code')).trim();
  check('host got a room code', /^[A-Z0-9]{6}$/.test(code), code);

  // The host takes the ghost so the joining player is a survivor.
  await hostPage.click('#pick-ghost');

  // --- Join --------------------------------------------------------------
  await joinPage.goto(URL, { waitUntil: 'load' });
  await joinPage.click('#mp-join');
  await joinPage.fill('#join-code', code);
  await joinPage.click('#join-go');
  await joinPage.waitForSelector('#lobby', { state: 'visible', timeout: 30000 });
  await joinPage.click('#pick-survivor');

  await hostPage.waitForFunction(
    () => document.querySelectorAll('#lobby-players li').length >= 2,
    null, { timeout: 30000 },
  );
  check('both players in the lobby', true);

  // --- Start -------------------------------------------------------------
  await hostPage.click('#lobby-start');
  await joinPage.waitForFunction(() => window.__mh?.state != null, null, { timeout: 30000 });
  await hostPage.waitForFunction(() => window.__mh?.state != null, null, { timeout: 30000 });

  const joinRole = await joinPage.evaluate(() => window.__mh.role);
  const joinNet = await joinPage.evaluate(() => window.__mh.net);
  const selfId = await joinPage.evaluate(() => window.__mh.selfId);
  check('joiner is a survivor client', joinRole === 'survivor' && joinNet === 'client',
    `role=${joinRole} net=${joinNet} id=${selfId}`);

  /*
   * Force the condition that caused the bug.
   *
   * Headless Chromium hands out pointer lock without insisting on a user
   * gesture, so it cannot reproduce a real browser's refusal on its own.
   * Dropping the lock deliberately reproduces the state a real joining client
   * is stuck in, and makes this a stronger check than the original bug: input
   * must survive not merely starting unlocked, but being unlocked at all.
   */
  await joinPage.evaluate(() => document.exitPointerLock?.());
  await joinPage.waitForTimeout(300);
  const locked = await joinPage.evaluate(() => window.__mh.locked);
  check('joining client is unlocked (the bug condition)', locked === false,
    `locked=${locked}`);

  // Let the head start settle so movement is permitted.
  await joinPage.waitForTimeout(1500);

  const readHostSide = () => hostPage.evaluate((id) => {
    const s = window.__mh.state;
    const v = s.survivors.find((x) => x.id === id);
    return v ? { x: v.pos.x, z: v.pos.z } : null;
  }, selfId);

  const before = await readHostSide();
  check('host can see the joining survivor', before != null, JSON.stringify(before));

  // --- Move, unlocked ----------------------------------------------------
  await joinPage.bringToFront();
  await joinPage.keyboard.down('w');
  await joinPage.waitForTimeout(2000);
  await joinPage.keyboard.up('w');
  await joinPage.waitForTimeout(500);

  const after = await readHostSide();
  const moved = before && after ? dist(before, after) : 0;
  check('survivor moved in the HOST\'s authoritative state', moved > 0.3,
    `moved ${moved.toFixed(3)} units  ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  // --- Look, unlocked ----------------------------------------------------
  /*
   * Turning matters as much as walking. Pointer lock feeds `movementX`, which
   * a client without the lock never receives, so dragging has to carry the
   * view instead — otherwise a joining player walks in whatever direction they
   * happened to spawn facing.
   */
  const yawOf = () => hostPage.evaluate((id) => {
    const v = window.__mh.state.survivors.find((x) => x.id === id);
    return v ? v.yaw : null;
  }, selfId);

  const yawBefore = await yawOf();
  const box = await joinPage.locator('#gl').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await joinPage.mouse.move(cx, cy);
  await joinPage.mouse.down();
  for (let i = 1; i <= 12; i++) await joinPage.mouse.move(cx + i * 18, cy);
  await joinPage.mouse.up();
  await joinPage.waitForTimeout(600);
  const yawAfter = await yawOf();

  const dYaw = (() => {
    let d = (yawAfter - yawBefore) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  })();
  check(`survivor turned by dragging, in the HOST's state`, dYaw > 0.1,
    `yaw ${yawBefore?.toFixed(3)} -> ${yawAfter?.toFixed(3)} (${dYaw.toFixed(3)} rad)`);

  // Dragging must not fire the catch, or the click that starts a turn also
  // spends the one action that decides a match.
  const caughtByDrag = await joinPage.evaluate(() => window.__mh.state.survivors.filter((v) => !v.alive).length);
  check('dragging did not trigger a catch', caughtByDrag === 0, `dead=${caughtByDrag}`);

  // --- The ghost is visible to the survivor ------------------------------
  /*
   * The ghost's body discards every fragment until its texture has decoded,
   * which is the right call for runtime-loaded art — a white slab where a face
   * should be is worse than a moment's wait. It does mean a 404 makes the
   * hunter invisible rather than ugly, and that is exactly what a wrong base
   * path caused on Pages: the survivor was alone in the house with something
   * it could not see.
   *
   * So this checks the uniforms that gate the body, not just that an object
   * exists: `uReady` at 0 is an invisible ghost however correct its position.
   */
  const mats = await joinPage.evaluate(() => window.__mh.ghostMaterials());
  const gated = mats.filter((m) => m.uReady !== null);
  check('ghost body textures decoded on the client',
    gated.length > 0 && gated.every((m) => m.uReady === 1),
    gated.map((m) => `uReady=${m.uReady}`).join(' ') || 'no gated materials found');

  const view = await joinPage.evaluate(() => window.__mh.ghostView());
  check('ghost model is visible to the survivor', view?.visible === true,
    JSON.stringify(view));

  // --- Asset 404s --------------------------------------------------------
  const assetErrors = joinErrors.filter((e) => /ghost\.png|ghost-body\.png|404/.test(e));
  check('no asset 404s on the client', assetErrors.length === 0,
    assetErrors.slice(0, 3).join(' | ') || 'none');

  const lockErrors = joinErrors.filter((e) => /NotAllowedError|pointer lock/i.test(e));
  check('no unhandled pointer-lock rejection', lockErrors.length === 0,
    lockErrors.slice(0, 2).join(' | ') || 'none');

  await joinPage.screenshot({ path: 'e2e-survivor.png' });
  await hostPage.screenshot({ path: 'e2e-host.png' });
} finally {
  await browser.close();
}

log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
