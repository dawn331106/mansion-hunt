import { blocked } from '../game/collision.js';
import type { Mansion } from '../game/map.js';

/**
 * Navigation for the bots.
 *
 * The first version of the bots steered straight at their target and, when a
 * wall was in the way, sidestepped on a sine wave. That does not work: against
 * the courtyard wall a bot would grind sideways at a tenth of its speed and
 * never get round, so the ghost never reached anyone and the survivors never
 * reached the key. A chase where nobody can cross the house is not a difficulty
 * problem, it is a broken game.
 *
 * So this is a real grid and a real A*. The house is small — 36x30m — so a
 * half-metre grid is only about 4,300 cells, which is cheap to search and
 * cheap to rebuild. Paths are cached per target and recomputed only when the
 * goal moves, which keeps the cost off the frame budget entirely.
 */

/** Grid resolution, metres. Fine enough to fit doorways, coarse enough to be fast. */
const CELL = 0.5;

export interface NavGrid {
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** True where a standing body cannot go. */
  solid: Uint8Array;
}

/**
 * Build the grid once per map.
 *
 * Cells are tested at standing height with a body-sized radius, so a path is
 * walkable by definition — a bot following it never needs to discover that it
 * does not fit. Crouch-only gaps are deliberately excluded: a bot that paths
 * under a charpoy and then stands up is stuck, and the honest fix is to not
 * promise the route in the first place.
 */
export function buildNavGrid(mansion: Mansion, radius: number): NavGrid {
  const { minX, maxX, minZ, maxZ } = mansion.bounds;
  const cols = Math.ceil((maxX - minX) / CELL);
  const rows = Math.ceil((maxZ - minZ) / CELL);
  const solid = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * CELL;
      const z = minZ + (r + 0.5) * CELL;
      solid[r * cols + c] = blocked(mansion, x, z, radius, 1.7) ? 1 : 0;
    }
  }
  return { minX, minZ, cols, rows, solid };
}

function cellOf(g: NavGrid, x: number, z: number): { c: number; r: number } {
  return {
    c: Math.min(g.cols - 1, Math.max(0, Math.floor((x - g.minX) / CELL))),
    r: Math.min(g.rows - 1, Math.max(0, Math.floor((z - g.minZ) / CELL))),
  };
}

function centreOf(g: NavGrid, c: number, r: number): { x: number; z: number } {
  return { x: g.minX + (c + 0.5) * CELL, z: g.minZ + (r + 0.5) * CELL };
}

/** Nearest open cell to a point, for when a body is standing inside geometry. */
function nearestOpen(g: NavGrid, c0: number, r0: number): number {
  const i0 = r0 * g.cols + c0;
  if (!g.solid[i0]) return i0;
  for (let ring = 1; ring < 12; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
        const c = c0 + dc, r = r0 + dr;
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const i = r * g.cols + c;
        if (!g.solid[i]) return i;
      }
    }
  }
  return i0;
}

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
] as const;

/**
 * A* from one point to another, returning world-space waypoints.
 *
 * Returns an empty array when the goal is unreachable, which the caller should
 * treat as "pick a different goal" rather than "walk at it anyway".
 */
