import { angleDiff, dist, rotateToward } from '../core/vec.js';
import { lineOfSight } from '../game/collision.js';
import { SURVIVOR } from '../game/config.js';
import type { Intent } from '../game/intent.js';
import { emptyIntent } from '../game/intent.js';
import { roomOf, type Mansion } from '../game/map.js';
import { buildNavGrid, PathFollower, type NavGrid } from './navigate.js';

import type { GameState, Survivor } from '../game/types.js';

/**
 * A survivor bot: search for the key, run from the ghost, hide when cornered.
 *
 * It exists so the game is playable and testable alone — as the ghost hunting
 * bots, or as a survivor alongside them. It is deliberately not a perfect
 * player: it panics, it commits to bad hiding spots, and it does not share
 * information with the other bots, because a coordinated hive of optimal
 * survivors is neither fun to hunt nor a fair test of the ghost's tools.
 */

type Mode = 'seek-key' | 'flee' | 'hide' | 'run-for-gate';

interface BotMemory {
  mode: Mode;
  /** Where it is currently walking. */
  target: { x: number; z: number } | null;
  /** Rooms it has already looked in, so it does not loop one room forever. */
  searched: Set<string>;
  /** Individual spots within rooms it has already been to. */
  visited: Set<string>;
  /** Sim time it last saw or heard the ghost. */
  lastThreatAt: number;
  /** Where it last believed the ghost was. */
  threatPos: { x: number; z: number } | null;
  /** Sim time it may next change its mind, to stop per-frame dithering. */
  nextDecisionAt: number;
  /** Walks the route to whatever target the mode picked. */
  nav: PathFollower;
}

const memories = new Map<string, BotMemory>();


/** The shared walkable grid, built once for the map. */
let grid: NavGrid | null = null;

export function resetSurvivorBots(): void {
  memories.clear();
  grid = null;
}

function memoryFor(id: string): BotMemory {
  let m = memories.get(id);
  if (!m) {
    m = {
      mode: 'seek-key', target: null, searched: new Set(), visited: new Set(),
      lastThreatAt: -999, threatPos: null, nextDecisionAt: 0, nav: new PathFollower(),
    };
    memories.set(id, m);
  }
  return m;
}

/**
 * How far a bot hears the ghost through walls.
 *
 * This was 9m, which sounds modest until you notice the house is only 36x30
 * and the ghost patrols constantly: every survivor was permanently alarmed,
 * permanently fleeing, and so never searched a room or found the key. A match
 * could run indefinitely with the objective untouched. Hearing has to be a
 * local warning, not an always-on proximity alarm.
 */
const HEARING_RANGE = 6;
/** How far a bot notices the ghost it can actually see. */
const SIGHT_RANGE = 16;
/** Inside this, being caught is imminent and hiding is no longer an option. */
const PANIC_RANGE = 5;

