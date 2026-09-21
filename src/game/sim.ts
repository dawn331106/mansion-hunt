import { angleDiff, clamp, dist, mulberry32 } from '../core/vec.js';
import { moveWithCollision, lineOfSight } from './collision.js';
import { GHOST, MATCH, PULSE, SURVIVOR } from './config.js';
import type { Intent } from './intent.js';
import type { HidingSpot, Mansion } from './map.js';
import type { GameState, Ghost, Survivor } from './types.js';

/**
 * The authoritative rules of the hunt.
 *
 * Nothing here draws, plays a sound, or reads the keyboard. One `step` takes
 * the state plus one intent per actor and returns the next state, which is
 * what makes the host-authoritative model work later: the host runs exactly
 * this, and every other machine is drawing its output.
 */

export interface StepEvents {
  /** A survivor was caught this tick — triggers the jumpscare. */
  caught: { survivorId: string; byGhostAt: { x: number; z: number } }[];
  /** Footsteps emitted this tick, for the audio layer to place in space. */
  footsteps: { actorId: string; x: number; z: number; volume: number }[];
  /** The reveal pulse fired this tick. */
  pulsed: boolean;
  /** The key was picked up. */
  keyTaken: { survivorId: string } | null;
  /** A survivor made it out of the gate. */
  escaped: { survivorId: string } | null;
  /** Someone entered or left a hiding spot. */
  hideChanged: { survivorId: string; spotId: string | null }[];
}

function noEvents(): StepEvents {
  return { caught: [], footsteps: [], pulsed: false, keyTaken: null, escaped: null, hideChanged: [] };
}

/** Per-actor step timers, kept outside the state so the state stays plain data. */
const stepClocks = new Map<string, number>();

export function createMatch(
  mansion: Mansion,
  opts: { survivorCount: number; humanRole: 'survivor' | 'ghost'; seed?: number },
): GameState {
  const rng = mulberry32(opts.seed ?? (Math.random() * 1e9) | 0);
  stepClocks.clear();

  const survivors: Survivor[] = [];
  for (let i = 0; i < opts.survivorCount; i++) {
    const spawn = mansion.survivorSpawns[i % mansion.survivorSpawns.length];
    survivors.push({
      id: `s${i}`,
      name: i === 0 && opts.humanRole === 'survivor' ? 'You' : SURVIVOR_NAMES[i % SURVIVOR_NAMES.length],
      role: 'survivor',
      pos: { x: spawn.x, y: 0, z: spawn.z },
      yaw: Math.PI / 2,
      pitch: 0,
      stance: 'stand',
      stamina: SURVIVOR.staminaMax,
      lastSprintAt: -999,
      exhausted: false,
      hidden: null,
      alive: true,
      deathCause: null,
      hasKey: false,
      escaped: false,
      isBot: !(opts.humanRole === 'survivor' && i === 0),
    });
  }

  const ghost: Ghost = {
    id: 'ghost',
    name: opts.humanRole === 'ghost' ? 'You' : 'The Ghost',
    role: 'ghost',
    pos: { x: mansion.ghostSpawn.x, y: 0, z: mansion.ghostSpawn.z },
    yaw: -Math.PI / 2,
    pitch: 0,
    lastCatchAt: -999,
    isBot: opts.humanRole !== 'ghost',
  };

  const spawn = mansion.keySpawns[Math.floor(rng() * mansion.keySpawns.length)];

  return {
    time: 0,
    phase: 'playing',
    result: null,
    survivors,
    ghost,
    pulse: { nextAt: PULSE.interval, visibleUntil: 0, marks: [] },
    key: { x: spawn.x, y: 0.4, z: spawn.z, taken: false },
    exitUnlocked: false,
  };
}

const SURVIVOR_NAMES = ['Ayan', 'Rina', 'Kabir', 'Mitu', 'Shuvo'];

/**
 * Advance the match by `dt` seconds.
 *
 * `intents` is keyed by actor id. Any actor without an intent simply stands
 * still, which is what happens to a disconnected player.
 */
