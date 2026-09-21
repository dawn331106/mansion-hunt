/** Shortest signed angular difference from `a` to `b`, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function rotateToward(from: number, to: number, maxStep: number): number {
  const d = angleDiff(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const dist2 = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax, dz = bz - az;
  return dx * dx + dz * dz;
};

export const dist = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(bx - ax, bz - az);

/** Deterministic PRNG, so a seeded match replays identically. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