export function survivorBotIntent(
  state: GameState,
  mansion: Mansion,
  s: Survivor,
  dt: number,
): Intent {
  const m = memoryFor(s.id);
  const intent = emptyIntent(s.yaw, 0);

  // --- Threat assessment. ---
  const g = state.ghost;
  const dg = dist(s.pos.x, s.pos.z, g.pos.x, g.pos.z);
  const canSee = dg < SIGHT_RANGE &&
    lineOfSight(mansion, s.pos.x, s.pos.z, g.pos.x, g.pos.z, 1.4) &&
    Math.abs(angleDiff(s.yaw, Math.atan2(g.pos.z - s.pos.z, g.pos.x - s.pos.x))) < 1.2;
  const canHear = dg < HEARING_RANGE;

  if (canSee || canHear) {
    m.lastThreatAt = state.time;
    m.threatPos = { x: g.pos.x, z: g.pos.z };
  }
  // Alarm decays quickly. A long memory here reads as competence but plays as
  // paralysis: the bot spends the match backing away from a ghost two rooms
  // over instead of doing the one thing that wins.
  const threatened = state.time - m.lastThreatAt < 2.5;

  // --- Hidden bots decide only whether to stay put. ---
  if (s.hidden) {
    /**
     * When to come back out.
     *
     * Bots used to sit in an almirah until the ghost had been quiet, which in
     * a house this small meant most of the match: they hid, waited, hid again,
     * and the key went unfound in three matches out of four. Hiding has to be
     * a way to survive a chase, not a way to sit out the game — so there is a
     * hard ceiling on it regardless of how frightened the bot still is.
     */
    const waited = state.time - s.hidden.since;
    if ((!threatened && waited > 2.5) || waited > 9) {
      intent.interact = true;
    }
    intent.yaw = s.yaw;
    return intent;
  }

  // --- Mode selection, throttled so the bot does not flip every frame. ---
  if (state.time >= m.nextDecisionAt) {
    m.nextDecisionAt = state.time + 0.4;
    m.mode = chooseMode(state, mansion, s, threatened, dg);
  }

  switch (m.mode) {
    case 'run-for-gate':
      m.target = { x: mansion.exit.x, z: mansion.exit.z };
      break;

    case 'flee': {
      // Run directly away from where the threat was last known to be.
      const t = m.threatPos ?? { x: g.pos.x, z: g.pos.z };
      const ax = s.pos.x - t.x, az = s.pos.z - t.z;
      const l = Math.hypot(ax, az) || 1;
      m.target = { x: s.pos.x + (ax / l) * 8, z: s.pos.z + (az / l) * 8 };
      break;
    }

    case 'hide': {
      const spot = nearestHideableSpot(state, mansion, s);
      if (spot) {
        m.target = { x: spot.x, z: spot.z };
        if (dist(s.pos.x, s.pos.z, spot.x, spot.z) < SURVIVOR.interactRange * 0.8) {
          intent.interact = true;
        }
      } else {
        m.mode = 'flee';
      }
      break;
    }

    case 'seek-key': {
      if (!state.key.taken) {
        /**
         * Spotting the key.
         *
         * This used to require line of sight from within six metres, and the
         * result was that bots walked to a room centre, failed to see a key
         * five metres away behind a charpoy, marked the room searched and
         * left — the key was never found in an entire match. A survivor who
         * walks into a room to search it finds what is lying in it, so being
         * in the same room is the test, with a sightline only as a shortcut
         * for spotting it from further off.
         */
        const dk = dist(s.pos.x, s.pos.z, state.key.x, state.key.z);
        const sameRoom = roomOf(mansion, s.pos.x, s.pos.z) ===
          roomOf(mansion, state.key.x, state.key.z);
        /*
         * These radii are in metres and have to track the map. When the house
         * grew from 36x30 to 56x44 the rooms outgrew an 11m "same room"
         * check, so a bot could stand in the right room and still not see the
         * key — the key went unfound in half of all matches and the ghost won
         * two thirds of them for want of an objective.
         */
        const spotted = (sameRoom && dk < 16) ||
          (dk < 11 && lineOfSight(mansion, s.pos.x, s.pos.z, state.key.x, state.key.z, 0.8));

        if (spotted) {
          m.target = { x: state.key.x, z: state.key.z };
          if (dk < SURVIVOR.interactRange * 0.85) intent.interact = true;
        } else if (!m.target || reached(s, m.target)) {
          m.target = nextSearchTarget(mansion, s, m);
        }
      } else if (!m.target || reached(s, m.target)) {
        // Someone else has the key; loiter near the gate but stay mobile.
        m.target = wanderNear(mansion);
      }
      break;
    }
  }

  // --- Steering: follow a real route, not a straight line at the goal. ---
  if (m.target) {
    if (!grid) grid = buildNavGrid(mansion, SURVIVOR.radius);
    const wp = m.nav.step(grid, state.time, s.pos.x, s.pos.z, m.target.x, m.target.z);
    if (wp) {
      const want = Math.atan2(wp.z - s.pos.z, wp.x - s.pos.x);
      intent.yaw = rotateToward(s.yaw, want, 6.0 * dt);
      // Walk once roughly facing the waypoint, so it does not scrape walls
      // while turning, but never stop dead — a bot frozen mid-turn in a
      // chase is just a free catch.
      const off = Math.abs(angleDiff(intent.yaw, want));
      intent.forward = off < 1.2 ? 1 : 0.45;
    } else {
      // Nowhere to go: give up on this target and pick another next tick.
      m.target = null;
      m.nextDecisionAt = 0;
    }
  }

  // Sprint when fleeing and there is stamina to spend.
  intent.sprint = (m.mode === 'flee' || m.mode === 'run-for-gate') && !s.exhausted && s.stamina > 0.4;
  // Move quietly when a threat is near but not yet on top of them.
  intent.crouch = threatened && dg > PANIC_RANGE && dg < HEARING_RANGE && !intent.sprint;

  return intent;
}