export function step(
  state: GameState,
  mansion: Mansion,
  intents: Map<string, Intent>,
  dt: number,
): StepEvents {
  const ev = noEvents();
  if (state.phase !== 'playing') return ev;

  state.time += dt;

  for (const s of state.survivors) {
    if (!s.alive || s.escaped) continue;
    stepSurvivor(state, mansion, s, intents.get(s.id), dt, ev);
  }

  stepGhost(state, mansion, state.ghost, intents.get(state.ghost.id), dt, ev);
  stepPulse(state, ev);
  resolveEnd(state, mansion);
  return ev;
}

function stepSurvivor(
  state: GameState,
  mansion: Mansion,
  s: Survivor,
  intent: Intent | undefined,
  dt: number,
  ev: StepEvents,
): void {
  if (!intent) return;

  // --- Hidden survivors cannot move; they can only look within their slot
  //     and press interact to climb out. ---
  if (s.hidden) {
    const spot = mansion.hidingSpots.find((h) => h.id === s.hidden!.spotId);
    if (spot) {
      const off = clamp(angleDiff(spot.facing, intent.yaw), -spot.viewHalfAngle, spot.viewHalfAngle);
      s.yaw = spot.facing + off;
      s.pitch = clamp(intent.pitch, -0.7, 0.7);
    }
    // A short lockout stops interact from toggling every frame it is held.
    if (intent.interact && state.time - s.hidden.since > 0.4) {
      s.hidden = null;
      s.stance = 'crouch';
      ev.hideChanged.push({ survivorId: s.id, spotId: null });
    }
    return;
  }

  s.yaw = intent.yaw;
  s.pitch = clamp(intent.pitch, -1.4, 1.4);

  // --- Stance. Crouch is held; you cannot stand up inside low geometry, but
  //     the collision test handles that by simply refusing the move. ---
  s.stance = intent.crouch ? 'crouch' : 'stand';
  const eyeHeight = s.stance === 'crouch' ? SURVIVOR.crouchEyeHeight : SURVIVOR.eyeHeight;

  // --- Stamina. Sprinting is a decision with a cost and a recovery penalty. ---
  const wantsSprint =
    intent.sprint && s.stance === 'stand' && !s.exhausted && s.stamina > 0 &&
    (intent.forward !== 0 || intent.right !== 0);

  let speed: number;
  if (wantsSprint) {
    speed = SURVIVOR.sprintSpeed;
    s.stamina = Math.max(0, s.stamina - SURVIVOR.staminaDrain * dt);
    s.lastSprintAt = state.time;
    if (s.stamina === 0) s.exhausted = true;
  } else {
    speed = s.stance === 'crouch' ? SURVIVOR.crouchSpeed : SURVIVOR.walkSpeed;
    if (state.time - s.lastSprintAt >= SURVIVOR.staminaRegenDelay) {
      s.stamina = Math.min(SURVIVOR.staminaMax, s.stamina + SURVIVOR.staminaRegen * dt);
    }
    if (s.exhausted && s.stamina >= SURVIVOR.staminaRecoveryFloor) s.exhausted = false;
  }

  const moved = applyMove(mansion, s.pos, s.yaw, intent, speed, SURVIVOR.radius, eyeHeight, dt);

  // --- Footsteps. Crouching is nearly silent, which is the whole reason to
  //     accept the speed penalty. ---
  if (moved > 0.001) {
    const interval =
      s.stance === 'crouch' ? 0.85 : wantsSprint ? 0.34 : 0.52;
    const volume =
      s.stance === 'crouch' ? 0.25 : wantsSprint ? 1.0 : 0.7;
    if (tickStepClock(s.id, moved, speed, interval, dt)) {
      ev.footsteps.push({ actorId: s.id, x: s.pos.x, z: s.pos.z, volume });
    }
  }

  if (intent.interact) tryInteract(state, mansion, s, ev);

  // --- Escape. Carrying the key through the gate gets you out. ---
  if (state.exitUnlocked || s.hasKey) {
    const e = mansion.exit;
    if (Math.abs(s.pos.x - e.x) < e.hx + SURVIVOR.radius &&
        Math.abs(s.pos.z - e.z) < e.hz + SURVIVOR.radius) {
      if (s.hasKey) state.exitUnlocked = true;
      s.escaped = true;
      s.hasKey = false;
      ev.escaped = { survivorId: s.id };
    }
  }
}

