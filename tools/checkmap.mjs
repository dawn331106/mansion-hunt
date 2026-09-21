/**
 * Prove the house is connected.
 *
 * A single mis-placed wall can seal a room, and the symptom — bots milling
 * about, a key that is never found — looks like an AI bug rather than a map
 * bug. This flood-fills the nav grid from the survivor spawn and asserts that
 * every spawn, key position, hiding spot, room centre and the exit is
 * reachable, so a wall placed wrongly fails loudly here instead of quietly
 * ruining matches.
 */
import { buildMansion } from '../src/game/map.ts';
import { blocked } from '../src/game/collision.ts';
import { buildNavGrid, findPath } from '../src/ai/navigate.ts';
import { SURVIVOR } from '../src/game/config.ts';

const m = buildMansion();
const g = buildNavGrid(m, 0.32);
const start = m.survivorSpawns[0];
let bad = 0;

/**
 * `standing` is false for places you are only ever crouched or stationary in —
 * under a charpoy, inside an almirah. Those are supposed to overlap furniture,
 * so testing them at standing height would report the map's whole point as a
 * fault. What must hold for them is that you can *get* to them.
 */
const check = (label, x, z, opts = {}) => {
  const { radius = 0.32, standing = true } = opts;
  const inside = standing && blocked(m, x, z, radius, 1.7);
  const path = findPath(g, start.x, start.z, x, z);
  // A path ending near enough to interact with counts as reached.
  const near = path.length > 0 &&
    Math.hypot(path[path.length - 1].x - x, path[path.length - 1].z - z) < 2.0;
  const ok = !inside && near;
  if (!ok) {
    bad++;
    console.log(`  FAIL ${label} (${x},${z})` +
      (inside ? ' inside geometry' : '') + (!near ? ' unreachable' : ''));
  }
  return ok;
};

console.log('spawns');
for (const s of m.survivorSpawns) check('survivor spawn', s.x, s.z);
check('ghost spawn', m.ghostSpawn.x, m.ghostSpawn.z, { radius: 0.36 });
console.log('key spawns');
for (const k of m.keySpawns) check(`key/${k.room}`, k.x, k.z);
console.log('hiding spots');
for (const h of m.hidingSpots) check(`hide/${h.id}`, h.x, h.z, { standing: false });
console.log('room centres');
for (const r of m.rooms) check(`room/${r.name}`, r.x, r.z, { standing: false });
console.log('exit');
check('exit', m.exit.x, m.exit.z);
console.log('doorways');
for (const d of m.doors) check(`door/${d.id}`, d.x, d.z, { standing: false });

/*
 * Every hiding spot must be escapable.
 *
 * Crawl-under spots sit inside furniture by design, so they are blocked to a
 * standing body — that is the point. But they must be clear to a *crouched*
 * one, or climbing out drops the player into geometry they cannot move
 * through in any direction and the match is over for them. That is exactly
 * what shipped: `crouchUnder` was in the map data and no collision code read
 * it, so all seven crawl spots were one-way.
 */
console.log('hiding spots escapable');
for (const h of m.hidingSpots) {
  const crouched = blocked(m, h.x, h.z, SURVIVOR.radius, SURVIVOR.crouchEyeHeight);
  const standing = blocked(m, h.x, h.z, SURVIVOR.radius, SURVIVOR.eyeHeight);
  if (crouched) {
    bad++;
    console.log(`  FAIL ${h.id} is blocked even when crouched — cannot be left`);
  } else if (h.kind === 'under' && !standing) {
    bad++;
    console.log(`  FAIL ${h.id} is an 'under' spot but nothing is above it`);
  }
}

const area = (m.bounds.maxX - m.bounds.minX) * (m.bounds.maxZ - m.bounds.minZ);
console.log(`\n${m.solids.length} solids, ${m.doors.length} doors, ${m.hidingSpots.length} hiding spots`);
console.log(`house ${m.bounds.maxX - m.bounds.minX}x${m.bounds.maxZ - m.bounds.minZ}m = ${area}m2`);
console.log(bad === 0 ? 'ALL REACHABLE' : `${bad} PROBLEMS`);
process.exit(bad === 0 ? 0 : 1);
