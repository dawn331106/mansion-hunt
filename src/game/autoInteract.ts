import { SURVIVOR } from './config.js';
import type { Intent } from './intent.js';
import type { HidingSpot, Mansion, Solid } from './map.js';
import { nearestFreeSpot } from './sim.js';
import type { GameState, Survivor } from './types.js';

/**
 * Interacting without a button, for phones.
 *
 * On a touchscreen the thumbs are busy moving and looking, and reaching for
 * a USE button in the middle of a chase is exactly when it gets missed. So on
 * touch devices the survivor's interactions happen by walking into things:
 *
 *   - Reach the key and it is taken.
 *   - Walk into a wardrobe, or into a bed or table, and you hide in it.
 *   - Push the stick while hidden and you climb out.
 *
 * It works by pressing interact on the player's behalf — the same intent the
 * USE button sends — so the simulation, the bots and the network see nothing
 * new, and a phone player joining a host works with no change to the
 * protocol. Desktop players are never given it.
 */

/** Reaching the key: about where you would bend down for it. */
const KEY_REACH = 1.0;
/** How close counts as touching a piece of furniture. */
const CONTACT = 0.12;
/** After pressing interact, wait this long before pressing again. */
const COOLDOWN = 1.0;
/** How far the stick must be pushed to climb out, and let go to count as released. */
const PUSH_OUT = 0.5;
const RELEASED = 0.2;

/** The wardrobe model's footprint, half-extents across and along its facing. */
const WARDROBE_HALF_W = 0.67;
const WARDROBE_HALF_D = 0.33;
/** How far behind the eye the wardrobe's centre is (see `WARDROBE_PEEK_Z`). */
const WARDROBE_BACK = 0.24;

export class AutoInteract {
  private lastPress = -Infinity;
  /**
   * Spots just climbed out of. You come out standing in them, so without
   * this the next frame would put you straight back in; each is forgotten
   * once you have stepped clear of it.
   */
  private readonly leftBehind = new Set<string>();
  /**
   * Whether the stick has been let go since hiding. You walk into a wardrobe
   * with the stick pushed, and that same push must not take you back out.
   */
  private releasedSinceHide = false;
  /** The piece of furniture each crawl-under spot is under. */
  private readonly cover = new Map<string, Solid>();

  constructor(private readonly mansion: Mansion) {
    for (const h of mansion.hidingSpots) {
      if (h.kind !== 'under') continue;
      const over = mansion.solids.find((s) => s.crouchUnder &&
        Math.abs(h.x - s.x) <= s.hx && Math.abs(h.z - s.z) <= s.hz);
      if (over) this.cover.set(h.id, over);
    }
  }

  /**
   * Press interact in `intent` if the player has walked into something.
   *
   * `now` is any clock in seconds; it only paces the presses.
   */
  apply(state: GameState, self: Survivor | null, intent: Intent, now: number): void {
    if (!self || !self.alive || self.escaped || state.phase !== 'playing') return;
    if (now - this.lastPress < COOLDOWN) return;

    const push = Math.hypot(intent.forward, intent.right);

    if (self.hidden) {
      if (push < RELEASED) this.releasedSinceHide = true;
      if (this.releasedSinceHide && push > PUSH_OUT) {
        this.leftBehind.add(self.hidden.spotId);
        this.press(intent, now);
      }
      return;
    }
    this.releasedSinceHide = false;

    // Forget spots the player has stepped clear of.
    for (const id of this.leftBehind) {
      const h = this.mansion.hidingSpots.find((s) => s.id === id);
      if (!h || this.gap(h, self.pos.x, self.pos.z) > CONTACT * 2) this.leftBehind.delete(id);
    }

    if (!state.key.taken &&
        Math.hypot(self.pos.x - state.key.x, self.pos.z - state.key.z) < KEY_REACH) {
      this.press(intent, now);
      return;
    }

    /*
     * Hide only where the simulation will agree to: the spot it would choose
     * is the nearest free one in reach, so press only when that is the very
     * spot being touched. Pressing anywhere else would hide the player
     * somewhere they did not walk into, or do nothing at all.
     */
    const spot = nearestFreeSpot(state, this.mansion, self.pos.x, self.pos.z);
    if (!spot || this.leftBehind.has(spot.id)) return;
    if (this.gap(spot, self.pos.x, self.pos.z) <= CONTACT) this.press(intent, now);
  }

  private press(intent: Intent, now: number): void {
    intent.interact = true;
    this.lastPress = now;
  }

  /**
   * How far the edge of the player's body is from the thing a spot hides
   * you in: the wardrobe, or the bed or table over a crawl-under spot.
   * Zero or less is touching.
   */
  private gap(h: HidingSpot, x: number, z: number): number {
    if (h.kind === 'almirah') {
      // In the wardrobe's own frame: forward is the way its doors face.
      const fx = Math.cos(h.facing), fz = Math.sin(h.facing);
      const cx = h.x - fx * WARDROBE_BACK, cz = h.z - fz * WARDROBE_BACK;
      const dx = x - cx, dz = z - cz;
      const along = dx * fx + dz * fz;
      const across = -dx * fz + dz * fx;
      return boxGap(across, along, WARDROBE_HALF_W, WARDROBE_HALF_D) - SURVIVOR.radius;
    }
    const s = this.cover.get(h.id);
    if (!s) return Math.hypot(x - h.x, z - h.z) - SURVIVOR.radius;
    return boxGap(x - s.x, z - s.z, s.hx, s.hz) - SURVIVOR.radius;
  }
}

/** Distance from a point to an axis-aligned box centred on the origin; 0 inside. */
function boxGap(dx: number, dz: number, hx: number, hz: number): number {
  const ox = Math.max(0, Math.abs(dx) - hx);
  const oz = Math.max(0, Math.abs(dz) - hz);
  return Math.hypot(ox, oz);
}
