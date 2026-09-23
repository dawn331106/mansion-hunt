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
import { GameHost } from './net/host.js';
import { GameClient } from './net/client.js';
import { cleanRoomCode, INPUT_HZ, type LobbyState, type NetEvents } from './net/protocol.js';

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
  /** What the ghost is saying right now, shown while it is audible. */
  subtitle: { text: string; until: number } | null;
  /** Local microphone, if the player has granted it. */
  mic: MediaStream | null;

  /**
   * How this session is networked.
   *
   * `solo` runs everything locally, exactly as before. `host` runs the
   * authoritative simulation and broadcasts it. `client` runs no simulation at
   * all and draws what it is sent.
   */
  net: 'solo' | 'host' | 'client';
  /** Set when hosting: which peer drives which actor. */
  assignments: Record<string, string>;
}

const mansion = buildMansion();
let session: Session | null = null;
let rafId = 0;

/** The network objects, which outlive any single match. */
let host: GameHost | null = null;
let client: GameClient | null = null;
/** Accumulates toward the next input packet, for a client. */
let inputAccum = 0;

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

// --- Multiplayer -----------------------------------------------------------

const lobbyScreen = document.getElementById('lobby') as HTMLDivElement;
const joinScreen = document.getElementById('join') as HTMLDivElement;
const lobbyCode = document.getElementById('lobby-code') as HTMLElement;
const lobbyPlayers = document.getElementById('lobby-players') as HTMLUListElement;
const lobbyNote = document.getElementById('lobby-note') as HTMLElement;
const lobbySub = document.getElementById('lobby-sub') as HTMLElement;
const lobbyStart = document.getElementById('lobby-start') as HTMLButtonElement;
const hostSettings = document.getElementById('host-settings') as HTMLElement;
const joinNote = document.getElementById('join-note') as HTMLElement;
const joinInput = document.getElementById('join-code') as HTMLInputElement;
const pickSurvivor = document.getElementById('pick-survivor') as HTMLButtonElement;
const pickGhost = document.getElementById('pick-ghost') as HTMLButtonElement;

/**
 * A name for this player.
 *
 * Remembered across sessions, because typing it every time to play with the
 * same three friends is pure friction. Nothing else is stored, and a browser
 * that refuses local storage just gets a fresh name each time.
 */
function playerName(): string {
  let n = '';
  try { n = localStorage.getItem('mansion-hunt:name') ?? ''; } catch { /* private mode */ }
  if (!n) {
    n = `Player ${Math.floor(Math.random() * 900 + 100)}`;
    try { localStorage.setItem('mansion-hunt:name', n); } catch { /* fine */ }
  }
  return n;
}

document.getElementById('mp-host')!.addEventListener('click', () => void openHost());
document.getElementById('mp-join')!.addEventListener('click', () => {
  menu.style.display = 'none';
  joinScreen.style.display = 'flex';
  joinNote.textContent = '';
  joinInput.value = '';
  joinInput.focus();
});
document.getElementById('join-back')!.addEventListener('click', () => {
  joinScreen.style.display = 'none';
  menu.style.display = 'flex';
});
document.getElementById('join-go')!.addEventListener('click', () => void doJoin());
joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doJoin(); });

document.getElementById('copy-code')!.addEventListener('click', () => {
  void navigator.clipboard?.writeText(lobbyCode.textContent ?? '').then(
    () => { lobbyNote.textContent = 'Code copied.'; },
    () => { lobbyNote.textContent = 'Could not copy — read it out instead.'; },
  );
});

pickSurvivor.addEventListener('click', () => setWants('survivor'));
pickGhost.addEventListener('click', () => setWants('ghost'));

function setWants(role: Role): void {
  pickSurvivor.classList.toggle('on', role === 'survivor');
  pickGhost.classList.toggle('on', role === 'ghost');
  host?.setLocalWants(role);
  client?.sendWants(role);
}

(document.getElementById('lobby-bots') as HTMLSelectElement)
  .addEventListener('change', (e) => {
    host?.setBots(Number((e.target as HTMLSelectElement).value));
  });

document.getElementById('lobby-leave')!.addEventListener('click', () => {
  host?.close(); host = null;
  client?.close(); client = null;
  lobbyScreen.style.display = 'none';
  menu.style.display = 'flex';
});

lobbyStart.addEventListener('click', () => {
  if (!host) return;
  const { assignments, roles, survivorCount, seed } = host.start();
  void start(roles[host.localId] ?? 'ghost', {
    net: 'host',
    survivorCount,
    selfId: assignments[host.localId],
    assignments,
    seed,
  });
});

