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

  /**
   * The plan, as a table of rectangles.
   *
   * An earlier version placed each wall by hand and then tried to cut doors
   * into the right stretches of them. That does not work at this scale: the
   * ring walls run the full width of the house, so whether a door actually
   * opens the room it is meant to depends on arithmetic no one can hold in
   * their head, and four whole wings ended up sealed with the map still
   * looking plausible in source.
   *
   * So the house is declared as rooms, each a rectangle with its doors listed
   * as points on its own perimeter, and the walls are generated from that. A
   * door is by construction in the wall of the room that owns it. Shared
   * edges are de-duplicated, so two rooms back to back get one wall between
   * them with both their doors in it.
   *
   * Rooms have at most two doors, and most have one. That is the whole shape
   * of the thing: a room with three ways out is a thoroughfare you pass
   * through, and a house of thoroughfares has nowhere to be cornered. A
   * one-door room is a gamble — good to hide in, terrible to be found in.
   * The corridors carry the traffic, which is what corridors are for, and
   * they are where the chases happen.
   *
   *   +----------------------------------------------+
   *   |  bedroom N   |   N corridor   |   library     |
   *   |--------------+----------------+---------------|
   *   |  W corridor  |   COURTYARD    |  E corridor   |
   *   |              |   (no roof)    |               |
   *   |--------------+----------------+---------------|
   *   |  bedroom S   |   S corridor   | kitchen/pantry|
   *   +--------------+----- gate -----+---------------+
   */
  interface RoomBox {
    name: string;
    x0: number; x1: number;
    z0: number; z1: number;
    /** Doors as [side, position] — the position is along that side. */
    doors: [side: 'n' | 's' | 'e' | 'w', at: number][];
    /** Open to the sky; no ceiling, and lit by the moon. */
    open?: boolean;
  }

  const PLAN: RoomBox[] = [
    // The hub. Two ways in, on opposite sides, so crossing it is a decision.
    { name: 'courtyard', x0: -9, x1: 9, z0: -7, z1: 7, open: true,
      doors: [['n', -4.5], ['s', 4.5]] },

    // The corridor ring. These are the thoroughfares, and they are where the
    // doors are: every room opens onto a corridor, never onto another room.
    { name: 'corridor-s', x0: -17, x1: 17, z0: -13, z1: -7, doors: [] },
    { name: 'corridor-n', x0: -17, x1: 17, z0: 7, z1: 13, doors: [] },
    { name: 'corridor-w', x0: -17, x1: -9, z0: -13, z1: 13, doors: [] },
    { name: 'corridor-e', x0: 9, x1: 17, z0: -13, z1: 13, doors: [] },

    // The south wing: the verandah, with the gate beyond it. Two doors,
    // because this is the way out and one choke point would decide matches.
    /*
     * The verandah stops short of the east wing.
     *
     * It spanned the full width at first, which overlapped the pantry
     * completely — so the verandah's own north wall ran straight across the
     * pantry's only door and sealed that whole corner. Rectangles in this
     * plan must not overlap; `checkmap` catches it when they do, but only
     * after the fact, so the shapes have to tile properly by hand.
     */
    { name: 'verandah', x0: -28, x1: 17, z0: -22, z1: -13,
      doors: [['n', -9], ['n', 9]] },

    // The north wing.
    { name: 'puja', x0: -28, x1: 2, z0: 13, z1: 22, doors: [['s', -13]] },
    { name: 'library', x0: 2, x1: 28, z0: 13, z1: 22, doors: [['s', 13]] },

    // The west wing.
    { name: 'bedroom-south', x0: -28, x1: -17, z0: -13, z1: 0, doors: [['e', -7]] },
    { name: 'bedroom-north', x0: -28, x1: -17, z0: 0, z1: 13, doors: [['e', 7]] },

    // The east wing. The pantry is a dead end off the kitchen — deliberately
    // the worst room in the house to be caught in.
    { name: 'kitchen', x0: 17, x1: 28, z0: -17, z1: 0, doors: [['w', -7], ['s', 22]] },
    { name: 'pantry', x0: 17, x1: 28, z0: -22, z1: -17, doors: [['n', 22]] },
    // The verandah and the pantry meet along x = 17; the verandah reaches the
    // gate, the pantry hangs off the kitchen behind it.
    { name: 'dining', x0: 17, x1: 28, z0: 0, z1: 13, doors: [['w', 7]] },
  ];

  const courtyard = { minX: -9, maxX: 9, minZ: -7, maxZ: 7 };

  /*
   * Turn the plan into walls.
   *
   * Every room edge becomes a wall, keyed by its line so that a shared edge
   * is only built once and carries the doors of both rooms either side. The
   * outer shell is excluded — it is placed separately, because the main gate
   * is a gap rather than a door.
   */
  const edges = new Map<string, { axis: 'x' | 'z'; at: number; from: number; to: number; doors: number[]; room: string }>();

  const addEdge = (
    axis: 'x' | 'z', at: number, from: number, to: number, doorAt: number | null, room: string,
  ) => {
    const key = `${axis}:${at.toFixed(2)}:${Math.min(from, to).toFixed(2)}:${Math.max(from, to).toFixed(2)}`;
    let e = edges.get(key);
    if (!e) {
      e = { axis, at, from: Math.min(from, to), to: Math.max(from, to), doors: [], room };
      edges.set(key, e);
    }
    /*
     * A shared edge gets one wall, not two.
     *
     * Both rooms either side of a doorway naturally declare it — the kitchen
     * lists a door to the pantry and the pantry lists the same door back —
     * and pushing it twice cut the opening twice at the same place, which is
     * harmless, but the real hazard is two rooms declaring *different* doors
     * on one edge and each expecting its own. Collapsing duplicates keeps
     * both cases correct.
     */
    if (doorAt !== null && !e.doors.some((d) => Math.abs(d - doorAt) < 0.01)) {
      e.doors.push(doorAt);
    }
  };

  /*
   * Corridors contribute no walls of their own.
   *
   * They are the negative space between the rooms, so every edge a corridor
   * has is already some other room's edge — and that room owns the door in
   * it. Letting corridors emit their own edges walled each one into a sealed
   * box, because a corridor has no doors of its own to cut. The ring is
   * bounded entirely by the rooms around it, which is what a corridor is.
   */
  for (const r of PLAN) {
    if (r.name.startsWith('corridor')) continue;

    const doorsOn = (side: 'n' | 's' | 'e' | 'w') =>
      r.doors.filter((d) => d[0] === side).map((d) => d[1]);
    // North and south edges run along x; east and west along z.
    for (const [side, axis, at, from, to] of [
      ['s', 'x', r.z0, r.x0, r.x1],
      ['n', 'x', r.z1, r.x0, r.x1],
      ['w', 'z', r.x0, r.z0, r.z1],
      ['e', 'z', r.x1, r.z0, r.z1],
    ] as const) {
      /*
       * Skip the outer shell; it is placed by hand, because the main gate is
       * a gap rather than a door.
       *
       * The comparison has to be against the bound on the same axis as the
       * wall's fixed coordinate: an 'x' wall is a line of constant z, so it
       * is part of the shell when `at` reaches minZ or maxZ. Checking it
       * against minX first dropped interior walls and kept shell ones, which
       * left every room sealed while the door list still looked correct.
       */
      const lo = axis === 'x' ? minZ : minX;
      const hi = axis === 'x' ? maxZ : maxX;
      if (at <= lo + 0.01 || at >= hi - 0.01) continue;
      const ds = doorsOn(side);
      if (ds.length === 0) addEdge(axis, at, from, to, null, r.name);
      else for (const d of ds) addEdge(axis, at, from, to, d, r.name);
    }
  }

  for (const e of edges.values()) {
    wallWithDoors(solids, doors, {
      id: `${e.room}-${e.axis}${e.at.toFixed(0)}`,
      axis: e.axis, at: e.at, from: e.from, to: e.to,
      doorsAt: e.doors, room: e.room,
    });
  }

  // --- Courtyard: the well and two tulsi plinths. ---
  solids.push(furn(0, 0, 1.3, 1.3, 1.0, 'courtyard'));
  solids.push(furn(-6.2, 4.4, 0.55, 0.55, 0.85, 'courtyard'));
  solids.push(furn(6.2, -4.4, 0.55, 0.55, 0.85, 'courtyard'));

  // --- Verandah: pillars and benches to crawl under. ---
  for (const px of [-14, -6, 6, 14]) {
    solids.push(furn(px, -17.5, 0.28, 0.28, WALL_H, 'verandah'));
  }
  solids.push(lowFurn(-10, -20.5, 2.4, 0.55, 0.48, 0.58, 'verandah'));
  solids.push(lowFurn(10, -20.5, 2.4, 0.55, 0.48, 0.58, 'verandah'));

  // --- Kitchen: clay stove, prep table, shelving. ---
  solids.push(furn(25.0, -17, 1.3, 1.7, 0.92, 'kitchen'));
  solids.push(lowFurn(20.5, -13, 1.6, 0.85, 0.70, 0.80, 'kitchen'));
  solids.push(furn(26.6, -8, 0.7, 2.6, 2.2, 'kitchen'));

  // --- Pantry: a narrow closet of shelves. ---
  solids.push(furn(21.5, -19.5, 2.2, 0.7, 2.0, 'pantry'));

  // --- Dining: a long table and a sideboard. ---
  solids.push(lowFurn(21, 15, 3.2, 1.2, 0.76, 0.86, 'dining'));
  solids.push(furn(26.4, 8, 0.7, 2.2, 1.6, 'dining'));

  // --- Puja room: altar and columns. ---
  solids.push(furn(-9, 20.0, 2.8, 0.9, 1.2, 'puja'));
  solids.push(furn(-17, 16, 0.45, 0.45, 2.4, 'puja'));
  solids.push(furn(-6, 16, 0.45, 0.45, 2.4, 'puja'));

  // --- Library: shelf runs, the most maze-like room in the house. ---
  solids.push(furn(7, 18, 0.7, 3.2, 2.4, 'library'));
  solids.push(furn(13, 18, 0.7, 3.2, 2.4, 'library'));
  solids.push(lowFurn(20, 16.5, 2.0, 0.9, 0.72, 0.82, 'library'));

  // --- Bedrooms: charpoys and trunks. ---
  solids.push(lowFurn(-22, -16, 1.15, 2.2, 0.54, 0.64, 'bedroom-south'));
  solids.push(furn(-26, -20, 0.9, 0.7, 0.95, 'bedroom-south'));
  solids.push(lowFurn(-22, 16, 1.15, 2.2, 0.54, 0.64, 'bedroom-north'));
  solids.push(furn(-26, 20, 0.9, 0.7, 0.95, 'bedroom-north'));

  // --- Hiding spots, spread so every room is worth entering. ---
  const hidingSpots: HidingSpot[] = [
    { id: 'almirah-bed-s', kind: 'almirah', x: -26.4, z: -12.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'bedroom-south' },
    { id: 'almirah-bed-n', kind: 'almirah', x: -26.4, z: 12.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'bedroom-north' },
    { id: 'almirah-kitchen', kind: 'almirah', x: 19.0, z: -20.4, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'kitchen' },
    { id: 'almirah-dining', kind: 'almirah', x: 26.4, z: 19.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'dining' },
    { id: 'almirah-puja', kind: 'almirah', x: -21.0, z: 20.4, eyeHeight: 1.5, facing: -Math.PI / 2, viewHalfAngle: 0.5, room: 'puja' },
    { id: 'almirah-library', kind: 'almirah', x: 4.5, z: 20.4, eyeHeight: 1.5, facing: -Math.PI / 2, viewHalfAngle: 0.5, room: 'library' },
    { id: 'almirah-verandah', kind: 'almirah', x: 17.5, z: -20.4, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'verandah' },
    { id: 'almirah-pantry', kind: 'almirah', x: 26.4, z: -19.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'pantry' },
    { id: 'almirah-corr-w', kind: 'almirah', x: -15.4, z: -4.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'corridor-w' },
    { id: 'almirah-corr-e', kind: 'almirah', x: 15.4, z: 4.0, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'corridor-e' },

    { id: 'under-charpoy-s', kind: 'under', x: -22, z: -16, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-south' },
    { id: 'under-charpoy-n', kind: 'under', x: -22, z: 16, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-north' },
    { id: 'under-kitchen-table', kind: 'under', x: 20.5, z: -13, eyeHeight: 0.38, facing: -Math.PI / 2, viewHalfAngle: 1.4, room: 'kitchen' },
    { id: 'under-dining', kind: 'under', x: 21, z: 15, eyeHeight: 0.40, facing: Math.PI, viewHalfAngle: 1.4, room: 'dining' },
    { id: 'under-library-desk', kind: 'under', x: 20, z: 16.5, eyeHeight: 0.38, facing: -Math.PI / 2, viewHalfAngle: 1.4, room: 'library' },
    { id: 'under-bench-w', kind: 'under', x: -10, z: -20.5, eyeHeight: 0.26, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'verandah' },
    { id: 'under-bench-e', kind: 'under', x: 10, z: -20.5, eyeHeight: 0.26, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'verandah' },
  ];

  const rooms: Room[] = [
    { name: 'courtyard', label: 'Courtyard', x: 0, z: 0 },
    { name: 'corridor-s', label: 'South Corridor', x: 0, z: -10 },
    { name: 'corridor-n', label: 'North Corridor', x: 0, z: 10 },
    { name: 'corridor-w', label: 'West Corridor', x: -13, z: 0 },
    { name: 'corridor-e', label: 'East Corridor', x: 13, z: 0 },
    { name: 'verandah', label: 'Verandah', x: 0, z: -18 },
    { name: 'kitchen', label: 'Kitchen', x: 22, z: -12 },
    { name: 'pantry', label: 'Pantry', x: 22, z: -20 },
    { name: 'dining', label: 'Dining Room', x: 22, z: 14 },
    { name: 'puja', label: 'Puja Room', x: -13, z: 18 },
    { name: 'library', label: 'Library', x: 14, z: 18 },
    { name: 'bedroom-south', label: 'South Bedroom', x: -22, z: -12 },
    { name: 'bedroom-north', label: 'North Bedroom', x: -22, z: 12 },
  ];

  const keySpawns = [
    { x: -25.0, z: -8.0, room: 'bedroom-south' },
    { x: -25.0, z: 8.0, room: 'bedroom-north' },
    { x: 23.0, z: -11.0, room: 'kitchen' },
    { x: 24.0, z: -21.0, room: 'pantry' },
    { x: 24.0, z: 12.0, room: 'dining' },
    { x: -13.0, z: 21.0, room: 'puja' },
    { x: 10.0, z: 20.0, room: 'library' },
    { x: -18.0, z: -20.0, room: 'verandah' },
    { x: 6.0, z: 4.0, room: 'courtyard' },
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
      { x: -5.5, z: -3.2 },
      { x: 5.5, z: -3.2 },
      { x: -5.5, z: 3.2 },
      { x: 5.5, z: 3.2 },
      { x: 0, z: -4.6 },
    ],
    /**
     * The ghost starts in the far corner of the library.
     *
     * Roughly forty metres and four doorways from the courtyard — far enough
     * that its first footsteps are a distant warning rather than an immediate
     * threat, and far enough that survivors get a genuine head start.
     */
    ghostSpawn: { x: 24.0, z: 20.0 },
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
