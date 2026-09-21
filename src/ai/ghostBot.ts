import { angleDiff, dist, rotateToward } from '../core/vec.js';
import { lineOfSight } from '../game/collision.js';
import { GHOST } from '../game/config.js';
import type { Intent } from '../game/intent.js';
import { emptyIntent } from '../game/intent.js';
import type { Mansion } from '../game/map.js';
import { buildNavGrid, PathFollower, type NavGrid } from './navigate.js';
import type { GameState, Survivor } from '../game/types.js';

/**
 * A ghost bot: patrol, chase what it can see, and search hiding spots.
 *
 * The hard part of a hunter bot is not catching people — with a speed edge and
 * a reveal pulse that is trivial. It is being *beatable* in a way that feels
 * earned. So this ghost has the same information a human ghost has and no
 * more: it sees what is in front of it, it hears footsteps within a radius,
 * and it gets the pulse. It does not know where hidden survivors are; it
 * checks hiding spots on suspicion, which is exactly the tension the design
 * wants — you hear it open the almirah next to yours.
 */

type Mode = 'patrol' | 'chase' | 'investigate' | 'search-spots';

interface GhostMemory {
  mode: Mode;
  target: { x: number; z: number } | null;
  /** Who it is currently chasing. */
  chasing: string | null;
  /** Sim time the chase target was last actually seen. */
  lastSeenAt: number;
  /** A noise worth walking toward. */
  suspicion: { x: number; z: number; at: number } | null;
  /** Hiding spots already opened this sweep. */
  checked: Set<string>;
  nextDecisionAt: number;
  /** Sim time it may next try a catch, above the rules cooldown. */
  nextCatchAt: number;
  /** Walks the route to whatever target the mode picked. */
  nav: PathFollower;
}

let mem: GhostMemory = freshMemory();

/** The shared walkable grid, built once for the map. */
let grid: NavGrid | null = null;

function freshMemory(): GhostMemory {
  return {
    mode: 'patrol', target: null, chasing: null, lastSeenAt: -999,
    suspicion: null, checked: new Set(), nextDecisionAt: 0, nextCatchAt: 0,
    nav: new PathFollower(),
  };
}

export function resetGhostBot(): void {
  mem = freshMemory();
  grid = null;
}

/**
 * The ghost's senses.
 *
 * These were tuned wide — a 20m sight range and 12m hearing in a 36x30 house —
 * and the result was a bot that caught all three survivors in about 40 seconds,
 * before anyone had finished searching a second room. The key was found in
 * fewer than half of all matches, which means the objective was decorative.
 *
 * A hunter should be frightening, not inevitable. These numbers give it a
 * genuine advantage in a straight line of sight while leaving the house big
 * enough to search: roughly a room and a half of vision, and hearing that
 * reaches the next room but not the one beyond it.
 */
const FOV_HALF = 1.0;
const SIGHT_RANGE = 17;
/** Footsteps within this radius register as a direction to investigate. */
const HEARING_RANGE = 10;
/** Give up a chase this long after losing sight. */
const CHASE_MEMORY = 3.0;

/**
 * Report a footstep the ghost may have heard.
 *
 * Called by the game loop from the sim's footstep events, so the bot hears
 * exactly what a human ghost would hear through the positional audio.
 */
export function ghostBotHears(state: GameState, x: number, z: number, volume: number): void {
  const g = state.ghost;
  const d = dist(g.pos.x, g.pos.z, x, z);
  if (d > HEARING_RANGE * volume) return;
  // A closer or louder noise overrides an older, fainter one.
  if (!mem.suspicion || d < dist(g.pos.x, g.pos.z, mem.suspicion.x, mem.suspicion.z)) {
    mem.suspicion = { x, z, at: state.time };
  }
}

/** Feed the reveal pulse to the bot, so it uses the same tool a human would. */
export function ghostBotSeesPulse(state: GameState): void {
  const g = state.ghost;
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (const mark of state.pulse.marks) {
    const d = dist(g.pos.x, g.pos.z, mark.x, mark.z);
    if (d < bestD) { bestD = d; best = { x: mark.x, z: mark.z }; }
  }
  if (best) {
    mem.suspicion = { x: best.x, z: best.z, at: state.time };
    mem.mode = 'investigate';
    mem.target = best;
    mem.nextDecisionAt = state.time + 1.0;
  }
}

