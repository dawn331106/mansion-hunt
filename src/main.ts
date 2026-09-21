import * as THREE from 'three';
import { ghostBotHears, ghostBotIntent, ghostBotSeesPulse, resetGhostBot } from './ai/ghostBot.js';
import { resetSurvivorBots, survivorBotIntent } from './ai/survivorBot.js';
import { AudioEngine } from './audio/engine.js';
import { dist } from './core/vec.js';
import { GHOST, SURVIVOR } from './game/config.js';
import { InputController } from './game/input.js';
import type { Intent } from './game/intent.js';

import { buildMansion } from './game/map.js';
import { createMatch, nearestFreeSpot, step } from './game/sim.js';
import type { GameState, Role } from './game/types.js';
import { Renderer } from './render/renderer.js';
import { Hud, type HudState } from './ui/hud.js';

/**
 * The game loop.
 *
 * Fixed-timestep simulation with a rendered interpolation-free present: the
 * sim runs at a steady 60Hz regardless of frame rate, which matters because
 * this will become host-authoritative multiplayer, and a simulation whose
 * results depend on the host's frame rate cannot be replicated.
 */

const TICK = 1 / 60;
/** Never simulate more than this much in one frame, or a stall spirals. */
const MAX_CATCHUP = 0.25;

interface Session {
  state: GameState;
  role: Role;
  /** Which actor the local player controls. */
  selfId: string;
  input: InputController;
  renderer: Renderer;
  hud: Hud;
  audio: AudioEngine;
  toast: { text: string; until: number } | null;
  /** Local microphone, if the player has granted it. */
  mic: MediaStream | null;
}

const mansion = buildMansion();
let session: Session | null = null;
let rafId = 0;

// --- Boot. ---------------------------------------------------------------

const menu = document.getElementById('menu') as HTMLDivElement;
const endScreen = document.getElementById('end') as HTMLDivElement;
const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const pausedNote = document.getElementById('paused') as HTMLDivElement;

document.getElementById('play-survivor')!.addEventListener('click', () => start('survivor'));
document.getElementById('play-ghost')!.addEventListener('click', () => start('ghost'));
/**
 * "Again" replays the same role immediately; "Change role" goes back.
 *
 * Someone who has just been caught wants to be back in the house, not reading
 * a menu they have already read. The role they were last playing is the one
 * they want again, so that is what the button does.
 */
document.getElementById('play-again')!.addEventListener('click', () => {
  void start(lastRole);
});
document.getElementById('back-to-menu')!.addEventListener('click', () => {
  endScreen.style.display = 'none';
  menu.style.display = 'flex';
});

/** The role to replay when "Again" is pressed. */
let lastRole: Role = 'survivor';

async function start(role: Role): Promise<void> {
  // Whatever came before is finished with; release it before building more.
  teardown();

  menu.style.display = 'none';
  endScreen.style.display = 'none';
  pausedNote.style.display = 'none';

  const survivorCount = Number(
    (document.getElementById('survivor-count') as HTMLSelectElement).value,
  );
  const wantMic = (document.getElementById('use-mic') as HTMLInputElement).checked;

  lastRole = role;

  resetSurvivorBots();
  resetGhostBot();

  const state = createMatch(mansion, { survivorCount, humanRole: role });
  const selfId = role === 'ghost' ? 'ghost' : state.survivors[0].id;
  const startYaw = role === 'ghost' ? state.ghost.yaw : state.survivors[0].yaw;

  /**
   * Audio must never be able to stop the game starting.
   *
   * `resume()` waits on the browser, and a context that stays suspended — no
   * gesture credited, a device that fails to open, an autoplay policy that
   * disagrees — leaves the await pending forever and the match never begins.
   * A silent game is a bad outcome; a game that hangs on a black screen is a
   * much worse one, so this proceeds either way.
   */
  const audio = new AudioEngine();
  await Promise.race([
    audio.resume().catch(() => { /* play on in silence */ }),
    new Promise((r) => setTimeout(r, 1500)),
  ]);

  const renderer = new Renderer(glCanvas, mansion);
  const hud = new Hud(hudCanvas);
  const input = new InputController(glCanvas, startYaw);

  input.onLockChanged = (locked) => {
    pausedNote.style.display = locked ? 'none' : 'flex';
  };

  session = { state, role, selfId, input, renderer, hud, audio, toast: null, mic: null };

  // --- Microphone. Only the ghost's voice is transformed, but a survivor's
  //     mic is still worth opening so the loopback can be tested locally. ---
  if (wantMic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      session.mic = mic;
      // Locally, hearing your own ghost voice is the only way to know the
      // effect is working before there is anyone to talk to. Placed at the
      // ghost's own position, so it moves with you.
      if (role === 'ghost') await audio.addVoice('self-ghost', mic, true);
    } catch {
      showToast('Microphone unavailable — voice is off.');
    }
  }

  audio.startAmbience();

  resize();
  input.requestLock();

  last = performance.now();
  accumulator = 0;
  clock = 0;
  endAt = null;
  rafId = requestAnimationFrame(frame);
}

