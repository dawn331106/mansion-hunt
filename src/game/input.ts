import { clamp } from '../core/vec.js';
import type { Intent } from './intent.js';
import { emptyIntent } from './intent.js';
import { TOUCH, TouchControls } from './touch.js';

/**
 * Keyboard and mouse — or, on a phone, the on-screen controls — turned into
 * an intent.
 *
 * Pointer lock is mandatory for a first-person horror game on a computer — a
 * cursor you can lose track of breaks the illusion instantly — so the input
 * layer is built around it, and the game pauses the moment lock is dropped.
 * A touchscreen has no pointer to lock, so there "locked" means the player is
 * in the game: set by starting or resuming, cleared by the pause button or by
 * leaving the browser.
 */

const MOUSE_SENSITIVITY = 0.0022;
/** Just short of straight up and down, so the view never flips. */
const PITCH_LIMIT = Math.PI / 2 - 0.05;

export class InputController {
  private keys = new Set<string>();
  private yaw: number;
  private pitch = 0;
  /** Edge-triggered actions, consumed once each by `read`. */
  private pendingInteract = false;
  private pendingCatch = false;
  private locked = false;
  /**
   * Whether the mouse is being dragged while unlocked.
   *
   * Pointer lock is the intended way to look around, but a client cannot
   * always have it — the browser refuses a request that did not come from a
   * user gesture, and a joining player's match starts on a network message.
   * Until they click to take the pointer, dragging is what keeps the view
   * usable rather than frozen forward.
   */
  private dragging = false;
  /** The on-screen controls, on touch devices only. */
  private readonly touch: TouchControls | null = null;
  /**
   * When the touch game last paused, so the tap that paused it cannot resume
   * it. Starts at "never": the page clock starts at zero on load, so zero
   * would have swallowed a Play tapped in the first half second.
   */
  private pausedAt = -Infinity;

  /** Leaving the browser on a phone pauses, since there is no Esc to press. */
  private readonly onVisibility = () => {
    if (document.hidden && this.touch) this.setTouchActive(false);
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    // Never swallow the browser's own shortcuts.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    this.keys.add(e.code);
    if (e.code === 'KeyE') this.pendingInteract = true;
    if (e.code === 'Space') { this.pendingCatch = true; e.preventDefault(); }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };

  private readonly onMouseMove = (e: MouseEvent) => {
    // Locked is the normal path; dragging is the fallback when the browser
    // would not grant the lock.
    if (!this.locked && !this.dragging) return;
    this.yaw += e.movementX * MOUSE_SENSITIVITY;
    // Screen-down should look down, hence the sign.
    this.pitch = clamp(this.pitch - e.movementY * MOUSE_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
  };

  private readonly onMouseDown = (e: MouseEvent) => {
    if (!this.locked) {
      /*
       * Unlocked, the left button turns the view instead of catching.
       *
       * Binding the catch here too would fire it on the very click the player
       * used to start looking around, which in a game decided by one button is
       * not a trade worth making. Right click still interacts, because there
       * is no such ambiguity.
       */
      if (e.button === 0) this.dragging = true;
      if (e.button === 2) this.pendingInteract = true;
      return;
    }
    // Left click is the catch, for a ghost who would rather not use Space.
    if (e.button === 0) this.pendingCatch = true;
    if (e.button === 2) this.pendingInteract = true;
  };

  private readonly onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.dragging = false;
  };

  private readonly onLockChange = () => {
    this.locked = document.pointerLockElement === this.element;
    if (this.locked) this.dragging = false;
    if (!this.locked) this.keys.clear();
    this.onLockChanged?.(this.locked);
  };

  private readonly onContextMenu = (e: Event) => e.preventDefault();

  /** Notified whenever pointer lock is gained or lost, so the game can pause. */
  onLockChanged: ((locked: boolean) => void) | null = null;