export function ghostBotIntent(state: GameState, mansion: Mansion, dt: number): Intent {
  const g = state.ghost;
  const intent = emptyIntent(g.yaw, 0);

  // --- What can it actually see right now? ---
  const visible = visibleSurvivors(state, mansion);
  if (visible.length > 0) {
    // Chase the closest thing in view, switching targets freely — a ghost
    // that tunnel-visions on one survivor while another walks past is worse
    // at the job and less frightening to play against.
    const nearest = visible.reduce((a, b) =>
      dist(g.pos.x, g.pos.z, a.pos.x, a.pos.z) < dist(g.pos.x, g.pos.z, b.pos.x, b.pos.z) ? a : b);
    mem.chasing = nearest.id;
    mem.lastSeenAt = state.time;
    mem.mode = 'chase';
    mem.target = { x: nearest.pos.x, z: nearest.pos.z };
  }

  if (state.time >= mem.nextDecisionAt) {
    mem.nextDecisionAt = state.time + 0.35;
    if (mem.mode === 'chase' && state.time - mem.lastSeenAt > CHASE_MEMORY) {
      // Lost them. The most likely explanation is that they hid nearby.
      mem.mode = 'search-spots';
      mem.chasing = null;
      mem.checked.clear();
    } else if (mem.mode !== 'chase') {
      if (mem.suspicion && state.time - mem.suspicion.at < 8) {
        mem.mode = 'investigate';
        mem.target = { x: mem.suspicion.x, z: mem.suspicion.z };
      } else if (mem.mode !== 'search-spots' || !mem.target) {
        mem.mode = 'patrol';
        if (!mem.target || reached(g.pos, mem.target)) {
          mem.target = patrolTarget(mansion, g.pos);
        }
      }
    }
  }

  // --- Mode behaviour. ---
  if (mem.mode === 'investigate' && mem.target && reached(g.pos, mem.target)) {
    // Arrived at the noise and found nobody — start opening hiding places.
    mem.mode = 'search-spots';
    mem.checked.clear();
    mem.suspicion = null;
    mem.target = null;
  }

  if (mem.mode === 'search-spots') {
    const spot = nextSpotToCheck(mansion, g.pos);
    if (spot) {
      mem.target = { x: spot.x, z: spot.z };
      // Standing at a hiding place, look at it and try the catch.
      if (dist(g.pos.x, g.pos.z, spot.x, spot.z) < 1.8) {
        mem.checked.add(spot.id);
        if (state.time >= mem.nextCatchAt) {
          intent.catch = true;
          mem.nextCatchAt = state.time + GHOST.catchCooldown;
        }
      }
    } else {
      mem.mode = 'patrol';
      mem.target = patrolTarget(mansion, g.pos);
    }
  }

  // --- Steering: follow a real route. The first version steered straight at
  //     the target and sidestepped on a sine wave when blocked, which pinned
  //     the ghost against the courtyard wall for an entire match. ---
  if (mem.target) {
    if (!grid) grid = buildNavGrid(mansion, GHOST.radius);
    const wp = mem.nav.step(grid, state.time, g.pos.x, g.pos.z, mem.target.x, mem.target.z);
    if (wp) {
      const want = Math.atan2(wp.z - g.pos.z, wp.x - g.pos.x);
      // Turns faster while chasing: a hunter that cannot corner is not scary.
      const turn = (mem.mode === 'chase' ? 5.5 : 3.4) * dt;
      intent.yaw = rotateToward(g.yaw, want, turn);
      const off = Math.abs(angleDiff(intent.yaw, want));
      intent.forward = off < 1.2 ? 1 : 0.4;
    } else {
      mem.target = null;
      mem.nextDecisionAt = 0;
    }
  } else {
    // Idle sweep of the head, so a stationary ghost still looks alive.
    intent.yaw = g.yaw + Math.sin(state.time * 0.7) * 0.4 * dt;
  }

  intent.sprint = mem.mode === 'chase';

  // --- Catch attempt while chasing. ---
  if (mem.mode === 'chase' && mem.chasing && state.time >= mem.nextCatchAt) {
    const victim = state.survivors.find((s) => s.id === mem.chasing);
    if (victim && victim.alive && dist(g.pos.x, g.pos.z, victim.pos.x, victim.pos.z) < GHOST.catchRange * 0.9) {
      intent.catch = true;
      mem.nextCatchAt = state.time + GHOST.catchCooldown;
    }
  }

  return intent;
}

function visibleSurvivors(state: GameState, mansion: Mansion): Survivor[] {
  const g = state.ghost;
  const out: Survivor[] = [];
  for (const s of state.survivors) {
    if (!s.alive || s.escaped) continue;
    // Hidden survivors are invisible. The ghost must open the spot.
    if (s.hidden) continue;
    const d = dist(g.pos.x, g.pos.z, s.pos.x, s.pos.z);
    if (d > SIGHT_RANGE) continue;
    const toward = Math.atan2(s.pos.z - g.pos.z, s.pos.x - g.pos.x);
    if (Math.abs(angleDiff(g.yaw, toward)) > FOV_HALF) continue;
    // Crouched survivors break sight behind low furniture that would not hide
    // someone standing — the sightline is tested at their actual head height.
    const h = s.stance === 'crouch' ? 0.8 : 1.5;
    if (!lineOfSight(mansion, g.pos.x, g.pos.z, s.pos.x, s.pos.z, h)) continue;
    out.push(s);
  }
  return out;
}

function nextSpotToCheck(mansion: Mansion, pos: { x: number; z: number }) {
  let best = null as null | { x: number; z: number; id: string };
  let bestD = 16;
  for (const h of mansion.hidingSpots) {
    if (mem.checked.has(h.id)) continue;
    const d = dist(pos.x, pos.z, h.x, h.z);
    if (d < bestD) { bestD = d; best = { x: h.x, z: h.z, id: h.id }; }
  }
  return best;
}

function patrolTarget(mansion: Mansion, pos: { x: number; z: number }): { x: number; z: number } {
  // Weighted pick: prefer rooms that are not the one it is standing in, so
  // patrol actually covers the house instead of pacing one room.
  const candidates = mansion.rooms.filter((r) => dist(pos.x, pos.z, r.x, r.z) > 5);
  const pool = candidates.length > 0 ? candidates : mansion.rooms;
  const r = pool[Math.floor(Math.random() * pool.length)];
  return { x: r.x + (Math.random() - 0.5) * 4, z: r.z + (Math.random() - 0.5) * 4 };
}

function reached(pos: { x: number; z: number }, t: { x: number; z: number }): boolean {
  return dist(pos.x, pos.z, t.x, t.z) < 1.5;
}