// --- The loop. -----------------------------------------------------------

let last = 0;
let accumulator = 0;
let clock = 0;
/** When the end screen may appear, once the scare has had its moment. */
let endAt: number | null = null;

function frame(now: number): void {
  rafId = requestAnimationFrame(frame);
  if (!session) return;

  const dt = Math.min((now - last) / 1000, MAX_CATCHUP);
  last = now;
  clock += dt;

  const s = session;

  // The game only runs while the pointer is locked. Losing lock is a pause,
  // which matters in a game where looking away is a tactical disadvantage.
  if (s.input.isLocked && s.state.phase === 'playing') {
    accumulator += dt;
    while (accumulator >= TICK) {
      tick(s, TICK);
      accumulator -= TICK;
    }
  }

  // --- Draw. Rendering continues while paused, so the world is still there
  //     behind the overlay rather than frozen to black. ---
  s.renderer.render(s.state, s.role, s.selfId, dt, clock);

  // A small window onto the running match, for the browser test harness and
  // for debugging a build in the wild. Read-only; nothing depends on it.
  (window as unknown as { __match: unknown }).__match = {
    time: s.state.time,
    phase: s.state.phase,
    role: s.role,
    self: s.state.survivors.find((x) => x.id === s.selfId) ?? null,
    ghost: { x: s.state.ghost.pos.x, z: s.state.ghost.pos.z },
    camera: s.renderer.camera.position.toArray(),
    /**
     * Where a fixed world point lands on screen, in normalised device
     * coordinates (-1 = left edge, +1 = right edge).
     *
     * This is what `tools/controls.mjs` measures. Checking yaw numbers or
     * camera vectors is what let the mouse and strafe controls invert each
     * other repeatedly; the only question that matters is which way the
     * picture moves, and this answers it directly rather than by trying to
     * track features through a very dark image.
     */
    probe: s.renderer.projectProbe(),
  };

  const self = s.state.survivors.find((x) => x.id === s.selfId) ?? null;
  const hudState: HudState = {
    role: s.role,
    self,
    prompt: promptFor(s),
    toast: s.toast,
    catchReady: s.role === 'ghost' && s.state.time - s.state.ghost.lastCatchAt >= GHOST.catchCooldown,
  };
  s.hud.draw(s.state, hudState, window.innerWidth, window.innerHeight);

  /**
   * End the match — but never on top of a jumpscare.
   *
   * Catching the last survivor ends the match on the same tick the scare
   * begins, so tearing down here would destroy the renderer mid-lunge and the
   * most important scare in the game — the one that loses it — would never
   * play. The end screen can wait a second and a half.
   */
  if (s.state.phase !== 'playing' && !s.renderer.jumpscare.active) {
    // A short beat after the scare before the screen changes, so the cut to
    // black lands as part of the scare rather than interrupting it.
    endAt = endAt ?? clock + 0.45;
    if (clock >= endAt) { endAt = null; finish(s); }
  }
}