function chooseMode(
  state: GameState,
  mansion: Mansion,
  s: Survivor,
  threatened: boolean,
  dg: number,
): Mode {
  if (s.hasKey || state.exitUnlocked) {
    // Carrying the key makes you the match. Get out, unless the ghost is
    // right on top of you — then break away first.
    return threatened && dg < PANIC_RANGE ? 'flee' : 'run-for-gate';
  }
  if (threatened) {
    if (dg < PANIC_RANGE) return 'flee';
    /**
     * Whether to hide rather than run.
     *
     * The bar was a hiding spot closer than 55% of the ghost's distance,
     * which in practice never happened — bots hid 0% of the time across a
     * hundred matches, so the mechanic a human survivor depends on was going
     * entirely untested. Hiding is the right move when you cannot outrun what
     * is coming, so the real condition is stamina: a tired survivor with a
     * cupboard nearby should get in it.
     */
    const spot = nearestHideableSpot(state, mansion, s);
    if (spot && dg < HEARING_RANGE) {
      const ds = dist(s.pos.x, s.pos.z, spot.x, spot.z);
      const cannotOutrun = s.exhausted || s.stamina < 1.2;
      if (ds < dg * (cannotOutrun ? 1.0 : 0.6)) return 'hide';
    }
    // Frightened but not cornered. Keep working — a survivor who stops
    // searching every time the ghost is audible never wins, and a bot that
    // only ever retreats is neither a threat nor a useful teammate.
    return dg > PANIC_RANGE * 1.6 ? 'seek-key' : 'flee';
  }
  return 'seek-key';
}

function nearestHideableSpot(state: GameState, mansion: Mansion, s: Survivor) {
  let best = null as null | { x: number; z: number; id: string };
  let bestD = 14;
  for (const h of mansion.hidingSpots) {
    if (state.survivors.some((o) => o.hidden?.spotId === h.id)) continue;
    const d = dist(s.pos.x, s.pos.z, h.x, h.z);
    if (d < bestD) { bestD = d; best = { x: h.x, z: h.z, id: h.id }; }
  }
  return best;
}

/**
 * Pick the next place to look.
 *
 * Searching used to mean walking to a room's centre and marking it done, which
 * left the key found in only 40% of matches — a key in a corner was simply
 * never seen, and a quarter of matches ran forever with the objective
 * untouched. Rooms are up to fifteen metres across; standing in the middle of
 * one is not searching it.
 *
 * So a room is now several waypoints, drawn from the key spawns it actually
 * contains plus its centre, and it is only marked searched once the bot has
 * been to all of them. That is both more thorough and more honest: the bot
 * looks where the key can be, because that is where a player would look.
 */
function nextSearchTarget(mansion: Mansion, s: Survivor, m: BotMemory): { x: number; z: number } {
  let best = mansion.rooms[0];
  let bestD = Infinity;
  for (const r of mansion.rooms) {
    if (m.searched.has(r.name)) continue;
    const d = dist(s.pos.x, s.pos.z, r.x, r.z);
    if (d < bestD) { bestD = d; best = r; }
  }
  if (bestD === Infinity) {
    // Looked everywhere and found nothing — someone must have missed it.
    m.searched.clear();
    m.visited.clear();
    best = mansion.rooms[Math.floor(Math.random() * mansion.rooms.length)];
  }

  // Work through this room's candidate spots before declaring it searched.
  const spots = mansion.keySpawns.filter((k) => k.room === best.name);
  const pending = spots.filter((k) => !m.visited.has(`${best.name}:${k.x},${k.z}`));
  if (pending.length > 0) {
    const pick = pending[Math.floor(Math.random() * pending.length)];
    m.visited.add(`${best.name}:${pick.x},${pick.z}`);
    return { x: pick.x, z: pick.z };
  }

  m.searched.add(best.name);
  // Scatter around the centre so several bots do not stack on one spot.
  return { x: best.x + (Math.random() - 0.5) * 4, z: best.z + (Math.random() - 0.5) * 4 };
}

function wanderNear(mansion: Mansion): { x: number; z: number } {
  const r = mansion.rooms[Math.floor(Math.random() * mansion.rooms.length)];
  return { x: r.x + (Math.random() - 0.5) * 4, z: r.z + (Math.random() - 0.5) * 4 };
}

function reached(s: Survivor, t: { x: number; z: number }): boolean {
  return dist(s.pos.x, s.pos.z, t.x, t.z) < 1.2;
}