/** Interact: pick up the key, or enter/leave a hiding spot. */
function tryInteract(state: GameState, mansion: Mansion, s: Survivor, ev: StepEvents): void {
  // The key takes priority — it is the thing you came for.
  if (!state.key.taken) {
    if (dist(s.pos.x, s.pos.z, state.key.x, state.key.z) < SURVIVOR.interactRange) {
      state.key.taken = true;
      s.hasKey = true;
      ev.keyTaken = { survivorId: s.id };
      return;
    }
  }

  const spot = nearestFreeSpot(state, mansion, s.pos.x, s.pos.z);
  if (spot) {
    s.hidden = { spotId: spot.id, since: state.time };
    s.pos.x = spot.x;
    s.pos.z = spot.z;
    s.yaw = spot.facing;
    ev.hideChanged.push({ survivorId: s.id, spotId: spot.id });
  }
}

export function nearestFreeSpot(
  state: GameState,
  mansion: Mansion,
  x: number,
  z: number,
): HidingSpot | null {
  let best: HidingSpot | null = null;
  let bestD: number = SURVIVOR.interactRange;
  for (const h of mansion.hidingSpots) {
    // One body per hiding place.
    if (state.survivors.some((o) => o.hidden?.spotId === h.id)) continue;
    const d = dist(x, z, h.x, h.z);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

function stepGhost(
  state: GameState,
  mansion: Mansion,
  g: Ghost,
  intent: Intent | undefined,
  dt: number,
  ev: StepEvents,
): void {
  if (!intent) return;
  // Looking around is always allowed; it is moving that waits.
  g.yaw = intent.yaw;
  g.pitch = clamp(intent.pitch, -1.4, 1.4);

  // The head start is enforced here rather than in the bot, so a human ghost
  // is held to exactly the same rule.
  if (state.time < MATCH.ghostHeadStart) return;

  const speed = intent.sprint ? GHOST.sprintSpeed : GHOST.walkSpeed;
  const moved = applyMove(mansion, g.pos, g.yaw, intent, speed, GHOST.radius, GHOST.eyeHeight, dt);

  if (moved > 0.001 && tickStepClock(g.id, moved, speed, intent.sprint ? 0.38 : 0.6, dt)) {
    // The ghost's own footfalls are the survivors' warning that it is close.
    ev.footsteps.push({ actorId: g.id, x: g.pos.x, z: g.pos.z, volume: 0.85 });
  }

  if (intent.catch && state.time - g.lastCatchAt >= GHOST.catchCooldown) {
    g.lastCatchAt = state.time;
    const victim = catchTarget(state, mansion, g);
    if (victim) {
      victim.alive = false;
      victim.deathCause = 'caught';
      // A caught carrier drops nothing — the key leaves with them, which is
      // why picking it up is the most dangerous thing a survivor can do.
      victim.hidden = null;
      ev.caught.push({ survivorId: victim.id, byGhostAt: { x: g.pos.x, z: g.pos.z } });
    }
  }
}

/**
 * Who, if anyone, the ghost catches right now.
 *
 * A catch needs range, a facing cone, and line of sight. Hidden survivors are
 * catchable — but only from close range and with the ghost looking straight at
 * the spot, so opening the right almirah is a real action, not an area sweep.
 */
function catchTarget(state: GameState, mansion: Mansion, g: Ghost): Survivor | null {
  let best: Survivor | null = null;
  let bestD = Infinity;

  for (const s of state.survivors) {
    if (!s.alive || s.escaped) continue;
    const d = dist(g.pos.x, g.pos.z, s.pos.x, s.pos.z);
    const range = s.hidden ? SURVIVOR.interactRange : GHOST.catchRange;
    if (d > range) continue;

    const toward = Math.atan2(s.pos.z - g.pos.z, s.pos.x - g.pos.x);
    if (Math.abs(angleDiff(g.yaw, toward)) > GHOST.catchHalfAngle) continue;

    if (!s.hidden && !lineOfSight(mansion, g.pos.x, g.pos.z, s.pos.x, s.pos.z, 1.2)) continue;

    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/**
 * The reveal pulse: every 30s the ghost is shown where everyone *was*.
 *
 * The snapshot is taken at the instant the pulse fires and then shown for
 * three seconds, so those three seconds of running are the counterplay. A live
 * tracker would simply end the round.
 */
function stepPulse(state: GameState, ev: StepEvents): void {
  if (state.time >= state.pulse.nextAt) {
    state.pulse.marks = state.survivors
      .filter((s) => s.alive && !s.escaped)
      .map((s) => ({ survivorId: s.id, x: s.pos.x, z: s.pos.z }));
    state.pulse.visibleUntil = state.time + PULSE.duration;
    state.pulse.nextAt = state.time + PULSE.interval;
    ev.pulsed = true;
  }
  if (state.time > state.pulse.visibleUntil && state.pulse.marks.length > 0) {
    state.pulse.marks = [];
  }
}

/**
 * Decide whether the match is over.
 *
 * Three ways it ends. The key-holder rule is the sharp one: if the ghost
 * catches whoever is carrying the key, the way out is gone and the house keeps
 * everyone — so the key is both the win condition and the biggest liability in
 * the building.
 */
function resolveEnd(state: GameState, _mansion: Mansion): void {
  const active = state.survivors.filter((s) => s.alive && !s.escaped);

  const carrierCaught = state.survivors.find(
    (s) => !s.alive && s.deathCause === 'caught' && state.key.taken && s.hasKey,
  );
  if (carrierCaught) {
    state.phase = 'ghost-won';
    state.result = { phase: 'ghost-won', reason: 'The key went into the dark with its bearer.' };
    return;
  }

  if (state.survivors.every((s) => !s.alive)) {
    state.phase = 'ghost-won';
    state.result = { phase: 'ghost-won', reason: 'Every one of them was caught.' };
    return;
  }

  if (active.length === 0) {
    const anyOut = state.survivors.some((s) => s.escaped);
    state.phase = anyOut ? 'survivors-won' : 'ghost-won';
    state.result = anyOut
      ? { phase: 'survivors-won', reason: 'The gate closed behind the survivors.' }
      : { phase: 'ghost-won', reason: 'Every one of them was caught.' };
    return;
  }

  if (MATCH.timeLimit > 0 && state.time >= MATCH.timeLimit) {
    state.phase = 'ghost-won';
    state.result = { phase: 'ghost-won', reason: 'Dawn never came.' };
  }
}

/** Shared movement integration. Returns the distance actually travelled. */
function applyMove(
  mansion: Mansion,
  pos: { x: number; y: number; z: number },
  yaw: number,
  intent: Intent,
  speed: number,
  radius: number,
  eyeHeight: number,
  dt: number,
): number {
  let fx = intent.forward;
  let rx = intent.right;
  const mag = Math.hypot(fx, rx);
  if (mag < 1e-6) return 0;
  // Normalise so diagonal movement is not faster than straight.
  if (mag > 1) { fx /= mag; rx /= mag; }

  /**
   * Forward is `(cos yaw, sin yaw)`; screen-right is that rotated clockwise,
   * which in this coordinate frame is `(sin yaw, -cos yaw)`.
   *
   * The sign on the strafe term was the other way round, so D slid you left
   * and A slid you right. It went unnoticed because the camera's convention
   * was itself reversed at the time it was written, and the two errors
   * cancelled on screen.
   */
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const dx = (cos * fx + sin * rx) * speed * dt;
  const dz = (sin * fx - cos * rx) * speed * dt;

  const before = { x: pos.x, z: pos.z };
  const next = moveWithCollision(mansion, pos.x, pos.z, dx, dz, radius, eyeHeight);
  pos.x = next.x;
  pos.z = next.z;
  return dist(before.x, before.z, pos.x, pos.z);
}

/**
 * Accumulate distance and report when the next footfall lands.
 *
 * Driven by distance rather than by a wall clock, so a survivor edging forward
 * does not broadcast a full-speed stride.
 */
function tickStepClock(
  id: string,
  moved: number,
  speed: number,
  interval: number,
  _dt: number,
): boolean {
  const strideLength = speed * interval;
  const acc = (stepClocks.get(id) ?? 0) + moved;
  if (acc >= strideLength) {
    stepClocks.set(id, acc - strideLength);
    return true;
  }
  stepClocks.set(id, acc);
  return false;
}
