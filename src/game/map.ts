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
 * The plan is 74x74m around an open central courtyard: two corridor rings,
 * six spurs linking them, and sixteen rooms hung off the outside. Earlier
 * versions were smaller and simpler — 36x30, then 56x44 with a single ring —
 * and both had the same fault in different sizes: one loop means one decision,
 * so a chase was a circuit and a ghost that guessed right had you.
 *
 * Two rings and the spurs between them are what make it a house rather than a
 * track. Every room has two ways in, every corridor has somewhere to turn off,
 * and from no doorway can you see how the rest of the floor connects. The
 * rooms themselves are deliberately small — eight to twelve metres — because a
 * room you can take in from the threshold is one nobody needs to search.
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
  const minX = -37, maxX = 37, minZ = -37, maxZ = 29;

  // --- Outer shell. The main gate is a gap at x = 0 in the south wall. ---
  // Two runs either side of a 4m opening, so the gate reads as a gate.
  solids.push(wall(-20.5, minZ, 16.5, T));
  solids.push(wall(20.5, minZ, 16.5, T));
  solids.push(wall(0, maxZ, 37, T));
  solids.push(wall(minX, -4, T, 33));
  solids.push(wall(maxX, -4, T, 33));

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
    // The hub. Four ways out now rather than two: a single pair of doors made
    // the courtyard a corridor with a well in it, and anyone crossing knew
    // exactly where you would come from.
    { name: 'courtyard', x0: -9, x1: 9, z0: -7, z1: 7, open: true,
      doors: [['n', -4.5], ['n', 4.5], ['s', -4.5], ['s', 4.5],
              ['w', -3.0], ['e', 3.0]] },

    /*
     * Two corridor rings, linked by radial spurs.
     *
     * One ring meant one decision — left or right — and a ghost that guessed
     * right had you, because the ring rejoined itself and nothing branched off
     * it. With an inner ring, an outer ring and six spurs between them, every
     * room has two approaches and every flight has a real fork in it: you can
     * cross to the far side, double back through a spur, or break out to the
     * outer ring, and none of those is visible from where the ghost stands.
     */
    { name: 'corridor-s', x0: -21, x1: 21, z0: -13, z1: -7, doors: [] },
    { name: 'corridor-n', x0: -21, x1: 21, z0: 7, z1: 13, doors: [] },
    { name: 'corridor-w', x0: -21, x1: -9, z0: -13, z1: 13, doors: [] },
    { name: 'corridor-e', x0: 9, x1: 21, z0: -13, z1: 13, doors: [] },

    // The outer ring. Wider sweeps, further from the hub, and the only way
    // round the back of the house.
    { name: 'outer-s', x0: -37, x1: 37, z0: -29, z1: -23, doors: [] },
    { name: 'outer-n', x0: -37, x1: 37, z0: 23, z1: 29, doors: [] },
    { name: 'outer-w', x0: -37, x1: -31, z0: -23, z1: 23, doors: [] },
    { name: 'outer-e', x0: 31, x1: 37, z0: -23, z1: 23, doors: [] },

    // The spurs: short links between the rings, threaded between the rooms.
    // These are what make a chase a choice rather than a circuit.
    { name: 'spur-sw', x0: -25, x1: -21, z0: -23, z1: -13, doors: [] },
    { name: 'spur-se', x0: 21, x1: 25, z0: -23, z1: -13, doors: [] },
    { name: 'spur-nw', x0: -25, x1: -21, z0: 13, z1: 23, doors: [] },
    { name: 'spur-ne', x0: 21, x1: 25, z0: 13, z1: 23, doors: [] },
    { name: 'spur-w', x0: -31, x1: -21, z0: -4, z1: 0, doors: [] },
    { name: 'spur-e', x0: 21, x1: 31, z0: 0, z1: 4, doors: [] },

    /*
     * The rooms, kept small.
     *
     * The old plan had a thirty-metre puja hall and a seventeen-metre kitchen;
     * from the doorway of either you could see the whole room, so there was
     * nothing to search and nowhere a ghost could be that you had not already
     * ruled out. These are eight to twelve metres on a side — small enough
     * that entering one is a commitment, and that a ghost in the doorway is a
     * problem rather than a distant shape.
     */

    // South-west quarter.
    { name: 'bedroom-south', x0: -31, x1: -25, z0: -23, z1: -13, doors: [['e', -18]] },
    { name: 'store', x0: -21, x1: -11, z0: -23, z1: -13, doors: [['n', -16], ['w', -18]] },
    { name: 'washroom', x0: -11, x1: -3, z0: -23, z1: -13, doors: [['n', -7]] },

    // South-east quarter.
    { name: 'kitchen', x0: 3, x1: 13, z0: -23, z1: -13, doors: [['n', 8], ['e', -18]] },
    { name: 'pantry', x0: 13, x1: 21, z0: -23, z1: -13, doors: [['w', -18], ['n', 17]] },
    { name: 'bedroom-east', x0: 25, x1: 37, z0: -23, z1: -13, doors: [['w', -18], ['s', 31]] },

    // West side.
    { name: 'bedroom-north', x0: -31, x1: -21, z0: 4, z1: 13, doors: [['e', 9]] },
    { name: 'study', x0: -31, x1: -21, z0: -13, z1: -4, doors: [['e', -8]] },

    // East side.
    { name: 'dining', x0: 21, x1: 31, z0: -13, z1: 0, doors: [['w', -6], ['n', 26]] },
    { name: 'music-room', x0: 21, x1: 31, z0: 4, z1: 14, doors: [['w', 9]] },

    // North-west quarter.
    { name: 'puja', x0: -31, x1: -25, z0: 13, z1: 23, doors: [['e', 18]] },
    { name: 'guest-room', x0: -21, x1: -11, z0: 13, z1: 23, doors: [['s', -16]] },

    // North-east quarter.
    { name: 'library', x0: -3, x1: 9, z0: 13, z1: 23, doors: [['s', 3], ['e', 18]] },
    { name: 'gallery', x0: 9, x1: 21, z0: 13, z1: 23, doors: [['s', 15], ['w', 18]] },
    { name: 'attic-stair', x0: 25, x1: 37, z0: 13, z1: 23, doors: [['w', 18], ['n', 31]] },

    // The verandah and the gate beyond it: the way out.
    { name: 'verandah', x0: -37, x1: 37, z0: -37, z1: -29,
      doors: [['n', -18], ['n', 0], ['n', 18]] },
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
  /**
   * Every kind of thoroughfare, not just the ones named `corridor`.
   *
   * This tested a single prefix, so the outer ring and the spurs — corridors
   * in everything but name — emitted their own edges and walled themselves
   * into sealed channels. The symptom was a whole quarter of the house
   * unreachable, which reads as a missing door rather than as a corridor
   * behaving like a room.
   */
  const isThoroughfare = (name: string) =>
    name.startsWith('corridor') || name.startsWith('outer') || name.startsWith('spur');

  for (const r of PLAN) {
    if (isThoroughfare(r.name)) continue;

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

  // --- Verandah: a colonnade, and benches low enough to crawl under. ---
  for (const px of [-28, -18, -8, 8, 18, 28]) {
    solids.push(furn(px, -33.5, 0.30, 0.30, WALL_H, 'verandah'));
  }
  solids.push(lowFurn(-24, -31.0, 2.4, 0.55, 0.48, 0.58, 'verandah'));
  solids.push(lowFurn(24, -31.0, 2.4, 0.55, 0.48, 0.58, 'verandah'));

  // --- Kitchen: clay stove, prep table, shelving. ---
  solids.push(furn(5.2, -21.0, 1.3, 1.2, 0.92, 'kitchen'));
  solids.push(lowFurn(8.0, -16.5, 1.5, 0.85, 0.70, 0.80, 'kitchen'));
  solids.push(furn(11.6, -20.0, 0.7, 2.0, 2.2, 'kitchen'));

  // --- Pantry: a narrow closet of shelves. ---
  solids.push(furn(15.0, -21.5, 1.4, 0.7, 2.0, 'pantry'));

  // --- Store: stacked crates, a room to lose a silhouette in. ---
  solids.push(furn(-19.0, -21.0, 1.1, 1.1, 1.6, 'store'));
  solids.push(furn(-13.5, -16.0, 0.8, 1.4, 2.0, 'store'));

  // --- Washroom: a cistern and a low bench. ---
  solids.push(furn(-9.5, -21.5, 0.8, 0.8, 1.3, 'washroom'));
  solids.push(lowFurn(-5.5, -17.0, 1.2, 0.6, 0.50, 0.60, 'washroom'));

  // --- Dining: a long table and a sideboard. ---
  solids.push(lowFurn(26.0, -8.0, 2.6, 1.1, 0.76, 0.86, 'dining'));
  solids.push(furn(29.4, -3.5, 0.7, 1.6, 1.6, 'dining'));

  // --- Music room: a harmonium and a tanpura case on its end. ---
  solids.push(lowFurn(26.5, 11.0, 1.4, 0.8, 0.68, 0.78, 'music-room'));
  solids.push(furn(29.4, 6.5, 0.6, 1.2, 1.8, 'music-room'));

  // --- Puja room: altar and columns. ---
  solids.push(furn(-28, 21.4, 2.2, 0.8, 1.2, 'puja'));
  solids.push(furn(-29.8, 15.5, 0.45, 0.45, 2.4, 'puja'));
  solids.push(furn(-26.2, 15.5, 0.45, 0.45, 2.4, 'puja'));

  // --- Library: shelf runs, the most maze-like room in the house. ---
  solids.push(furn(-0.5, 18.0, 0.7, 3.0, 2.4, 'library'));
  solids.push(furn(4.5, 18.0, 0.7, 3.0, 2.4, 'library'));
  solids.push(lowFurn(7.0, 21.5, 1.4, 0.9, 0.72, 0.82, 'library'));

  // --- Gallery: plinths in a row, and a bench along the wall. ---
  for (const gx of [12.0, 16.0, 20.0]) {
    solids.push(furn(gx, 19.5, 0.5, 0.5, 1.5, 'gallery'));
  }
  solids.push(lowFurn(16.0, 14.8, 2.2, 0.55, 0.48, 0.58, 'gallery'));

  // --- Guest room: a charpoy and a trunk. ---
  solids.push(lowFurn(-16.5, 19.0, 1.15, 2.0, 0.54, 0.64, 'guest-room'));
  solids.push(furn(-13.0, 21.8, 0.9, 0.7, 0.95, 'guest-room'));

  // --- Study: a desk to crawl under and a bookcase. ---
  solids.push(lowFurn(-26.5, -10.0, 1.6, 0.9, 0.72, 0.82, 'study'));
  solids.push(furn(-29.4, -6.5, 0.6, 1.4, 2.0, 'study'));

  // --- Attic stair: the flight itself, boxed in. ---
  solids.push(furn(33.5, 18.0, 2.0, 1.4, 2.4, 'attic-stair'));

  // --- Bedrooms: charpoys and trunks. ---
  solids.push(lowFurn(-28.0, -19.0, 1.15, 2.0, 0.54, 0.64, 'bedroom-south'));
  solids.push(furn(-29.6, -15.0, 0.8, 0.7, 0.95, 'bedroom-south'));
  solids.push(lowFurn(-26.5, 7.5, 1.15, 2.0, 0.54, 0.64, 'bedroom-north'));
  solids.push(furn(-29.4, 12.0, 0.9, 0.7, 0.95, 'bedroom-north'));
  solids.push(lowFurn(30.0, -19.0, 1.15, 2.0, 0.54, 0.64, 'bedroom-east'));
  solids.push(furn(34.5, -15.5, 0.9, 0.7, 0.95, 'bedroom-east'));

  /*
   * Hiding spots, placed against a wall and clear of the furniture.
   *
   * Two rules, and both are load-bearing. An almirah stands against a wall
   * and is entered from the front, so its own square has to be free of
   * anything solid or you cannot get out again. An `under` spot is the exact
   * opposite: it names the piece of furniture it belongs to, so its
   * coordinates must match that piece to the metre, or you crawl under a
   * charpoy that is standing somewhere else entirely.
   *
   * `checkmap` proves both, which is the only reason these can be trusted.
   */
  const hidingSpots: HidingSpot[] = [
    { id: 'almirah-bed-s', kind: 'almirah', x: -26.0, z: -14.0, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'bedroom-south' },
    { id: 'almirah-bed-n', kind: 'almirah', x: -23.0, z: 5.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'bedroom-north' },
    { id: 'almirah-bed-e', kind: 'almirah', x: 35.5, z: -21.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'bedroom-east' },
    { id: 'almirah-kitchen', kind: 'almirah', x: 4.0, z: -14.5, eyeHeight: 1.5, facing: -Math.PI / 2, viewHalfAngle: 0.5, room: 'kitchen' },
    { id: 'almirah-dining', kind: 'almirah', x: 22.5, z: -11.5, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'dining' },
    { id: 'almirah-puja', kind: 'almirah', x: -26.0, z: 18.5, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'puja' },
    { id: 'almirah-library', kind: 'almirah', x: -1.5, z: 14.5, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'library' },
    { id: 'almirah-verandah', kind: 'almirah', x: -35.0, z: -35.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'verandah' },
    { id: 'almirah-pantry', kind: 'almirah', x: 19.5, z: -14.5, eyeHeight: 1.5, facing: -Math.PI / 2, viewHalfAngle: 0.5, room: 'pantry' },
    { id: 'almirah-store', kind: 'almirah', x: -12.5, z: -21.5, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'store' },
    { id: 'almirah-gallery', kind: 'almirah', x: 20.0, z: 14.5, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'gallery' },
    { id: 'almirah-guest', kind: 'almirah', x: -12.5, z: 14.5, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'guest-room' },
    { id: 'almirah-music', kind: 'almirah', x: 22.5, z: 5.5, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'music-room' },
    { id: 'almirah-study', kind: 'almirah', x: -22.5, z: -12.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'study' },
    { id: 'almirah-attic', kind: 'almirah', x: 26.5, z: 14.5, eyeHeight: 1.5, facing: Math.PI / 2, viewHalfAngle: 0.5, room: 'attic-stair' },
    { id: 'almirah-corr-w', kind: 'almirah', x: -19.5, z: -4.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'corridor-w' },
    { id: 'almirah-corr-e', kind: 'almirah', x: 19.5, z: 4.0, eyeHeight: 1.5, facing: Math.PI, viewHalfAngle: 0.5, room: 'corridor-e' },
    { id: 'almirah-outer-n', kind: 'almirah', x: -35.5, z: 26.0, eyeHeight: 1.5, facing: 0, viewHalfAngle: 0.5, room: 'outer-n' },

    { id: 'under-charpoy-s', kind: 'under', x: -28.0, z: -19.0, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-south' },
    { id: 'under-charpoy-n', kind: 'under', x: -26.5, z: 7.5, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-north' },
    { id: 'under-charpoy-e', kind: 'under', x: 30.0, z: -19.0, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'bedroom-east' },
    { id: 'under-kitchen-table', kind: 'under', x: 8.0, z: -16.5, eyeHeight: 0.38, facing: -Math.PI / 2, viewHalfAngle: 1.4, room: 'kitchen' },
    { id: 'under-dining', kind: 'under', x: 26.0, z: -8.0, eyeHeight: 0.40, facing: Math.PI, viewHalfAngle: 1.4, room: 'dining' },
    { id: 'under-library-desk', kind: 'under', x: 7.0, z: 21.5, eyeHeight: 0.38, facing: -Math.PI / 2, viewHalfAngle: 1.4, room: 'library' },
    { id: 'under-study-desk', kind: 'under', x: -26.5, z: -10.0, eyeHeight: 0.38, facing: Math.PI / 2, viewHalfAngle: 1.4, room: 'study' },
    { id: 'under-guest-charpoy', kind: 'under', x: -16.5, z: 19.0, eyeHeight: 0.30, facing: 0, viewHalfAngle: 1.4, room: 'guest-room' },
    { id: 'under-gallery-bench', kind: 'under', x: 16.0, z: 14.8, eyeHeight: 0.26, facing: -Math.PI / 2, viewHalfAngle: 1.3, room: 'gallery' },
    { id: 'under-music-bench', kind: 'under', x: 26.5, z: 11.0, eyeHeight: 0.34, facing: Math.PI, viewHalfAngle: 1.4, room: 'music-room' },
    { id: 'under-washroom-bench', kind: 'under', x: -5.5, z: -17.0, eyeHeight: 0.28, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'washroom' },
    { id: 'under-bench-w', kind: 'under', x: -24, z: -31.0, eyeHeight: 0.26, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'verandah' },
    { id: 'under-bench-e', kind: 'under', x: 24, z: -31.0, eyeHeight: 0.26, facing: Math.PI / 2, viewHalfAngle: 1.3, room: 'verandah' },
  ];

  const rooms: Room[] = [
    { name: 'courtyard', label: 'Courtyard', x: 0, z: 0 },
    { name: 'corridor-s', label: 'South Corridor', x: 0, z: -10 },
    { name: 'corridor-n', label: 'North Corridor', x: 0, z: 10 },
    { name: 'corridor-w', label: 'West Corridor', x: -15, z: 0 },
    { name: 'corridor-e', label: 'East Corridor', x: 15, z: 0 },
    { name: 'outer-s', label: 'South Passage', x: 0, z: -26 },
    { name: 'outer-n', label: 'North Passage', x: 0, z: 26 },
    { name: 'outer-w', label: 'West Passage', x: -34, z: 0 },
    { name: 'outer-e', label: 'East Passage', x: 34, z: 0 },
    { name: 'spur-sw', label: 'South-West Stair', x: -23, z: -18 },
    { name: 'spur-se', label: 'South-East Stair', x: 23, z: -18 },
    { name: 'spur-nw', label: 'North-West Stair', x: -23, z: 18 },
    { name: 'spur-ne', label: 'North-East Stair', x: 23, z: 18 },
    { name: 'spur-w', label: 'West Landing', x: -26, z: -2 },
    { name: 'spur-e', label: 'East Landing', x: 26, z: 2 },
    { name: 'verandah', label: 'Verandah', x: 0, z: -33 },
    { name: 'kitchen', label: 'Kitchen', x: 8, z: -18 },
    { name: 'pantry', label: 'Pantry', x: 17, z: -18 },
    { name: 'store', label: 'Store Room', x: -16, z: -18 },
    { name: 'washroom', label: 'Washroom', x: -7, z: -18 },
    { name: 'dining', label: 'Dining Room', x: 26, z: -6 },
    { name: 'music-room', label: 'Music Room', x: 26, z: 9 },
    { name: 'puja', label: 'Puja Room', x: -26, z: 18 },
    { name: 'guest-room', label: 'Guest Room', x: -16, z: 18 },
    { name: 'library', label: 'Library', x: 3, z: 18 },
    { name: 'gallery', label: 'Gallery', x: 15, z: 18 },
    { name: 'attic-stair', label: 'Attic Stair', x: 31, z: 18 },
    { name: 'study', label: 'Study', x: -26, z: -8 },
    { name: 'bedroom-south', label: 'South Bedroom', x: -26, z: -18 },
    { name: 'bedroom-north', label: 'North Bedroom', x: -26, z: 9 },
    { name: 'bedroom-east', label: 'East Bedroom', x: 31, z: -18 },
  ];

  /*
   * Where the key can be, one of which is picked per match.
   *
   * Spread to the far corners on purpose: the key is the only thing that
   * makes a survivor cross the house, and a spawn near the courtyard would
   * let a match be won without ever entering the dark.
   */
  const keySpawns = [
    { x: -26.5, z: -21.5, room: 'bedroom-south' },
    { x: -26.0, z: 10.5, room: 'bedroom-north' },
    { x: 31.5, z: -20.5, room: 'bedroom-east' },
    { x: 6.5, z: -18.5, room: 'kitchen' },
    { x: 17.5, z: -18.0, room: 'pantry' },
    { x: 24.0, z: -5.0, room: 'dining' },
    { x: -26.5, z: 18.5, room: 'puja' },
    { x: 2.0, z: 20.5, room: 'library' },
    { x: 14.0, z: 16.5, room: 'gallery' },
    { x: -16.5, z: -19.5, room: 'store' },
    { x: -26.5, z: -6.5, room: 'study' },
    { x: 24.5, z: 9.5, room: 'music-room' },
    { x: -17.0, z: 21.5, room: 'guest-room' },
    { x: 31.5, z: 20.5, room: 'attic-stair' },
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
    ghostSpawn: { x: 33.0, z: 20.5 },
    exit: { x: 0, z: -36.4, hx: 2.0, hz: 0.6 },
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
