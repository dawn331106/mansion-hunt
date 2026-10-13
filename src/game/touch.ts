/**
 * On-screen controls for phones and tablets.
 *
 * A touchscreen has no keyboard and no pointer lock, so the game draws its own
 * controls over the view, laid out the way mobile shooters have taught people
 * to expect:
 *
 *   - Left half: a floating thumbstick. It appears wherever the thumb lands,
 *     so it is always under the thumb. Within its ring you walk, at a speed
 *     that follows how far you push; drag past the ring and you sprint.
 *   - Right half: drag anywhere to look around.
 *   - Buttons on the right: USE (the E key), CROUCH (a toggle, since holding
 *     it would tie up the thumb that looks), CATCH for the ghost, and pause.
 *
 * Everything is driven by pointer events tracked per pointer id, so moving and
 * looking work at the same time with two thumbs.
 */

/** Whether this device should get the on-screen controls. */
export const TOUCH: boolean =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(hover: none) and (pointer: coarse)').matches === true;

/** Stick travel, in CSS pixels, for full walking speed. */
const STICK_RADIUS = 56;
/** Drag this far past the ring (as a multiple of the radius) to sprint. */
const SPRINT_PAST = 1.35;
/** Radians of turn per CSS pixel of drag. Phones are held closer than a mouse. */
const LOOK_SENSITIVITY = 0.0055;

export class TouchControls {
  /** Current stick deflection, -1..1, forward and right. */
  forward = 0;
  right = 0;
  sprint = false;
  crouch = false;
  /** Look movement since the last read, in radians. */
  lookYaw = 0;
  lookPitch = 0;
  /** Edge-triggered, consumed by the input controller. */
  pendingInteract = false;
  pendingCatch = false;
  /** Set by the pause button. */
  onPause: (() => void) | null = null;

  private readonly root: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly crouchBtn: HTMLButtonElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };

  constructor(role: 'survivor' | 'ghost') {
    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.innerHTML = `
      <div class="t-zone t-move"></div>
      <div class="t-zone t-look"></div>
      <div class="t-stick"><div class="t-knob"></div></div>
      <button class="t-btn t-pause" aria-label="Pause">II</button>
      ${role === 'ghost'
        ? '<button class="t-btn t-big t-catch">CATCH</button>'
        : `<button class="t-btn t-big t-use">USE</button>
           <button class="t-btn t-crouch">CROUCH</button>`}
      <div class="t-hint">${role === 'ghost'
        ? 'left thumb: move · right thumb: look'
        : 'left thumb: move (push past the ring to run) · right thumb: look · walk into the key, a wardrobe or a bed to use it'}</div>
    `;
    document.body.appendChild(this.root);
    this.base = this.root.querySelector('.t-stick') as HTMLDivElement;
    this.knob = this.root.querySelector('.t-knob') as HTMLDivElement;
    this.crouchBtn = this.root.querySelector('.t-crouch') as HTMLButtonElement;

    /*
     * Cancel the browser's emulated click for every touch on the controls.
     *
     * A tap ends with a synthetic click at the same spot. After the pause
     * button, that click landed on the "tap to resume" overlay that had just
     * appeared under the finger, and resumed the game the instant it paused.
     * Pointer events still fire; only the emulated mouse events are dropped.
     */
    this.root.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });

    const move = this.root.querySelector('.t-move') as HTMLDivElement;
    const look = this.root.querySelector('.t-look') as HTMLDivElement;
    move.addEventListener('pointerdown', this.onMoveDown);
    look.addEventListener('pointerdown', this.onLookDown);
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);

    this.button('.t-use', () => { this.pendingInteract = true; });
    this.button('.t-catch', () => { this.pendingCatch = true; });
    this.button('.t-crouch', () => {
      this.crouch = !this.crouch;
      this.crouchBtn.classList.toggle('on', this.crouch);
    });
    this.button('.t-pause', () => this.onPause?.());

    // The hint is for the first few seconds only.
    window.setTimeout(() => this.root.querySelector('.t-hint')?.classList.add('gone'), 6000);
  }

  private button(sel: string, fn: () => void): void {
    const b = this.root.querySelector(sel) as HTMLButtonElement | null;
    if (!b) return;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.add('down');
      fn();
    });
    const up = () => b.classList.remove('down');
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
  }

  private readonly onMoveDown = (e: PointerEvent) => {
    if (this.stickId !== null) return;
    e.preventDefault();
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.add('on');
    this.setStick(0, 0);
  };

  private readonly onLookDown = (e: PointerEvent) => {
    if (this.lookId !== null) return;
    e.preventDefault();
    this.lookId = e.pointerId;
    this.lookLast = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      e.preventDefault();
      this.setStick(e.clientX - this.stickOrigin.x, e.clientY - this.stickOrigin.y);
    } else if (e.pointerId === this.lookId) {
      e.preventDefault();
      this.lookYaw += (e.clientX - this.lookLast.x) * LOOK_SENSITIVITY;
      // Dragging up looks up, as with a mouse.
      this.lookPitch -= (e.clientY - this.lookLast.y) * LOOK_SENSITIVITY;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.base.classList.remove('on');
      this.base.style.left = '';
      this.base.style.top = '';
      this.setStick(0, 0);
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  };

  /** Turn a thumb offset from where it landed into movement. */
  private setStick(dx: number, dy: number): void {
    const dist = Math.hypot(dx, dy);
    const k = dist > STICK_RADIUS ? STICK_RADIUS / dist : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    this.right = (dx * k) / STICK_RADIUS;
    // Screen-up is forward.
    this.forward = (-dy * k) / STICK_RADIUS;
    this.sprint = dist > STICK_RADIUS * SPRINT_PAST;
    this.base.classList.toggle('run', this.sprint);
  }

  /** Forget held input, for when the game pauses. */
  release(): void {
    this.stickId = null;
    this.lookId = null;
    this.base.classList.remove('on');
    this.base.style.left = '';
    this.base.style.top = '';
    this.setStick(0, 0);
    this.lookYaw = 0;
    this.lookPitch = 0;
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    if (!v) this.release();
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.root.remove();
  }
}