export function findPath(
  g: NavGrid,
  fromX: number, fromZ: number,
  toX: number, toZ: number,
): { x: number; z: number }[] {
  const a = cellOf(g, fromX, fromZ);
  const b = cellOf(g, toX, toZ);
  const start = nearestOpen(g, a.c, a.r);
  const goal = nearestOpen(g, b.c, b.r);
  if (start === goal) return [{ x: toX, z: toZ }];

  const n = g.cols * g.rows;
  const gScore = new Float32Array(n).fill(Infinity);
  const fScore = new Float32Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  const gr = (goal / g.cols) | 0;
  const gc = goal % g.cols;
  const h = (i: number): number => {
    const r = (i / g.cols) | 0;
    const c = i % g.cols;
    const dc = Math.abs(c - gc), dr = Math.abs(r - gr);
    // Octile distance: the exact cost on an 8-connected grid, so A* stays
    // admissible and does not wander.
    return (dc + dr) + (Math.SQRT2 - 2) * Math.min(dc, dr);
  };

  gScore[start] = 0;
  fScore[start] = h(start);

  // A binary heap keyed on fScore. A sorted array would be simpler but this
  // runs on every repath for every bot, and the constant factor shows.
  const heap: number[] = [start];
  const push = (i: number): void => {
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (fScore[heap[p]] <= fScore[heap[k]]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && fScore[heap[l]] < fScore[heap[m]]) m = l;
        if (r < heap.length && fScore[heap[r]] < fScore[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };

  let found = false;
  let guard = 0;
  while (heap.length > 0 && guard++ < 20000) {
    const cur = pop();
    if (cur === goal) { found = true; break; }
    if (closed[cur]) continue;
    closed[cur] = 1;

    const cr = (cur / g.cols) | 0;
    const cc = cur % g.cols;

    for (const [dc, dr, cost] of DIRS) {
      const nc = cc + dc, nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
      const ni = nr * g.cols + nc;
      if (g.solid[ni] || closed[ni]) continue;
      // Do not cut corners diagonally through a wall join.
      if (dc !== 0 && dr !== 0) {
        if (g.solid[cr * g.cols + nc] || g.solid[nr * g.cols + cc]) continue;
      }
      const tentative = gScore[cur] + cost;
      if (tentative < gScore[ni]) {
        cameFrom[ni] = cur;
        gScore[ni] = tentative;
        fScore[ni] = tentative + h(ni);
        push(ni);
      }
    }
  }

  if (!found) return [];

  // Walk the chain back, then smooth it.
  const cells: number[] = [];
  for (let i = goal; i !== -1; i = cameFrom[i]) cells.push(i);
  cells.reverse();

  return smooth(g, cells, toX, toZ);
}

/**
 * String-pulling: drop waypoints that can be skipped.
 *
 * A raw grid path is a staircase, and a bot following it visibly jitters
 * between cells. Collapsing runs that have clear line of sight turns it back
 * into the handful of corners a person would actually walk.
 */
function smooth(g: NavGrid, cells: number[], toX: number, toZ: number): { x: number; z: number }[] {
  const pts = cells.map((i) => centreOf(g, i % g.cols, (i / g.cols) | 0));
  pts[pts.length - 1] = { x: toX, z: toZ };

  const out: { x: number; z: number }[] = [];
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    // Reach as far ahead as the grid allows in a straight line.
    while (j > i + 1 && !clearLine(g, pts[i], pts[j])) j--;
    out.push(pts[j]);
    if (j === i) break;
    i = j;
  }
  return out;
}

/** Bresenham-ish walk over the grid, checking every cell the line touches. */
function clearLine(g: NavGrid, a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL * 0.5));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const { c, r } = cellOf(g, x, z);
    if (g.solid[r * g.cols + c]) return false;
  }
  return true;
}

/**
 * A follower that walks a cached path and repaths when the goal moves.
 *
 * Each bot owns one. It hides the difference between "walk to a fixed room"
 * and "chase a moving survivor": the caller just keeps setting a goal, and the
 * follower decides when the old path is stale enough to be worth replacing.
 */
export class PathFollower {
  private path: { x: number; z: number }[] = [];
  private index = 0;
  private goalX = NaN;
  private goalZ = NaN;
  private lastRepath = -Infinity;

  /**
   * Point the follower at a goal and get the next step to walk toward.
   *
   * Returns null when there is no route, so the caller can choose another
   * target instead of walking into a wall forever.
   */
  step(
    grid: NavGrid,
    time: number,
    fromX: number, fromZ: number,
    goalX: number, goalZ: number,
  ): { x: number; z: number } | null {
    const goalMoved = Math.hypot(goalX - this.goalX, goalZ - this.goalZ) > 1.2;
    // Repath on a moved goal, an exhausted path, or a periodic refresh — the
    // refresh is what recovers a bot that has been nudged off its route.
    const stale = time - this.lastRepath > 1.5;

    if (goalMoved || this.index >= this.path.length || stale) {
      this.goalX = goalX;
      this.goalZ = goalZ;
      this.lastRepath = time;
      this.path = findPath(grid, fromX, fromZ, goalX, goalZ);
      this.index = 0;
      if (this.path.length === 0) return null;
    }

    // Advance past waypoints already reached.
    while (this.index < this.path.length) {
      const w = this.path[this.index];
      if (Math.hypot(w.x - fromX, w.z - fromZ) < 0.6) this.index++;
      else break;
    }
    if (this.index >= this.path.length) return { x: goalX, z: goalZ };
    return this.path[this.index];
  }

  reset(): void {
    this.path = [];
    this.index = 0;
    this.goalX = NaN;
    this.goalZ = NaN;
    this.lastRepath = -Infinity;
  }
}