async function openHost(): Promise<void> {
  menu.style.display = 'none';
  lobbyScreen.style.display = 'flex';
  lobbyNote.textContent = 'Opening the house…';
  setWants('ghost');

  host = new GameHost(
    {
      onLobby: (l) => drawLobby(l, true),
      onError: (m) => { lobbyNote.textContent = m; },
      onStart: () => { /* the click handler starts the match */ },
    },
    playerName(),
    'ghost',
  );

  try {
    await host.open();
    lobbyCode.textContent = host.code;
    lobbyNote.textContent = 'Give that code to the others.';
    drawLobby(host.lobby(), true);
  } catch {
    // `onError` has already said why.
  }
}

async function doJoin(): Promise<void> {
  const code = cleanRoomCode(joinInput.value);
  if (code.length !== 6) {
    joinNote.textContent = 'A room code is six letters and numbers.';
    return;
  }
  joinNote.textContent = 'Looking for that house…';

  client = new GameClient({
    onLobby: (l) => {
      joinScreen.style.display = 'none';
      lobbyScreen.style.display = 'flex';
      drawLobby(l, false);
    },
    onStart: (you, role, survivorCount, seed) => {
      void start(role, { net: 'client', survivorCount, selfId: you, seed });
    },
    onSnapshot: (state, events) => applySnapshot(state, events),
    onError: (m) => { joinNote.textContent = m; lobbyNote.textContent = m; },
    onClosed: (reason) => {
      teardownMatch();
      lobbyScreen.style.display = 'none';
      joinScreen.style.display = 'none';
      menu.style.display = 'flex';
      lobbyNote.textContent = reason;
    },
  });

  try {
    await client.join(code, playerName());
    setWants('survivor');
  } catch {
    client = null;
  }
}

/** Redraw the lobby list. */
function drawLobby(l: LobbyState, isHost: boolean): void {
  lobbyCode.textContent = l.code;
  lobbySub.textContent = isHost
    ? 'Others can join with the code below.'
    : 'Waiting for the host to begin.';
  lobbyStart.style.display = isHost ? '' : 'none';
  hostSettings.style.display = isHost ? '' : 'none';

  lobbyPlayers.innerHTML = '';
  for (const p of l.players) {
    const li = document.createElement('li');

    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('span');
    name.textContent = p.name;
    who.appendChild(name);

    if (p.isHost) {
      const t = document.createElement('span');
      t.className = 'tag host';
      t.textContent = 'host';
      who.appendChild(t);
    }
    const r = document.createElement('span');
    r.className = p.wants === 'ghost' ? 'tag ghost' : 'tag';
    r.textContent = p.wants === 'ghost' ? 'wants ghost' : 'survivor';
    who.appendChild(r);

    const ping = document.createElement('span');
    ping.className = 'ping';
    ping.textContent = p.isHost ? '' : `${p.ping}ms`;

    li.appendChild(who);
    li.appendChild(ping);
    lobbyPlayers.appendChild(li);
  }

  if (isHost) {
    const ghosts = l.players.filter((p) => p.wants === 'ghost').length;
    lobbyNote.textContent = ghosts === 0
      ? 'Nobody wants to be the ghost, so you will be.'
      : ghosts > 1
        ? 'More than one wants the ghost; whoever asked first gets it.'
        : 'Ready when you are.';
  }
}

async function start(
  role: Role,
  opts: {
    net?: 'solo' | 'host' | 'client';
    survivorCount?: number;
    selfId?: string;
    assignments?: Record<string, string>;
    seed?: number;
  } = {},
): Promise<void> {
  // Whatever came before is finished with; release it before building more.
  teardownMatch();

  menu.style.display = 'none';
  endScreen.style.display = 'none';
  pausedNote.style.display = 'none';

  lobbyScreen.style.display = 'none';
  joinScreen.style.display = 'none';

  const net = opts.net ?? 'solo';
  const survivorCount = opts.survivorCount ?? Number(
    (document.getElementById('survivor-count') as HTMLSelectElement).value,
  );
  const wantMic = (document.getElementById('use-mic') as HTMLInputElement).checked;

  lastRole = role;

  resetSurvivorBots();
  resetGhostBot();

  /*
   * Every machine builds the same match from the same seed.
   *
   * A client never simulates, so strictly it only needs the geometry — but
   * building the identical starting state means the key, the spawns and the
   * bots line up with the host's before the first snapshot lands, and there
   * is no visible correction on the first frame.
   */
  const state = createMatch(mansion, { survivorCount, humanRole: role, seed: opts.seed });
  const selfId = opts.selfId ?? (role === 'ghost' ? 'ghost' : state.survivors[0].id);
  const startActor = role === 'ghost'
    ? state.ghost
    : state.survivors.find((v) => v.id === selfId) ?? state.survivors[0];
  const startYaw = startActor.yaw;

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

  session = {
    state, role, selfId, input, renderer, hud, audio,
    toast: null, subtitle: null, mic: null,
    net, assignments: opts.assignments ?? {},
  };

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
  /*
   * The survivors get a theme; the ghost gets the house.
   *
   * Asymmetric on purpose. Music is company, and the survivor's problem is
   * being alone in the dark — a bed under that is a small mercy and a way to
   * feel the match's shape. The ghost's whole advantage is hearing, so giving
   * it a soundtrack would both blunt the role and mask the footsteps it hunts
   * by.
   */
  if (role !== 'ghost') void audio.startMusic();

  resize();
  /*
   * Ask for the pointer, and cope with being told no.
   *
   * For a client this call is not inside a user gesture, so it rejects. That
   * is survivable — `pausedNote` is already a click target that asks again,
   * and this time from a real gesture — but the rejection must be caught, or
   * it surfaces as an unhandled promise error and the overlay never shows.
   */
  input.requestLock();

  last = performance.now();
  accumulator = 0;
  clock = 0;
  endAt = null;
  // The ghost holds its tongue until the head start is over.
  nextTauntAt = 6;
  rafId = requestAnimationFrame(frame);
}