  constructor(private readonly element: HTMLElement, initialYaw = 0, role: 'survivor' | 'ghost' = 'survivor') {
    this.yaw = initialYaw;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    element.addEventListener('contextmenu', this.onContextMenu);
    if (TOUCH) {
      /*
       * No mouse listeners on a touchscreen. The browser fires emulated mouse
       * events after every tap, and left click is the ghost's catch — a tap on
       * USE would also have thrown a catch.
       */
      this.touch = new TouchControls(role);
      this.touch.onPause = () => this.setTouchActive(false);
      this.touch.setVisible(false);
      document.addEventListener('visibilitychange', this.onVisibility);
    } else {
      window.addEventListener('mousemove', this.onMouseMove);
      window.addEventListener('mousedown', this.onMouseDown);
      window.addEventListener('mouseup', this.onMouseUp);
      document.addEventListener('pointerlockchange', this.onLockChange);
    }
  }

  /** Enter or leave the game on a touch device: the counterpart of pointer lock. */
  private setTouchActive(active: boolean): void {
    if (!active) this.pausedAt = performance.now();
    this.locked = active;
    this.touch?.setVisible(active);
    if (!active) this.keys.clear();
    this.onLockChanged?.(active);
  }

  /**
   * Ask for the pointer.
   *
   * In browsers that return a promise this rejects when the call did not come
   * from a user gesture — which is exactly what happens to a joining client,
   * whose match starts on a network message rather than a click. The rejection
   * is expected, but it must be reported: `pointerlockchange` does not fire
   * for a lock that was never granted, so without this the paused overlay —
   * the click target that asks again from a real gesture — would stay hidden,
   * leaving the player looking at the game with no way to take the pointer and
   * no idea why the mouse does nothing.
   */
  requestLock(): void {
    if (this.touch) {
      /*
       * The pause button hides the controls the instant it is pressed, so the
       * browser's emulated click at the end of that same tap lands on the
       * "tap to resume" overlay now under the finger. Ignoring a resume that
       * soon after the pause stops the game resuming itself.
       */
      if (performance.now() - this.pausedAt < 500) return;
      /*
       * Full screen and landscape, when the browser allows it: both need a
       * tap to have caused this call and both are refused on some phones
       * (iPhone Safari has neither), which is fine — the game plays in the
       * browser window either way.
       */
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      try {
        if (!document.fullscreenElement && el.requestFullscreen) {
          el.requestFullscreen({ navigationUI: 'hide' })
            .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
              .lock?.('landscape').catch(() => { /* not allowed here */ }))
            .catch(() => { /* not allowed here */ });
        }
      } catch { /* not supported */ }
      this.setTouchActive(true);
      return;
    }
    const r = this.element.requestPointerLock() as unknown;
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch(() => this.onLockChanged?.(false));
    }
  }

  get isLocked(): boolean { return this.locked; }

  /** Whether the on-screen controls are in use. */
  get isTouch(): boolean { return this.touch !== null; }

  /** Force the look angles, used when a hiding spot clamps your view. */
  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  /**
   * Read the current intent, consuming edge-triggered actions.
   *
   * Consuming on read is what stops one keypress from firing a catch on every
   * frame it is held, without the sim needing to know about key state.
   */
  read(): Intent {
    const i: Intent = emptyIntent(this.yaw, this.pitch);

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) i.forward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) i.forward -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) i.right += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) i.right -= 1;

    i.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    i.crouch = this.keys.has('ControlLeft') || this.keys.has('KeyC');

    const t = this.touch;
    if (t) {
      this.yaw += t.lookYaw;
      this.pitch = clamp(this.pitch + t.lookPitch, -PITCH_LIMIT, PITCH_LIMIT);
      t.lookYaw = 0;
      t.lookPitch = 0;
      i.yaw = this.yaw;
      i.pitch = this.pitch;
      i.forward += t.forward;
      i.right += t.right;
      i.sprint ||= t.sprint;
      i.crouch ||= t.crouch;
      if (t.pendingInteract) this.pendingInteract = true;
      if (t.pendingCatch) this.pendingCatch = true;
      t.pendingInteract = false;
      t.pendingCatch = false;
    }

    i.interact = this.pendingInteract;
    i.catch = this.pendingCatch;
    this.pendingInteract = false;
    this.pendingCatch = false;

    return i;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.touch?.dispose();
  }
}
