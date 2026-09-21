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
document.getElementById('play-again')!.addEventListener('click', () => {
  endScreen.style.display = 'none';
  menu.style.display = 'flex';
});

async function start(role: Role): Promise<void> {
  menu.style.display = 'none';
  endScreen.style.display = 'none';

  const survivorCount = Number(
    (document.getElementById('survivor-count') as HTMLSelectElement).value,
  );
  const wantMic = (document.getElementById('use-mic') as HTMLInputElement).checked;

  resetSurvivorBots();
  resetGhostBot();

  const state = createMatch(mansion, { survivorCount, humanRole: role });
  const selfId = role === 'ghost' ? 'ghost' : state.survivors[0].id;
  const startYaw = role === 'ghost' ? state.ghost.yaw : state.survivors[0].yaw;

  const audio = new AudioEngine();
  await audio.resume();

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

  resize();
  input.requestLock();

  last = performance.now();
  accumulator = 0;
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(frame);
}

// --- The loop. -----------------------------------------------------------

let last = 0;
let accumulator = 0;
let clock = 0;

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

  const self = s.state.survivors.find((x) => x.id === s.selfId) ?? null;
  const hudState: HudState = {
    role: s.role,
    self,
    prompt: promptFor(s),
    toast: s.toast,
    catchReady: s.role === 'ghost' && s.state.time - s.state.ghost.lastCatchAt >= GHOST.catchCooldown,
  };
  s.hud.draw(s.state, hudState, window.innerWidth, window.innerHeight);

  if (s.state.phase !== 'playing') finish(s);
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

function finish(s: Session): void {
  if (endScreen.style.display === 'flex') return;
  document.exitPointerLock();

  const won =
    s.role === 'ghost' ? s.state.phase === 'ghost-won' : s.state.phase === 'survivors-won';

  (document.getElementById('end-title') as HTMLElement).textContent =
    won ? 'You win' : 'You lose';
  (document.getElementById('end-title') as HTMLElement).className = won ? 'win' : 'lose';
  (document.getElementById('end-reason') as HTMLElement).textContent =
    s.state.result?.reason ?? '';

  endScreen.style.display = 'flex';

  s.input.dispose();
  s.mic?.getTracks().forEach((t) => t.stop());
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
