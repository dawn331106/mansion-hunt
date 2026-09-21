/**
 * The house: a decaying South Asian home, built from axis-aligned boxes.
 *
 * Walls are boxes rather than the line segments Torchlight Heist used, because
 * a horror game needs things you can crouch *under* — a segment has no height,
 * so a charpoy and a wall would be the same obstacle. Every solid here carries
 * a height and a `crouchUnder` flag, and collision consults both.
 *
 * There is no minimap. Players navigate by memory and landmark, so each room
 * carries a distinct wall tint and prop silhouette (see `render/world.ts`) —
 * that palette is the only wayfinding the game offers, and it has to do the
 * whole job.
 */

export interface Box {
  /** Centre on the floor plane. */
  x: number;
  z: number;
  /** Half-extents, so the box spans x +/- hx. */
  hx: number;
  hz: number;
  /** Bottom and top, metres above the floor. */
  y0: number;
  y1: number;
}

export type SolidKind = 'wall' | 'furniture' | 'door';

export interface Solid extends Box {
  kind: SolidKind;
  /**
   * True if a crouched survivor passes underneath — the low gap of a charpoy
   * or a wooden table. Standing still collides.
   */
  crouchUnder: boolean;
  /** Which room this belongs to, so the renderer can tint it. */
  room?: string;
}

export type HidingKind = 'almirah' | 'under';

export interface HidingSpot {
  id: string;
  kind: HidingKind;
  /** Where the camera sits while hidden. */
  x: number;
  z: number;
  /** Eye height while hidden — under a charpoy is much lower than an almirah. */
  eyeHeight: number;
  /**
   * Facing the occupant is locked to, radians. An almirah faces out of its
   * door; you cannot spin around inside one.
   */
  facing: number;
  /** How wide a view the occupant keeps, radians of half-angle. */
  viewHalfAngle: number;
  /** Which room it sits in, for the bots' search logic. */
  room: string;
}

export interface Room {
  name: string;
  /** Shown nowhere in game — used by bots and for debugging. */
  label: string;
  /** Centre, used as a navigation waypoint. */
  x: number;
  z: number;
}

