import { MATCH, PULSE, SURVIVOR } from '../game/config.js';
import type { GameState, Role, Survivor } from '../game/types.js';

/**
 * The heads-up display.
 *
 * There is no map, so the HUD deliberately tells you almost nothing about
 * where anything is. What it does show is the state of your own body — how
 * much sprint you have left — and what the button under your finger will do
 * right now. Everything else the player is expected to learn by looking and
 * listening, which is the entire point of removing the map.
 *
 * Drawn to a 2D canvas over the WebGL view rather than as DOM, so it can share
 * the render loop and never fights the pointer lock.
 */

export interface HudState {
  role: Role;
  /** The survivor the camera belongs to, if playing as one. */
  self: Survivor | null;
  /** What pressing E would do right now, or null. */
  prompt: string | null;
  /** Shown briefly after an event: "You have the key", "Caught Rina". */
  toast: { text: string; until: number } | null;
  /** What the ghost is saying, while it is close enough to hear. */
  subtitle: { text: string; until: number } | null;
  /** Whether the ghost's catch is off cooldown. */
  catchReady: boolean;
}

export class Hud {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable for the HUD');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(state: GameState, hud: HudState, w: number, h: number): void {
    const c = this.ctx;
    c.clearRect(0, 0, w, h);

    this.drawReticle(c, w, h, hud);

    if (hud.role === 'survivor' && hud.self) {
      this.drawStamina(c, w, h, hud.self);
      if (hud.self.hasKey) this.drawKeyBadge(c, w, h);
      if (hud.self.hidden) this.drawHiddenFrame(c, w, h);
    } else if (hud.role === 'ghost') {
      this.drawPulseTimer(c, w, h, state);
      this.drawCatchState(c, w, h, hud);
      if (state.time < MATCH.ghostHeadStart) this.drawHold(c, w, h, state);
    }

    if (hud.prompt) this.drawPrompt(c, w, h, hud.prompt);
    if (hud.toast && state.time < hud.toast.until) this.drawToast(c, w, hud.toast.text);
    if (hud.subtitle && state.time < hud.subtitle.until) {
      this.drawSubtitle(c, w, h, hud.subtitle.text);
    }