function tick(s: Session, dt: number): void {
  const intents = new Map<string, Intent>();

  // --- The local player. ---
  const playerIntent = s.input.read();
  intents.set(s.selfId, playerIntent);

  // --- Everyone else is a bot. ---
  for (const sv of s.state.survivors) {
    if (sv.id === s.selfId) continue;
    if (!sv.alive || sv.escaped) continue;
    intents.set(sv.id, survivorBotIntent(s.state, mansion, sv, dt));
  }
  if (s.role !== 'ghost') {
    intents.set('ghost', ghostBotIntent(s.state, mansion, dt));
  }

  const ev = step(s.state, mansion, intents, dt);


  // --- Turn simulation events into sound and feedback. ---
  const listener = listenerPos(s);

  for (const f of ev.footsteps) {
    // You never hear your own footsteps positionally — they would sit in the
    // middle of your head and drown out everyone else's.
    if (f.actorId !== s.selfId) {
      s.audio.footstep(f.x, f.z, f.volume);
    }
    // The ghost bot hears exactly what a human ghost would.
    if (s.role !== 'ghost' && f.actorId !== 'ghost') {
      ghostBotHears(s.state, f.x, f.z, f.volume);
    }
  }

  if (ev.pulsed) {
    // Only the ghost is told. Survivors get no warning that they were seen,
    // which is what makes the reveal frightening rather than merely fair.
    if (s.role === 'ghost') {
      s.audio.stinger('pulse');
      showToast('Their positions, three seconds ago.');
    } else {
      ghostBotSeesPulse(s.state);
    }
  }

  if (ev.keyTaken) {
    s.audio.stinger('key');
    showToast(
      ev.keyTaken.survivorId === s.selfId
        ? 'You have the key. Get to the gate.'
        : 'Someone has found the key.',
    );
  }

  for (const h of ev.hideChanged) {
    if (h.survivorId === s.selfId) {
      s.audio.stinger(h.spotId ? 'hide' : 'unhide');
      // A hidden player's look is clamped by the sim; keep the input in sync
      // so climbing out does not snap the view somewhere unexpected.
      const self = s.state.survivors.find((x) => x.id === s.selfId);
      if (self) s.input.setLook(self.yaw, self.pitch);
    }
  }

  if (ev.escaped) {
    s.audio.stinger('escape');
    showToast(ev.escaped.survivorId === s.selfId ? 'You are out.' : 'Someone got out.');
  }

  for (const c of ev.caught) {
    if (c.survivorId === s.selfId) {
      // The scare only fires for the person it happened to.
      s.audio.stinger('jumpscare');
      s.renderer.jumpscare.trigger(new THREE.Vector3(c.byGhostAt.x, 1.5, c.byGhostAt.z));
    } else {
      const victim = s.state.survivors.find((x) => x.id === c.survivorId);
      showToast(s.role === 'ghost' ? `Caught ${victim?.name ?? 'someone'}.` : 'One of them is gone.');
    }
  }

  /**
   * Let the house react to the hunt.
   *
   * The ambient bed darkens as the ghost closes in, which gives survivors a
   * sense of danger that is felt rather than displayed — there is no map and
   * no indicator, so this is the only warning the game offers besides
   * footsteps. For the ghost it tracks its own nearest quarry instead, so the
   * music tightens as it closes rather than going flat.
   */
  {
    const g = s.state.ghost;
    let nearest = Infinity;
    if (s.role === 'ghost') {
      for (const v of s.state.survivors) {
        if (!v.alive || v.escaped || v.hidden) continue;
        nearest = Math.min(nearest, dist(g.pos.x, g.pos.z, v.pos.x, v.pos.z));
      }
    } else {
      const self = s.state.survivors.find((x) => x.id === s.selfId);
      if (self && self.alive) nearest = dist(g.pos.x, g.pos.z, self.pos.x, self.pos.z);
    }
    // Full dread inside 4m, nothing beyond 22m.
    const dread = Number.isFinite(nearest)
      ? Math.max(0, Math.min(1, 1 - (nearest - 4) / 18))
      : 0;
    s.audio.setDread(dread);
  }

  // --- Spatial audio: move the listener and any live voices. ---
  s.audio.setListener(listener.x, listener.y, listener.z, listener.yaw, listener.pitch);
  if (s.mic && s.role === 'ghost') {
    const g = s.state.ghost;
    s.audio.moveVoice('self-ghost', g.pos.x, GHOST.eyeHeight, g.pos.z, 0);
  }
}