/**
 * Take a snapshot from the host.
 *
 * A client does not simulate, so this is where its world comes from. The
 * state is stored whole and the events are turned into the same sounds and
 * scares the host produces locally — a caught survivor has to hear the roar
 * on their own machine, and no amount of comparing snapshots would tell them
 * exactly when it happened or where the ghost was standing.
 */
function applySnapshot(state: GameState, events: NetEvents): void {
  const s = session;
  if (!s || s.net !== 'client') return;

  s.state = state;

  const listener = listenerPos(s);

  for (const f of events.footsteps) {
    if (f.actorId !== s.selfId) s.audio.footstep(f.x, f.z, f.volume);
  }

  if (events.pulsed && s.role === 'ghost') {
    s.audio.stinger('pulse');
    showToast('Their positions, three seconds ago.');
  }

  if (events.spotted === s.selfId) {
    s.audio.stinger('spotted');
    showToast('It has seen you.');
  }

  if (events.keyTaken) {
    s.audio.stinger('key');
    showToast(events.keyTaken === s.selfId
      ? 'You have the key. Get to the gate.'
      : 'Someone has found the key.');
  }

  for (const h of events.hideChanged) {
    if (h.survivorId === s.selfId) {
      s.audio.stinger(h.spotId ? 'hide' : 'unhide');
      const self = s.state.survivors.find((x) => x.id === s.selfId);
      if (self) s.input.setLook(self.yaw, self.pitch);
    }
  }

  if (events.escaped) {
    s.audio.stinger('escape');
    showToast(events.escaped === s.selfId ? 'You are out.' : 'Someone got out.');
  }

  for (const c of events.caught) {
    if (c.survivorId === s.selfId) {
      s.audio.stinger('jumpscare');
      s.renderer.jumpscare.trigger(new THREE.Vector3(c.x, 1.5, c.z));
    } else {
      const victim = s.state.survivors.find((x) => x.id === c.survivorId);
      showToast(s.role === 'ghost'
        ? `Caught ${victim?.name ?? 'someone'}.`
        : 'One of them is gone.');
    }
  }

  /*
   * The ghost's taunts come from the host.
   *
   * Deciding locally when to speak would have every client choose a different
   * line at a different moment, so the subtitle on your screen would not match
   * the voice you heard. The host picks; everyone plays the same one, placed
   * at the ghost's position so it still fades with distance.
   */
  if (events.taunt) {
    const d = dist(listener.x, listener.z, events.taunt.x, events.taunt.z);
    const said = s.audio.taunt(s.state.time, events.taunt.x, events.taunt.z, 'hunting', d);
    if (said) s.subtitle = { text: events.taunt.text, until: s.state.time + 4.0 };
  }
}

// --- The loop. -----------------------------------------------------------

let last = 0;
let accumulator = 0;
let clock = 0;
/** Sim time the ghost may next say something. */
let nextTauntAt = 0;
/** When the end screen may appear, once the scare has had its moment. */
let endAt: number | null = null;

