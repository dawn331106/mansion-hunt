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
 *
 * The plan is 56x44m around an open central courtyard, with a corridor ring
 * between the courtyard and the rooms. An earlier 36x30 version was too small
 * to hide in: from most of it you could see most of the rest, the ghost
 * crossed the whole house in a few seconds, and a chase had nowhere to go.
 * Distance is what makes hiding mean anything.
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

/**
 * A doorway in a wall.
 *
 * Doors are openings with a hinged leaf rather than plain gaps. They matter
 * for more than looks: a door swings visibly when someone passes, and one
 * creaking open somewhere in the house is information you can act on. The leaf
 * itself never blocks movement — a door that could trap you would make the
 * ghost unbeatable — so collision sees only the two jambs either side.
 */
export interface Door {
  id: string;
  /** Centre of the opening. */
  x: number;
  z: number;
  /** Which way the wall runs: 'x' for an east-west wall, 'z' for north-south. */
  axis: 'x' | 'z';
  /** Half-width of the opening. */
  half: number;
  /** Which side the leaf swings toward, +1 or -1 along the other axis. */
  swing: number;
  /** The room this door leads into, for tinting. */
  room: string;
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
  doors: Door[];
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

const WALL_H = 3.2;
const T = 0.16; // wall half-thickness
/** Half-width of a standard doorway. Wide enough to run through. */
const DOOR_HALF = 0.9;

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
 * A wall with one or more doorways cut into it.
 *
 * Pushes the jamb segments into `solids` and records each opening in `doors`,
 * so the renderer knows where to hang a leaf. Building walls this way rather
 * than hand-placing every segment is what keeps a house this size possible to
 * read and to change without leaving someone sealed in a room.
 *
 * It takes a *list* of doorways rather than one. Calling it twice for the same
 * wall pushes two complete copies of that wall, each with only its own gap, so
 * each copy plugs the other's doorway — the wall ends up solid and the room
 * behind it is sealed. Cutting every opening in a single pass is the only way
 * the arithmetic works.
 */
function wallWithDoors(
  solids: Solid[], doors: Door[],
  opts: {
    id: string;
    axis: 'x' | 'z';
    /** Fixed coordinate of the wall: z for an 'x' wall, x for a 'z' wall. */
    at: number;
    /** Span along the wall's axis. */
    from: number;
    to: number;
    /** Positions of the doorways along that axis. */
    doorsAt: number[];
    swing?: number;
    room?: string;
    half?: number;
  },
): void {
  const half = opts.half ?? DOOR_HALF;
  const a0 = Math.min(opts.from, opts.to);
  const a1 = Math.max(opts.from, opts.to);

  const push = (s: number, e: number) => {
    if (e - s < 0.05) return;
    const mid = (s + e) / 2;
    const halfLen = (e - s) / 2;
    if (opts.axis === 'x') solids.push(wall(mid, opts.at, halfLen, T, opts.room));
    else solids.push(wall(opts.at, mid, T, halfLen, opts.room));
  };

  // Walk the wall left to right, emitting the solid stretches between gaps.
  const gaps = opts.doorsAt
    .filter((d) => d - half > a0 - 0.01 && d + half < a1 + 0.01)
    .sort((p, q) => p - q);

  let cursor = a0;
  for (let i = 0; i < gaps.length; i++) {
    push(cursor, gaps[i] - half);
    cursor = gaps[i] + half;
    doors.push({
      id: gaps.length > 1 ? `${opts.id}-${i}` : opts.id,
      x: opts.axis === 'x' ? gaps[i] : opts.at,
      z: opts.axis === 'x' ? opts.at : gaps[i],
      axis: opts.axis,
      half,
      swing: opts.swing ?? 1,
      room: opts.room ?? 'corridor',
    });
  }
  push(cursor, a1);
}

export function buildMansion(): Mansion {
  const solids: Solid[] = [];
  const doors: Door[] = [];
  const minX = -28, maxX = 28, minZ = -22, maxZ = 22;

  // --- Outer shell. The main gate is a gap at x = 0 in the south wall. ---
  solids.push(wall(-15.8, minZ, 12.2, T));
  solids.push(wall(15.8, minZ, 12.2, T));
  solids.push(wall(0, maxZ, 28, T));
  solids.push(wall(minX, 0, T, 22));
  solids.push(wall(maxX, 0, T, 22));

  // --- The courtyard: open to the sky, 20x14, centred. ---
  const courtyard = { minX: -10, maxX: 10, minZ: -7, maxZ: 7 };

  // Courtyard walls. Two doorways on each side, so the courtyard is never a
  // trap with a single way out and a chase through it always has an option.
  wallWithDoors(solids, doors, { id: 'court-s', axis: 'x', at: -7, from: -10, to: 10, doorsAt: [-5, 5], room: 'courtyard' });
  wallWithDoors(solids, doors, { id: 'court-n', axis: 'x', at: 7, from: -10, to: 10, doorsAt: [-5, 5], room: 'courtyard' });
  wallWithDoors(solids, doors, { id: 'court-w', axis: 'z', at: -10, from: -7, to: 7, doorsAt: [0], room: 'courtyard' });
  wallWithDoors(solids, doors, { id: 'court-e', axis: 'z', at: 10, from: -7, to: 7, doorsAt: [0], room: 'courtyard' });

  // --- The corridor ring runs between the courtyard walls and the rooms, so
  //     the house has circulation and a chase can loop indefinitely. ---
  const SOUTH = -13.0;   // wall between south corridor and verandah
  const NORTH = 13.0;    // wall between north corridor and puja/library
  const WEST = -16.0;    // wall between west corridor and bedrooms
  const EAST = 16.0;     // wall between east corridor and kitchen/dining

  /*
   * Each range wall gets several doorways in a single call: one near the
   * middle of the house and one out toward each corner. Every outer room
   * therefore has at least two ways in, which is what stops a room being a
   * dead end you get cornered in and keeps the whole house circulable.
   */

  // South range: the verandah, with the main gate beyond it. The wide central
  // opening gives a clear run at the gate for whoever is carrying the key.
  wallWithDoors(solids, doors, {
    id: 'ver', axis: 'x', at: SOUTH, from: -28, to: 28,
    doorsAt: [-21, -9, 9, 21], room: 'verandah',
  });
  wallWithDoors(solids, doors, {
    id: 'ver-c', axis: 'x', at: SOUTH, from: -2.4, to: 2.4,
    doorsAt: [0], half: 1.6, room: 'verandah',
  });

  // North range: puja room (west) and library (east), split by a spine wall.
  wallWithDoors(solids, doors, {
    id: 'puja', axis: 'x', at: NORTH, from: -28, to: -0.5,
    doorsAt: [-21, -9], room: 'puja',
  });
  wallWithDoors(solids, doors, {
    id: 'lib', axis: 'x', at: NORTH, from: 0.5, to: 28,
    doorsAt: [9, 21], room: 'library',
  });
  wallWithDoors(solids, doors, {
    id: 'puja-lib', axis: 'z', at: 0, from: NORTH, to: 22,
    doorsAt: [17.5], room: 'library',
  });

  // West range: two bedrooms, joined to each other as well as to the corridor.
  wallWithDoors(solids, doors, {
    id: 'bedS', axis: 'z', at: WEST, from: -22, to: -0.5,
    doorsAt: [-18, -6], room: 'bedroom-south',
  });
  wallWithDoors(solids, doors, {
    id: 'bedN', axis: 'z', at: WEST, from: 0.5, to: 22,
    doorsAt: [6, 18], room: 'bedroom-north',
  });
  wallWithDoors(solids, doors, {
    id: 'bed-bed', axis: 'x', at: 0, from: -28, to: WEST,
    doorsAt: [-22], room: 'bedroom-north',
  });

  // East range: kitchen (south) and dining (north), plus a pantry closet.
  wallWithDoors(solids, doors, {
    id: 'kit', axis: 'z', at: EAST, from: -22, to: -0.5,
    doorsAt: [-18, -6], room: 'kitchen',
  });
  wallWithDoors(solids, doors, {
    id: 'din', axis: 'z', at: EAST, from: 0.5, to: 22,
    doorsAt: [6, 18], room: 'dining',
  });
  wallWithDoors(solids, doors, {
    id: 'kit-din', axis: 'x', at: 0, from: EAST, to: 28,
    doorsAt: [22], room: 'dining',
  });
  // The pantry is a closet off the kitchen's south end.
  wallWithDoors(solids, doors, {
    id: 'pan', axis: 'x', at: -17.5, from: EAST, to: 28,
    doorsAt: [19.5], room: 'pantry',
  });

  // --- Courtyard furniture: the well and two tulsi plinths. ---
  solids.push(furn(0, 0, 1.3, 1.3, 1.0, 'courtyard'));
  solids.push(furn(-7.0, 4.8, 0.55, 0.55, 0.85, 'courtyard'));
  solids.push(furn(7.0, -4.8, 0.55, 0.55, 0.85, 'courtyard'));

  // --- Verandah: pillars and benches to crawl under. ---
  for (const px of [-14, -6, 6, 14]) {
    solids.push(furn(px, -17.5, 0.28, 0.28, WALL_H, 'verandah'));
  }
  solids.push(lowFurn(-10, -20.5, 2.4, 0.55, 0.48, 0.58, 'verandah'));
  solids.push(lowFurn(10, -20.5, 2.4, 0.55, 0.48, 0.58, 'verandah'));

  // --- Kitchen: clay stove, prep table, shelving. ---
  solids.push(furn(24.5, -17, 1.3, 1.7, 0.92, 'kitchen'));
  solids.push(lowFurn(20, -14, 1.6, 0.85, 0.70, 0.80, 'kitchen'));
  solids.push(furn(26.6, -8, 0.7, 2.6, 2.2, 'kitchen'));

  // --- Pantry: a narrow closet of shelves. ---
  solids.push(furn(22, -19.5, 2.4, 0.7, 2.0, 'pantry'));

  // --- Dining: a long table and a sideboard. ---
  solids.push(lowFurn(21, 15, 3.2, 1.2, 0.76, 0.86, 'dining'));
  solids.push(furn(26.4, 8, 0.7, 2.2, 1.6, 'dining'));

  // --- Puja room: altar and columns. ---
  solids.push(furn(-9, 20.0, 2.8, 0.9, 1.2, 'puja'));
  solids.push(furn(-16, 16, 0.45, 0.45, 2.4, 'puja'));
  solids.push(furn(-5, 16, 0.45, 0.45, 2.4, 'puja'));

  // --- Library: shelf runs, the most maze-like room in the house. ---
  solids.push(furn(6, 18, 0.7, 3.4, 2.4, 'library'));
  solids.push(furn(12, 18, 0.7, 3.4, 2.4, 'library'));
  solids.push(furn(18, 20, 2.4, 0.7, 2.4, 'library'));
  solids.push(lowFurn(16, 15, 2.0, 0.9, 0.72, 0.82, 'library'));

  // --- Bedrooms: charpoys and trunks. ---
  solids.push(lowFurn(-22, -16, 1.15, 2.2, 0.54, 0.64, 'bedroom-south'));
  solids.push(furn(-26, -20, 0.9, 0.7, 0.95, 'bedroom-south'));
  solids.push(lowFurn(-22, 16, 1.15, 2.2, 0.54, 0.64, 'bedroom-north'));
  solids.push(furn(-26, 20, 0.9, 0.7, 0.95, 'bedroom-north'));

  // --- Hiding spots, spread so every room is worth entering. ---
  const hidingSpots: HidingSpot[] = [
    { id: 'almirah-bed-s', kind: 'almirah', x: -26.4, z: -12.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'bedroom-south' },
    { id: 'almirah-bed-n', kind: 'almirah', x: -26.4, z: 12.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'bedroom-north' },
    { id: 'almirah-kitchen', kind: 'almirah', x: 19.5, z: -20.4, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'kitchen' },
    { id: 'almirah-dining', kind: 'almirah', x: 26.4, z: 19.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'dining' },
    { id: 'almirah-puja', kind: 'almirah', x: -20.0, z: 20.4, eyeHeight: 1.5, facing: -Math.PI / 2, viewHalfAngle: 0.5, room: 'puja' },
    { id: 'almirah-library', kind: 'almirah', x: 3.0, z: 20.4, eyeHeight: 1.5, facing: -Math.PI / 2, viewHalfAngle: 0.5, room: 'library' },
    { id: 'almirah-verandah', kind: 'almirah', x: 17.0, z: -20.4, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'verandah' },
    { id: 'almirah-pantry', kind: 'almirah', x: 26.4, z: -19.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'pantry' },
    { id: 'almirah-corr-w', kind: 'almirah', x: -14.4, z: -4.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'corridor-w' },
    { id: 'almirah-corr-e', kind: 'almirah', x: 14.4, z: 4.0, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'corridor-e' },

    { id: 'under-charpoy-s', kind: 'under', x: -22, z: -16, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-south' },
    { id: 'under-charpoy-n', kind: 'under', x: -22, z: 16, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-north' },
    { id: 'under-kitchen-table', kind: 'under', x: 20, z: -14, eyeHeight: 0.38, facing: -Math.PI / 2, viewHalfAngle: 1.4, room: 'kitchen' },
    { id: 'under-dining', kind: 'under', x: 21, z: 15, eyeHeight: 0.40, facing: Math.PI, viewHalfAngle: 1.4, room: 'dining' },
    { id: 'under-library-desk', kind: 'under', x: 16, z: 15, eyeHeight: 0.38, facing: -Math.PI / 2, viewHalfAngle: 1.4, room: 'library' },
    { id: 'under-bench-w', kind: 'under', x: -10, z: -20.5, eyeHeight: 0.26, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'verandah' },
    { id: 'under-bench-e', kind: 'under', x: 10, z: -20.5, eyeHeight: 0.26, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'verandah' },
  ];

  const rooms: Room[] = [
    { name: 'courtyard', label: 'Courtyard', x: 0, z: 0 },
    { name: 'corridor-s', label: 'South Corridor', x: 0, z: -10.2 },
    { name: 'corridor-n', label: 'North Corridor', x: 0, z: 10.2 },
    { name: 'corridor-w', label: 'West Corridor', x: -13.2, z: 0 },
    { name: 'corridor-e', label: 'East Corridor', x: 13.2, z: 0 },
    { name: 'verandah', label: 'Verandah', x: 0, z: -18.0 },
    { name: 'kitchen', label: 'Kitchen', x: 22, z: -14 },
    { name: 'pantry', label: 'Pantry', x: 22, z: -20 },
    { name: 'dining', label: 'Dining Room', x: 22, z: 14 },
    { name: 'puja', label: 'Puja Room', x: -12, z: 18 },
    { name: 'library', label: 'Library', x: 12, z: 18 },
    { name: 'bedroom-south', label: 'South Bedroom', x: -22, z: -13 },
    { name: 'bedroom-north', label: 'North Bedroom', x: -22, z: 13 },
  ];

  const keySpawns = [
    { x: -25.0, z: -8.0, room: 'bedroom-south' },
    { x: -25.0, z: 8.0, room: 'bedroom-north' },
    { x: 23.0, z: -11.0, room: 'kitchen' },
    { x: 24.5, z: -21.0, room: 'pantry' },
    { x: 24.0, z: 12.0, room: 'dining' },
    { x: -16.5, z: 20.5, room: 'puja' },
    { x: 9.0, z: 20.0, room: 'library' },
    { x: -18.0, z: -20.0, room: 'verandah' },
    { x: 8.0, z: 5.0, room: 'courtyard' },
  ];

  const roomAt = new Map(rooms.map((r) => [r.name, r]));

  return {
    bounds: { minX, maxX, minZ, maxZ },
    solids,
    doors,
    hidingSpots,
    rooms,
    keySpawns,
    /**
     * Survivors start in the courtyard, at the centre of the house.
     *
     * They spawned on the verandah at first, two metres from the gate, which
     * meant that whoever found the key simply turned round and walked out —
     * the match was decided before the ghost had crossed a room. Starting at
     * the hub makes the key a round trip.
     */
    survivorSpawns: [
      { x: -6.0, z: -3.5 },
      { x: 6.0, z: -3.5 },
      { x: -6.0, z: 3.5 },
      { x: 6.0, z: 3.5 },
      { x: 0, z: -4.8 },
    ],
    /**
     * The ghost starts in the far corner of the library.
     *
     * That is roughly forty metres and four doorways from the courtyard — far
     * enough that its first footsteps are a distant warning rather than an
     * immediate threat, and far enough that survivors get a genuine head start
     * on searching before anything finds them.
     */
    ghostSpawn: { x: 22.0, z: 20.5 },
    exit: { x: 0, z: -21.6, hx: 1.6, hz: 0.6 },
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