export interface Mansion {
  /** Outer bounds, for clamping. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  solids: Solid[];
  hidingSpots: HidingSpot[];
  rooms: Room[];
  /** Candidate key positions; one is chosen at random per match. */
  keySpawns: { x: number; z: number; room: string }[];
  /** Survivor spawn points. */
  survivorSpawns: { x: number; z: number }[];
  /** Ghost spawn point, deliberately far from the survivors. */
  ghostSpawn: { x: number; z: number };
  /** The main gate: walk into it carrying the key to escape. */
  exit: { x: number; z: number; hx: number; hz: number };
  /** Room centres keyed by name, for quick lookup. */
  roomAt: Map<string, Room>;
  /**
   * The courtyard is open to the sky, so it is lit differently and has no
   * ceiling. Stored as a rectangle the renderer and lighting both consult.
   */
  courtyard: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const WALL_H = 3.0;
const T = 0.15; // wall half-thickness

function wall(x: number, z: number, hx: number, hz: number, room?: string): Solid {
  return { kind: 'wall', x, z, hx, hz, y0: 0, y1: WALL_H, crouchUnder: false, room };
}

/** A solid piece of furniture — blocks you whether you crouch or not. */
function furn(x: number, z: number, hx: number, hz: number, h: number, room?: string): Solid {
  return { kind: 'furniture', x, z, hx, hz, y0: 0, y1: h, crouchUnder: false, room };
}

/**
 * Furniture with a gap beneath: a charpoy, a table, a wooden cot.
 *
 * The box describes the solid top; `crouchUnder` tells collision that a
 * crouched survivor may pass through it.
 */
function lowFurn(
  x: number, z: number, hx: number, hz: number, gap: number, h: number, room?: string,
): Solid {
  return { kind: 'furniture', x, z, hx, hz, y0: gap, y1: h, crouchUnder: true, room };
}

/**
 * Build the house.
 *
 * The plan is a 36x30m compound laid out around a central open courtyard —
 * the uthon — with rooms opening onto it on all four sides, which is how these
 * houses are actually built and which gives the hunt a ring topology: every
 * room has two ways out, so no corridor is a guaranteed kill box, and a chase
 * can loop the courtyard indefinitely until someone's stamina runs out.
 *
 * Rooms, clockwise from the main gate (south): verandah, kitchen (east),
 * store room, puja room (north), bedrooms (west), and a well in the courtyard.
 */
export function buildMansion(): Mansion {
  const solids: Solid[] = [];
  const minX = -18, maxX = 18, minZ = -15, maxZ = 15;

  // --- Outer shell. The main gate is a 2.4m gap at x = 0 in the south wall. ---
  solids.push(wall(-10.2, minZ, 7.8, T));
  solids.push(wall(10.2, minZ, 7.8, T));
  solids.push(wall(0, maxZ, 18, T));
  solids.push(wall(minX, 0, T, 15));
  solids.push(wall(maxX, 0, T, 15));

  // --- The courtyard: open to the sky, 16x12, centred. Rooms ring it. ---
  const courtyard = { minX: -8, maxX: 8, minZ: -6, maxZ: 6 };

  // Inner courtyard walls, each pierced by a doorway onto the verandah ring.
  // South side of the courtyard, doorway at x = 0.
  solids.push(wall(-5.2, -6, 2.8, T, 'verandah'));
  solids.push(wall(5.2, -6, 2.8, T, 'verandah'));
  // North side, doorway at x = 0.
  solids.push(wall(-5.2, 6, 2.8, T, 'puja'));
  solids.push(wall(5.2, 6, 2.8, T, 'puja'));
  // West side, doorway at z = 0.
  solids.push(wall(-8, -3.7, T, 2.3, 'bedroom-south'));
  solids.push(wall(-8, 3.7, T, 2.3, 'bedroom-north'));
  // East side, doorway at z = 0.
  solids.push(wall(8, -3.7, T, 2.3, 'kitchen'));
  solids.push(wall(8, 3.7, T, 2.3, 'store'));

  // --- East wing divider: kitchen (south) / store room (north). ---
  solids.push(wall(13.0, 0, 5.0, T, 'kitchen'));
  // --- West wing divider: two bedrooms. ---
  solids.push(wall(-13.0, 0, 5.0, T, 'bedroom-south'));

  // --- Verandah (south strip) and puja room (north strip) end walls. ---
  solids.push(wall(-8, -10.5, T, 4.5, 'verandah'));
  solids.push(wall(8, -10.5, T, 4.5, 'verandah'));
  solids.push(wall(-8, 10.5, T, 4.5, 'puja'));
  solids.push(wall(8, 10.5, T, 4.5, 'puja'));

  // --- Courtyard: the well, a solid waist-high ring, and a tulsi plinth. ---
  solids.push(furn(0, 0, 1.0, 1.0, 0.95, 'courtyard'));
  solids.push(furn(-5.0, 4.0, 0.5, 0.5, 0.8, 'courtyard'));

  // --- Verandah: wooden pillars and a long bench you can crawl under. ---
  solids.push(furn(-4.0, -10.5, 0.25, 0.25, WALL_H, 'verandah'));
  solids.push(furn(4.0, -10.5, 0.25, 0.25, WALL_H, 'verandah'));
  solids.push(lowFurn(-6.0, -13.2, 1.6, 0.5, 0.45, 0.55, 'verandah'));

  // --- Kitchen: clay stove, a low prep table, shelving along the east wall. ---
  solids.push(furn(15.0, -9.0, 1.0, 1.4, 0.85, 'kitchen'));
  solids.push(lowFurn(11.5, -8.0, 1.3, 0.7, 0.68, 0.78, 'kitchen'));
  solids.push(furn(17.2, -4.0, 0.6, 2.0, 2.1, 'kitchen'));

  // --- Store room: stacked crates and sacks, a maze of solid blocks. ---
  solids.push(furn(11.5, 4.5, 1.1, 1.1, 1.6, 'store'));
  solids.push(furn(15.5, 7.5, 1.3, 0.9, 1.9, 'store'));
  solids.push(furn(12.0, 11.0, 0.9, 1.4, 1.4, 'store'));

  // --- Puja room: a raised altar platform, low enough to hide behind. ---
  solids.push(furn(0, 12.6, 2.2, 0.8, 1.1, 'puja'));
  solids.push(furn(-4.5, 11.0, 0.4, 0.4, 2.2, 'puja'));
  solids.push(furn(4.5, 11.0, 0.4, 0.4, 2.2, 'puja'));

  // --- Bedrooms: charpoys (rope cots) you can roll under, and a trunk. ---
  solids.push(lowFurn(-14.5, -8.5, 1.0, 1.9, 0.52, 0.62, 'bedroom-south'));
  solids.push(furn(-10.5, -12.0, 0.8, 0.6, 0.9, 'bedroom-south'));
  solids.push(lowFurn(-14.5, 8.5, 1.0, 1.9, 0.52, 0.62, 'bedroom-north'));
  solids.push(furn(-10.5, 12.0, 0.8, 0.6, 0.9, 'bedroom-north'));

  // --- Hiding spots ---
  // Almirahs (wooden wardrobes) face out of the wall they stand against; the
  // occupant is locked to that facing with a narrow view, which is what makes
  // climbing into one a gamble rather than a free save.
  const hidingSpots: HidingSpot[] = [
    { id: 'almirah-bed-s', kind: 'almirah', x: -16.8, z: -12.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'bedroom-south' },
    { id: 'almirah-bed-n', kind: 'almirah', x: -16.8, z: 12.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'bedroom-north' },
    { id: 'almirah-store', kind: 'almirah', x: 16.8, z: 11.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'store' },
    { id: 'almirah-kitchen', kind: 'almirah', x: 10.2, z: -12.8, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'kitchen' },
    { id: 'almirah-puja', kind: 'almirah', x: -6.5, z: 13.8, eyeHeight: 1.5, facing: -Math.PI / 2, viewHalfAngle: 0.5, room: 'puja' },
    { id: 'almirah-verandah', kind: 'almirah', x: 6.8, z: -13.8, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'verandah' },

    // Under-object spots sit low with a wide but ground-level view.
    { id: 'under-charpoy-s', kind: 'under', x: -14.5, z: -8.5, eyeHeight: 0.3, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-south' },
    { id: 'under-charpoy-n', kind: 'under', x: -14.5, z: 8.5, eyeHeight: 0.3, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-north' },
    { id: 'under-kitchen-table', kind: 'under', x: 11.5, z: -8.0, eyeHeight: 0.38, facing: -Math.PI / 2, viewHalfAngle: 1.4, room: 'kitchen' },
    { id: 'under-verandah-bench', kind: 'under', x: -6.0, z: -13.2, eyeHeight: 0.26, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'verandah' },
  ];

  const rooms: Room[] = [
    { name: 'courtyard', label: 'Courtyard', x: 0, z: 0 },
    { name: 'verandah', label: 'Verandah', x: 0, z: -11 },
    { name: 'kitchen', label: 'Kitchen', x: 13, z: -8 },
    { name: 'store', label: 'Store Room', x: 13, z: 8 },
    { name: 'puja', label: 'Puja Room', x: 0, z: 11 },
    { name: 'bedroom-south', label: 'South Bedroom', x: -13, z: -8 },
    { name: 'bedroom-north', label: 'North Bedroom', x: -13, z: 8 },
  ];

  const keySpawns = [
    { x: -16.5, z: -5.0, room: 'bedroom-south' },
    { x: -16.5, z: 5.0, room: 'bedroom-north' },
    { x: 14.0, z: -12.5, room: 'kitchen' },
    { x: 16.0, z: 3.0, room: 'store' },
    { x: 3.5, z: 13.0, room: 'puja' },
    { x: -3.0, z: -13.5, room: 'verandah' },
    { x: 5.5, z: 3.5, room: 'courtyard' },
  ];

  const roomAt = new Map(rooms.map((r) => [r.name, r]));

  return {
    bounds: { minX, maxX, minZ, maxZ },
    solids,
    hidingSpots,
    rooms,
    keySpawns,
    // Survivors start on the verandah, just inside the main gate.
    /**
     * Survivors start in the courtyard, at the centre of the house.
     *
     * They spawned on the verandah at first, two metres from the gate, which
     * meant that whoever found the key simply turned round and walked out —
     * the match was decided before the ghost had crossed a room. Starting at
     * the hub makes the key a round trip: out to a room to find it, then the
     * whole way back down the house with it, which is where the game is.
     *
     * Spread wide enough that nobody spawns inside anyone else's camera.
     */
    survivorSpawns: [
      { x: -4.2, z: -3.2 },
      { x: 4.2, z: -3.2 },
      { x: -4.2, z: 3.2 },
      { x: 4.2, z: 3.2 },
      { x: 0, z: -4.0 },
    ],
    // The ghost starts in the store room: far from the courtyard, out of
    // sight of every survivor spawn, and clear of the crates so it does not
    // begin the match with its face in a box.
    ghostSpawn: { x: 13.8, z: 9.0 },
    exit: { x: 0, z: -14.8, hx: 1.2, hz: 0.5 },
    roomAt,
    courtyard,
  };
}

/** Which room a point falls in, by nearest room centre. */
export function roomOf(mansion: Mansion, x: number, z: number): string {
  let best = mansion.rooms[0];
  let bestD = Infinity;
  for (const r of mansion.rooms) {
    const d = (r.x - x) ** 2 + (r.z - z) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best.name;
}
