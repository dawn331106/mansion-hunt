import type { Mansion, Solid } from './map.js';

/**
 * Collision against axis-aligned boxes, with height taken seriously.
 *
 * A solid only blocks you if your body overlaps it vertically. That single
 * check is what makes crouching mean something: a charpoy's box starts at
 * 0.52m, so a standing 1.7m body hits it and a crouched 0.9m one passes
 * under. No separate "crouch tunnel" geometry is needed.
 */

/** Vertical span a body occupies, given its eye height. */
function bodyTop(eyeHeight: number): number {
  // The crown sits a little above the eyes.
  return eyeHeight + 0.12;
}

/**
 * Does a body at (x, z) with this radius and eye height overlap the solid?
 */
function overlaps(s: Solid, x: number, z: number, r: number, eyeHeight: number): boolean {
  const top = bodyTop(eyeHeight);
  // Vertically disjoint — you pass under it (or, in principle, over it).
  if (s.y0 >= top || s.y1 <= 0) return false;

  const dx = Math.abs(x - s.x) - s.hx;
  const dz = Math.abs(z - s.z) - s.hz;
  if (dx >= r || dz >= r) return false;
  // Both axes overlap the expanded box; for a circle, the corner case needs
  // the actual distance rather than the box test.
  if (dx < 0 || dz < 0) return true;
  return dx * dx + dz * dz < r * r;
}

/**
 * Slide a body from its current position by (dx, dz), resolving collisions.
 *
 * Axes are resolved separately so that walking into a wall at an angle slides
 * along it instead of stopping dead — sticking on geometry during a chase
 * turns a tense escape into a bug report.
 */
export function moveWithCollision(
  mansion: Mansion,
  x: number,
  z: number,
  dx: number,
  dz: number,
  radius: number,
  eyeHeight: number,
): { x: number; z: number } {
  let nx = x;
  let nz = z;

  if (dx !== 0) {
    const tryX = nx + dx;
    if (!blocked(mansion, tryX, nz, radius, eyeHeight)) nx = tryX;
  }
  if (dz !== 0) {
    const tryZ = nz + dz;
    if (!blocked(mansion, nx, tryZ, radius, eyeHeight)) nz = tryZ;
  }

  // Keep bodies inside the compound even if a wall is somehow missed.
  const b = mansion.bounds;
  nx = Math.min(Math.max(nx, b.minX + radius), b.maxX - radius);
  nz = Math.min(Math.max(nz, b.minZ + radius), b.maxZ - radius);
  return { x: nx, z: nz };
}

export function blocked(
  mansion: Mansion,
  x: number,
  z: number,
  radius: number,
  eyeHeight: number,
): boolean {
  for (const s of mansion.solids) {
    if (overlaps(s, x, z, radius, eyeHeight)) return true;
  }
  return false;
}

/**
 * Is there an unobstructed line between two points at a given height?
 *
 * Used for "can the ghost actually see this survivor" and for the bots. The
 * height matters: a sightline at eye level is broken by a crate that a
 * sightline along the floor would pass over.
 */
export function lineOfSight(
  mansion: Mansion,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  height: number,
): boolean {
  for (const s of mansion.solids) {
    if (s.y0 >= height || s.y1 <= height) continue;
    if (segmentHitsBox(ax, az, bx, bz, s)) return false;
  }
  return true;
}

/** Slab test: does the segment a->b intersect the box's footprint? */
function segmentHitsBox(ax: number, az: number, bx: number, bz: number, s: Solid): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;

  const minX = s.x - s.hx, maxX = s.x + s.hx;
  const minZ = s.z - s.hz, maxZ = s.z + s.hz;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ax < minX || ax > maxX) return false;
  } else {
    let tA = (minX - ax) / dx;
    let tB = (maxX - ax) / dx;
    if (tA > tB) { const tmp = tA; tA = tB; tB = tmp; }
    t0 = Math.max(t0, tA);
    t1 = Math.min(t1, tB);
    if (t0 > t1) return false;
  }

  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (az < minZ || az > maxZ) return false;
  } else {
    let tA = (minZ - az) / dz;
    let tB = (maxZ - az) / dz;
    if (tA > tB) { const tmp = tA; tA = tB; tB = tmp; }
    t0 = Math.max(t0, tA);
    t1 = Math.min(t1, tB);
    if (t0 > t1) return false;
  }

  return true;
}