function frame(now: number): void {
  rafId = requestAnimationFrame(frame);
  if (!session) return;

  const dt = Math.min((now - last) / 1000, MAX_CATCHUP);
  last = now;
  clock += dt;

  const s = session;

  if (s.net === 'client') {
    /*
     * A client simulates nothing.
     *
     * It sends what the player is trying to do and draws the world it is sent,
     * played back slightly behind live so uneven packet arrival does not show
     * as stutter. Nothing here can disagree with the host, because nothing
     * here decides anything.
     */
    inputAccum += dt;
    const period = 1 / INPUT_HZ;
    while (inputAccum >= period) {
      inputAccum -= period;
      /*
       * Send regardless of pointer lock.
       *
       * A client's `start` runs from the host's network message, not from a
       * click, so the browser refuses the pointer lock request that follows it
       * — there is no user gesture to justify it. Gating input on the lock
       * therefore left every joining player unable to move, while the host,
       * whose start *is* a click, was fine. A client simulates nothing, so
       * there is nothing to protect here: the keyboard works unlocked, and
       * only the mouse look needs the lock.
       */
      client?.sendIntent(s.input.read());
    }
    const world = client?.interpolated();
    if (world) s.state = world;
  } else if (s.input.isLocked && s.state.phase === 'playing') {
    // Solo and host both simulate. The game only runs while the pointer is
    // locked, which matters in a game where looking away is a disadvantage.
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
    selfId: s.selfId,
    net: s.net,
    survivors: s.state.survivors.map((v) => ({ id: v.id, pos: { x: v.pos.x, z: v.pos.z } })),
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
    subtitle: s.subtitle,
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

/** The taunt spoken during the current tick, for the host to broadcast. */
let spokenThisTick: { text: string; x: number; z: number } | null = null;

function tick(s: Session, dt: number): void {
  const intents = new Map<string, Intent>();

  // --- The local player. ---
  const playerIntent = s.input.read();
  intents.set(s.selfId, playerIntent);

  /*
   * Remote players first, then bots for whatever is left.
   *
   * The order matters: an actor driven by a person must not also be driven by
   * a bot, or the two fight each other and the body twitches. Taking the
   * network intents first and then only filling the gaps is what keeps that
   * from happening, and it is the whole reason the simulation was written to
   * accept a map of intents rather than to ask each actor what it wants.
   */
  if (s.net === 'host' && host) {
    host.setLocalIntent(playerIntent);
    for (const [actorId, intent] of host.intents(s.assignments)) {
      intents.set(actorId, intent);
    }
  }

  for (const sv of s.state.survivors) {
    if (intents.has(sv.id)) continue;
    if (!sv.alive || sv.escaped) continue;
    intents.set(sv.id, survivorBotIntent(s.state, mansion, sv, dt));
  }
  if (!intents.has('ghost')) {
    intents.set('ghost', ghostBotIntent(s.state, mansion, dt));
  }

  spokenThisTick = null;
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

  /**
   * Being seen.
   *
   * Only the survivor who was spotted hears the shriek — it is their warning,
   * not an announcement to the room — and the ghost gets a quieter cue of its
   * own so a human hunter knows the chase is live.
   */
  if (ev.spotted) {
    if (ev.spotted.survivorId === s.selfId) {
      s.audio.stinger('spotted');
      showToast('It has seen you.');
    } else if (s.role === 'ghost') {
      const seen = s.state.survivors.find((x) => x.id === ev.spotted!.survivorId);
      showToast(`You see ${seen?.name ?? 'someone'}.`);
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

  /**
   * The ghost talks while it hunts.
   *
   * Driven from the same information the audio already has — where the ghost
   * is and how far away the listener is — so it behaves exactly like a
   * footstep: placed in space, louder and rougher when near, inaudible far
   * off. What it says depends on what it is doing, which makes the line
   * itself a piece of information rather than just noise.
   *
   * It is silent while a scare is running; the roar owns that moment.
   */
  if (!s.renderer.jumpscare.active) {
    const g = s.state.ghost;
    const listenDist = dist(listener.x, listener.z, g.pos.x, g.pos.z);

    const chasing = s.state.time - g.lastSawAt <= GHOST.chaseMemory;
    const mood = chasing ? 'spotted'
      : listenDist < 9 ? 'close'
      : s.state.key.taken || s.state.survivors.some((v) => !v.alive) ? 'gloat'
      : 'hunting';

    // Speak more often when close and during a chase; rarely when idling far
    // away, or the ghost becomes a chatterbox rather than a presence.
    // Out of earshot the engine retries quickly on its own, so this gap only
    // governs how often the ghost speaks when someone can actually hear it.
    const gap = chasing ? 4.5 : listenDist < 12 ? 6 : 9;
    if (s.state.time >= nextTauntAt && s.audio.tauntBusyFor(s.state.time) === 0) {
      const said = s.audio.taunt(s.state.time, g.pos.x, g.pos.z, mood, listenDist);
      // Only spend the full interval on a line someone actually heard. Out of
      // earshot the engine has already set a short retry of its own.
      nextTauntAt = said
        ? s.state.time + gap + Math.random() * gap * 0.7
        : s.state.time + 1.2;
      if (said) {
        s.subtitle = { text: said, until: s.state.time + 4.0 };
        // Hosts pass the line on, so everyone hears and reads the same one.
        spokenThisTick = { text: said, x: g.pos.x, z: g.pos.z };
      }
    }
  }

  /*
   * Send the world on.
   *
   * At the end of the tick, so the snapshot carries the state the events
   * describe rather than the one before them. The host rate-limits this
   * internally; calling it every tick is correct and cheap.
   */
  if (s.net === 'host' && host) {
    host.maybeSnapshot(dt, s.state, toNetEvents(ev, spokenThisTick));
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
/**
 * Mirror the simulation's events onto the wire.
 *
 * Only the host produces these. A snapshot carries state, and state alone
 * cannot say when something happened or where — a client could infer from two
 * snapshots that a survivor died, but not the instant, and the jumpscare has
 * to fire on the frame it happened.
 */
function toNetEvents(ev: ReturnType<typeof step>, taunt: { text: string; x: number; z: number } | null): NetEvents {
  return {
    caught: ev.caught.map((c) => ({ survivorId: c.survivorId, x: c.byGhostAt.x, z: c.byGhostAt.z })),
    footsteps: ev.footsteps.map((f) => ({ actorId: f.actorId, x: f.x, z: f.z, volume: f.volume })),
    pulsed: ev.pulsed,
    keyTaken: ev.keyTaken?.survivorId ?? null,
    escaped: ev.escaped?.survivorId ?? null,
    hideChanged: ev.hideChanged.map((h) => ({ survivorId: h.survivorId, spotId: h.spotId })),
    spotted: ev.spotted?.survivorId ?? null,
    taunt,
  };
}

/** Tear down the current match, leaving any lobby connection intact. */
function teardownMatch(): void {
  teardown();
}

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

/*
 * A read-only window onto the session, for automated tests.
 *
 * End-to-end tests need to assert on what the simulation believes — that a
 * joining survivor actually moved, say — and the alternative is scraping
 * pixels, which is both slow and fragile. This exposes nothing that is not
 * already on screen and takes no input, so it cannot change how the game
 * plays.
 */
(window as unknown as Record<string, unknown>).__mh = {
  get state() { return session?.state ?? null; },
  get selfId() { return session?.selfId ?? null; },
  get role() { return session?.role ?? null; },
  get net() { return session?.net ?? null; },
  get locked() { return session?.input.isLocked ?? false; },
  /** Every material under the ghost, with the uniforms that can hide it. */
  ghostMaterials() {
    if (!session) return null;
    const o = (session.renderer as unknown as { ghostModel: { object: { traverse(f: (n: unknown) => void): void } } }).ghostModel.object;
    const out: unknown[] = [];
    o.traverse((n: unknown) => {
      const node = n as {
        type?: string; visible?: boolean; name?: string;
        material?: {
          uniforms?: Record<string, { value: unknown }>;
          userData?: { uniforms?: Record<string, { value: unknown }> };
          opacity?: number; transparent?: boolean;
        };
      };
      if (!node.material) return;
      const u = node.material.uniforms ?? node.material.userData?.uniforms ?? {};
      out.push({
        type: node.type, visible: node.visible,
        uReady: (u.uReady?.value as number) ?? null,
        uHasMap: (u.uHasMap?.value as number) ?? null,
        uPresence: (u.uPresence?.value as number) ?? null,
        hasMapTex: u.uMap ? u.uMap.value !== null : null,
        opacity: node.material.opacity ?? null,
      });
    });
    return out;
  },
  /** What the renderer currently believes about the ghost, for tests. */
  ghostView() {
    if (!session) return null;
    const o = (session.renderer as unknown as { ghostModel: { object: { visible: boolean; position: { x: number; y: number; z: number } } } }).ghostModel.object;
    const g = session.state.ghost;
    return {
      visible: o.visible,
      render: { x: o.position.x, y: o.position.y, z: o.position.z },
      sim: { x: g.pos.x, z: g.pos.z },
    };
  },
  self() {
    if (!session) return null;
    const st = session.state;
    return session.selfId === 'ghost'
      ? st.ghost
      : st.survivors.find((v) => v.id === session!.selfId) ?? null;
  },
};

window.addEventListener('resize', resize);

// Clicking the paused overlay takes the pointer back.
pausedNote.addEventListener('click', () => session?.input.requestLock());