    this.drawSurvivorTally(c, w, h, state, hud.role);
  }

  /** A small, unobtrusive reticle. It turns red when a catch would land. */
  private drawReticle(c: CanvasRenderingContext2D, w: number, h: number, hud: HudState): void {
    const x = w / 2, y = h / 2;
    const hot = hud.role === 'ghost' && hud.catchReady;
    c.strokeStyle = hot ? 'rgba(255,70,70,0.9)' : 'rgba(255,255,255,0.35)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(x, y, hot ? 6 : 3, 0, Math.PI * 2);
    c.stroke();
  }

  /**
   * The stamina bar.
   *
   * Placed low and centre, close to the reticle, because the decision it feeds
   * — keep running or stop — is made while looking straight ahead at whatever
   * is chasing you, not while glancing at a corner of the screen.
   */
  private drawStamina(c: CanvasRenderingContext2D, w: number, h: number, s: Survivor): void {
    const barW = 180, barH = 5;
    const x = (w - barW) / 2;
    const y = h - 58;
    const frac = s.stamina / SURVIVOR.staminaMax;

    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(x - 1, y - 1, barW + 2, barH + 2);

    // Red while exhausted: the bar is refilling but sprint is locked out, and
    // the player needs to see that rather than mash a key that does nothing.
    c.fillStyle = s.exhausted
      ? 'rgba(200,60,50,0.85)'
      : frac < 0.3 ? 'rgba(220,150,60,0.9)' : 'rgba(190,210,230,0.75)';
    c.fillRect(x, y, barW * frac, barH);

    if (s.exhausted) {
      const floor = SURVIVOR.staminaRecoveryFloor / SURVIVOR.staminaMax;
      c.strokeStyle = 'rgba(255,255,255,0.6)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x + barW * floor, y - 2);
      c.lineTo(x + barW * floor, y + barH + 2);
      c.stroke();
    }
  }

  private drawKeyBadge(c: CanvasRenderingContext2D, w: number, h: number): void {
    c.save();
    c.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    // A warning, not a trophy. Carrying the key ends the match if you are
    // caught, and the HUD should say so every second you hold it.
    c.fillStyle = 'rgba(255,190,90,0.95)';
    c.fillText('YOU HAVE THE KEY', w / 2, h - 78);
    c.font = '400 11px ui-sans-serif, system-ui, sans-serif';
    c.fillStyle = 'rgba(255,150,90,0.75)';
    c.fillText('if you are caught, everyone loses', w / 2, h - 64);
    c.restore();
  }

  /** A soft frame, so a hidden player reads their view as "through a gap". */
  private drawHiddenFrame(c: CanvasRenderingContext2D, w: number, h: number): void {
    const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.22, w / 2, h / 2, Math.max(w, h) * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.92)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    c.save();
    c.font = '400 11px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(255,255,255,0.4)';
    c.fillText('E to climb out', w / 2, h - 40);
    c.restore();
  }

  /**
   * The hold at the start of a match.
   *
   * The ghost cannot move for the first few seconds while the survivors
   * scatter. Without this the screen just does not respond to the controls,
   * which reads as a bug rather than a rule — the single most confusing thing
   * the game can do to someone who has only just pressed play.
   */
  private drawHold(c: CanvasRenderingContext2D, w: number, h: number, state: GameState): void {
    const left = Math.max(0, MATCH.ghostHeadStart - state.time);
    c.save();
    c.textAlign = 'center';
    c.font = '300 44px ui-sans-serif, system-ui, sans-serif';
    c.fillStyle = 'rgba(220,90,90,0.92)';
    c.fillText(Math.ceil(left).toString(), w / 2, h / 2 - 54);
    c.font = '400 13px ui-sans-serif, system-ui, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fillText('they are still hiding — you cannot move yet', w / 2, h / 2 - 28);
    c.restore();
  }

  /**
   * The ghost's pulse clock.
   *
   * A countdown rather than a bar, because the ghost's plan depends on knowing
   * roughly how many seconds until the next reveal — whether to commit to a
   * room now or wait for the house to tell them where to go.
   */
  private drawPulseTimer(c: CanvasRenderingContext2D, w: number, h: number, state: GameState): void {
    const remaining = Math.max(0, state.pulse.nextAt - state.time);
    const showing = state.time < state.pulse.visibleUntil;

    c.save();
    c.textAlign = 'center';
    if (showing) {
      const left = Math.max(0, state.pulse.visibleUntil - state.time);
      c.font = '600 15px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = 'rgba(255,90,90,0.95)';
      c.fillText(`THEY WERE HERE — ${left.toFixed(1)}s`, w / 2, 34);
    } else {
      c.font = '400 12px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = remaining < 5 ? 'rgba(255,160,90,0.9)' : 'rgba(255,255,255,0.4)';
      c.fillText(`next sighting in ${Math.ceil(remaining)}s`, w / 2, 30);
    }
    c.restore();
    void h;
  }

  private drawCatchState(c: CanvasRenderingContext2D, w: number, h: number, hud: HudState): void {
    c.save();
    c.font = '400 11px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillStyle = hud.catchReady ? 'rgba(255,90,90,0.85)' : 'rgba(255,255,255,0.25)';
    c.fillText(hud.catchReady ? 'SPACE / CLICK — CATCH' : 'recovering…', w / 2, h - 44);
    c.restore();
  }

  private drawPrompt(c: CanvasRenderingContext2D, w: number, h: number, text: string): void {
    c.save();
    c.font = '500 13px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    const tw = c.measureText(text).width;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(w / 2 - tw / 2 - 10, h / 2 + 26, tw + 20, 24);
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.fillText(text, w / 2, h / 2 + 42);
    c.restore();
  }

  private drawToast(c: CanvasRenderingContext2D, w: number, text: string): void {
    c.save();
    c.font = '500 14px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillText(text, w / 2, 64);
    c.restore();
  }

  /**
   * What the ghost is saying.
   *
   * The voice is synthesised for prosody rather than for words, so the line
   * is deliberately not intelligible — you hear something speaking and the
   * caption tells you what. Set low and in a sickly green so it reads as the
   * house talking rather than as UI.
   */
  private drawSubtitle(c: CanvasRenderingContext2D, w: number, h: number, text: string): void {
    c.save();
    c.font = 'italic 500 15px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    const tw = c.measureText(text).width;
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(w / 2 - tw / 2 - 14, h - 118, tw + 28, 26);
    c.fillStyle = 'rgba(150,200,150,0.88)';
    c.fillText(text, w / 2, h - 100);
    c.restore();
  }

  /**
   * How many are left.
   *
   * Both sides see this. For survivors it is the dread of the number falling;
   * for the ghost it is the score. It carries no names and no positions, so it
   * gives away nothing about where anyone is.
   */
  private drawSurvivorTally(
    c: CanvasRenderingContext2D, w: number, h: number, state: GameState, role: Role,
  ): void {
    const alive = state.survivors.filter((s) => s.alive && !s.escaped).length;
    const out = state.survivors.filter((s) => s.escaped).length;
    const total = state.survivors.length;

    c.save();
    c.font = '400 12px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'left';
    c.fillStyle = 'rgba(255,255,255,0.45)';
    c.fillText(`${alive}/${total} still inside`, 18, h - 22);
    if (out > 0) {
      c.fillStyle = 'rgba(140,220,160,0.6)';
      c.fillText(`${out} escaped`, 18, h - 38);
    }
    if (role === 'ghost' && state.key.taken) {
      c.fillStyle = 'rgba(255,190,90,0.8)';
      c.fillText('someone has the key', 18, h - 54);
    }
    c.restore();
    void PULSE;
    void w;
  }
}