/** Where the local player's ears are. */
function listenerPos(s: Session): { x: number; y: number; z: number; yaw: number; pitch: number } {
  if (s.role === 'ghost') {
    const g = s.state.ghost;
    return { x: g.pos.x, y: GHOST.eyeHeight, z: g.pos.z, yaw: g.yaw, pitch: g.pitch };
  }
  const self = s.state.survivors.find((x) => x.id === s.selfId);
  if (!self) return { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  const eye = self.stance === 'crouch' ? SURVIVOR.crouchEyeHeight : SURVIVOR.eyeHeight;
  return { x: self.pos.x, y: eye, z: self.pos.z, yaw: self.yaw, pitch: self.pitch };
}

/** What pressing E would do, given where the player is standing. */
function promptFor(s: Session): string | null {
  if (s.role === 'ghost') return null;
  const self = s.state.survivors.find((x) => x.id === s.selfId);
  if (!self || !self.alive || self.escaped) return null;
  if (self.hidden) return null;

  if (!s.state.key.taken &&
      dist(self.pos.x, self.pos.z, s.state.key.x, s.state.key.z) < SURVIVOR.interactRange) {
    return 'E — take the key';
  }
  const spot = nearestFreeSpot(s.state, mansion, self.pos.x, self.pos.z);
  if (spot) return spot.kind === 'almirah' ? 'E — hide inside' : 'E — crawl under';

  if (self.hasKey &&
      Math.abs(self.pos.x - mansion.exit.x) < 4 && Math.abs(self.pos.z - mansion.exit.z) < 4) {
    return 'the gate — go';
  }
  return null;
}

function showToast(text: string): void {
  if (!session) return;
  session.toast = { text, until: session.state.time + 3.2 };
}

/**
 * End the match and show the result.
 *
 * This tears the session down completely rather than merely showing a screen
 * over it. Leaving the loop running was what broke restarting: the finished
 * state is still `!== 'playing'`, so the next frame called `finish` again and
 * put the end screen straight back over the menu the player had just asked
 * for. Stopping the loop here is what makes "Again" possible at all.
 */
function finish(s: Session): void {
  document.exitPointerLock();

  const won =
    s.role === 'ghost' ? s.state.phase === 'ghost-won' : s.state.phase === 'survivors-won';

  (document.getElementById('end-title') as HTMLElement).textContent =
    won ? 'You win' : 'You lose';
  (document.getElementById('end-title') as HTMLElement).className = won ? 'win' : 'lose';
  (document.getElementById('end-reason') as HTMLElement).textContent =
    s.state.result?.reason ?? '';

  endScreen.style.display = 'flex';
  pausedNote.style.display = 'none';

  teardown();
}

/**
 * Release everything the current session holds.
 *
 * The renderer owns a WebGL context and the audio engine owns an AudioContext,
 * and browsers allow only a handful of each. Starting a second match without
 * releasing the first leaks both, so after a few rounds the page simply stops
 * being able to draw or make a sound.
 */
function teardown(): void {
  cancelAnimationFrame(rafId);
  rafId = 0;
  const s = session;
  session = null;
  if (!s) return;

  s.input.dispose();
  s.mic?.getTracks().forEach((t) => t.stop());
  s.renderer.dispose();
  void s.audio.close();
}

// --- Window plumbing. ----------------------------------------------------

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (session) {
    session.renderer.resize(w, h);
    session.hud.resize(w, h, Math.min(window.devicePixelRatio, 2));
  }
}

window.addEventListener('resize', resize);

// Clicking the paused overlay takes the pointer back.
pausedNote.addEventListener('click', () => session?.input.requestLock());
