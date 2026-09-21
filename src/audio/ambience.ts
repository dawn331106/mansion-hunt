/**
 * The sound of the house itself.
 *
 * Silence in a horror game is not tense, it is empty — and worse, it makes
 * every deliberate sound feel like a cue rather than a discovery. What the
 * design needs is a floor of unease that never quite resolves, so that a real
 * footstep arrives *out of* something rather than out of nothing.
 *
 * It is synthesised rather than a looping audio file. A loop of a few seconds
 * is recognisable within a minute and then actively breaks the spell, whereas
 * these layers drift on their own periods and never repeat:
 *
 *   - A sub-bass drone that slowly detunes, felt more than heard.
 *   - Filtered noise "wind", panning slowly, with a filter that breathes.
 *   - A dissonant pad that swells and fades every half minute or so.
 *   - Occasional one-off noises — a creak, a distant knock, a settling beam —
 *     fired at random intervals from random directions.
 *
 * The whole thing ducks when a jumpscare fires, because the scare owns that
 * moment, and it tightens as the match goes on.
 */

export class Ambience {
  private readonly out: GainNode;
  private readonly nodes: { stop?: () => void; disconnect(): void }[] = [];
  private readonly drone: { osc: OscillatorNode[]; gain: GainNode } | null = null;
  private filter: BiquadFilterNode | null = null;
  private padTimer: number | null = null;
  private eventTimer: number | null = null;
  private stopped = false;

  /** 0 = calm, 1 = the ghost is close. Drives how ugly the bed becomes. */
  private dread = 0;
  /** Context time the current chase layer ends, so it is not restacked. */
  private panicUntil = 0;

  constructor(private readonly ctx: AudioContext, destination: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    this.drone = this.buildDrone();
    this.buildWind();
    this.scheduleNextPad();
    this.scheduleNextEvent();

    // Fade in, so starting a match does not begin with a click.
    this.out.gain.setTargetAtTime(0.5, ctx.currentTime, 2.0);
  }

  /**
   * Two detuned sines an octave apart, near the bottom of hearing.
   *
   * The detuning is what makes it unsettling: a beat frequency of under a
   * hertz means the sound never settles, and the listener cannot tell whether
   * it is getting louder or they are imagining it.
   */
  private buildDrone(): { osc: OscillatorNode[]; gain: GainNode } {
    const gain = this.ctx.createGain();
    gain.gain.value = 0.42;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;

    const osc: OscillatorNode[] = [];
    for (const [freq, level] of [[36.5, 1.0], [37.1, 0.85], [73.0, 0.30]] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(lp);
      o.start();
      osc.push(o);
      this.nodes.push({ stop: () => { try { o.stop(); } catch { /* stopped */ } }, disconnect: () => o.disconnect() });
    }

    // A very slow swell, so the floor of the mix is never static.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.037;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.value = 0.16;
    lfo.connect(lfoDepth).connect(gain.gain);
    lfo.start();
    this.nodes.push({ stop: () => { try { lfo.stop(); } catch { /* stopped */ } }, disconnect: () => lfo.disconnect() });

    lp.connect(gain).connect(this.out);
    return { osc, gain };
  }

  /**
   * Wind: looping noise through a filter that opens and closes.
   *
   * A static noise bed reads as tape hiss. Moving the filter turns the same
   * noise into air moving through a building, which is a sound with a cause.
   */
  private buildWind(): void {
    const seconds = 8;
    const buf = this.ctx.createBuffer(2, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        // Brown-ish noise: far less harsh than white, and it sits underneath
        // dialogue and footsteps instead of masking them.
        last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995;
        d[i] = last * 3.2;
      }
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 340;
    bp.Q.value = 0.7;
    this.filter = bp;

    // The filter breathes on its own slow cycle.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.055;
    const depth = this.ctx.createGain();
    depth.gain.value = 190;
    lfo.connect(depth).connect(bp.frequency);
    lfo.start();

    const gain = this.ctx.createGain();
    gain.gain.value = 0.30;

    src.connect(bp).connect(gain).connect(this.out);
    src.start();

    this.nodes.push({ stop: () => { try { src.stop(); lfo.stop(); } catch { /* stopped */ } },
                      disconnect: () => { src.disconnect(); lfo.disconnect(); } });
  }

  /**
   * A dissonant pad that swells in and out.
   *
   * Two notes a semitone apart, which the ear reads as wrong without being
   * able to say why. Scheduled at an irregular interval so the player cannot
   * learn its rhythm and stop flinching at it.
   */
  private scheduleNextPad(): void {
    if (this.stopped) return;
    const wait = 14000 + Math.random() * 26000;
    this.padTimer = window.setTimeout(() => {
      this.playPad();
      this.scheduleNextPad();
    }, wait);
  }

  private playPad(): void {
    const t = this.ctx.currentTime;
    const dur = 6 + Math.random() * 6;
    const root = 98 * Math.pow(2, Math.floor(Math.random() * 3) / 12);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.055 + this.dread * 0.05, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(0, t + dur);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;

    for (const mult of [1, 1.0595, 1.498]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = root * mult;
      // A slow drift out of tune, so it never sounds like an instrument.
      o.detune.setValueAtTime(0, t);
      o.detune.linearRampToValueAtTime((Math.random() - 0.5) * 40, t + dur);
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    lp.connect(g).connect(this.out);
  }

  /**
   * One-off noises: a creak, a knock, a beam settling.
   *
   * These are the layer that makes players turn around. They are deliberately
   * *not* positional — they come from the house, not from a place — so they
   * can never be mistaken for another player and never mislead a ghost.
   */
  private scheduleNextEvent(): void {
    if (this.stopped) return;
    const wait = (7000 + Math.random() * 15000) * (1 - this.dread * 0.45);
    this.eventTimer = window.setTimeout(() => {
      this.playEvent();
      this.scheduleNextEvent();
    }, wait);
  }

  private playEvent(): void {
    const t = this.ctx.currentTime;
    const kind = Math.random();

    /*
     * The rarer, louder events come first and are checked against a small
     * slice of the range, so a howl or a cry is an occasional shock rather
     * than furniture. The creaks and knocks below are the common case.
     */
    if (kind < 0.10) { this.howl(t); return; }
    if (kind < 0.19) { this.hounds(t); return; }
    if (kind < 0.27) { this.crying(t); return; }

    if (kind < 0.4) {
      // A creak: a filtered sweep, like weight shifting on old timber.
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 120 + Math.random() * 140;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (0.55 + Math.random() * 0.3), t + 0.9);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 420;
      bp.Q.value = 6;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 1.1);
      o.connect(bp).connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 1.2);
    } else if (kind < 0.72) {
      // A distant knock: two thuds, deep and short.
      for (let i = 0; i < 2; i++) {
        const at = t + i * 0.17;
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(90, at);
        o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.10, at);
        g.gain.exponentialRampToValueAtTime(0.0005, at + 0.22);
        o.connect(g).connect(this.out);
        o.start(at);
        o.stop(at + 0.3);
      }
    } else {
      // Settling dust: a short hiss, high and quiet, easy to miss.
      const len = Math.floor(this.ctx.sampleRate * 0.6);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2400;
      const g = this.ctx.createGain();
      g.gain.value = 0.035;
      src.connect(hp).connect(g).connect(this.out);
      src.start(t);
    }
  }

  /**
   * A wolf, a long way off.
   *
   * A slow upward glide into a held note, then a long fall — the shape of a
   * howl is almost entirely in that rise and the sustain at the top. Two
   * voices slightly apart make it read as distance rather than as a
   * synthesiser, because a single clean tone sounds electronic however it
   * is shaped.
   */
  private howl(t: number): void {
    const dur = 2.6 + Math.random() * 1.2;
    const base = 220 + Math.random() * 90;

    for (const [mult, level, delay] of [[1, 0.055, 0], [1.006, 0.04, 0.14]] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      const at = t + delay;
      o.frequency.setValueAtTime(base * 0.55 * mult, at);
      o.frequency.exponentialRampToValueAtTime(base * mult, at + dur * 0.28);
      o.frequency.setValueAtTime(base * mult, at + dur * 0.55);
      o.frequency.exponentialRampToValueAtTime(base * 0.42 * mult, at + dur);

      // A formant filter turns the saw into something with a throat.
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 780;
      bp.Q.value = 4.5;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      // Heavily rolled off, which is what distance does to a sound.
      lp.frequency.value = 1500;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(level, at + dur * 0.22);
      g.gain.setValueAtTime(level, at + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0004, at + dur);

      o.connect(bp).connect(lp).connect(g).connect(this.out);
      o.start(at);
      o.stop(at + dur + 0.2);
    }
  }

  /**
   * Dogs, somewhere outside the compound.
   *
   * Street dogs setting each other off is one of the most characteristic
   * night sounds of the setting, and it does something specific here: it
   * tells you there is a world beyond these walls that you are cut off from.
   * Barks are short filtered bursts at irregular intervals, because a regular
   * rhythm reads as a machine.
   */
  private hounds(t: number): void {
    const barks = 3 + Math.floor(Math.random() * 5);
    let at = t;
    for (let i = 0; i < barks; i++) {
      const dur = 0.11 + Math.random() * 0.06;
      const f0 = 300 + Math.random() * 180;

      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 1.5, at);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.7, at + dur);

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + Math.random() * 400;
      bp.Q.value = 2.2;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.045, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0004, at + dur);

      o.connect(bp).connect(lp).connect(g).connect(this.out);
      o.start(at);
      o.stop(at + dur + 0.05);

      // Uneven spacing, with the odd flurry.
      at += dur + 0.09 + Math.random() * 0.34;
    }
  }

  /**
   * A child crying, far off and indistinct.
   *
   * The most unpleasant sound in here, and the one that does the most work.
   * It is built as a voice — a buzz through formants — rather than as a tone,
   * with a sobbing amplitude that catches and restarts. Kept quiet and
   * heavily filtered so it is never quite clear enough to locate, which is
   * the point: you are never sure whether you heard it.
   */
  private crying(t: number): void {
    const sobs = 4 + Math.floor(Math.random() * 4);
    const base = 300 + Math.random() * 80;

    const bus = this.ctx.createGain();
    bus.gain.value = 1;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1300;
    bus.connect(lp).connect(this.out);

    let at = t;
    for (let i = 0; i < sobs; i++) {
      const dur = 0.34 + Math.random() * 0.22;
      const f = base * (1 - i * 0.045);

      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      // Each sob rises then breaks downward.
      o.frequency.setValueAtTime(f * 0.85, at);
      o.frequency.exponentialRampToValueAtTime(f * 1.18, at + dur * 0.3);
      o.frequency.exponentialRampToValueAtTime(f * 0.7, at + dur);

      // Two formants near a crying vowel.
      const f1 = this.ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 640;
      f1.Q.value = 7;
      const f2 = this.ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1180;
      f2.Q.value = 8;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.030, at + dur * 0.18);
      g.gain.exponentialRampToValueAtTime(0.0004, at + dur);

      const mix = this.ctx.createGain();
      o.connect(f1).connect(mix);
      o.connect(f2).connect(mix);
      mix.connect(g).connect(bus);
      o.start(at);
      o.stop(at + dur + 0.1);

      // The catch between sobs is what makes it read as crying.
      at += dur + 0.10 + Math.random() * 0.14;
    }
    setTimeout(() => { bus.disconnect(); lp.disconnect(); }, (at - t + 2) * 1000);
  }

  /**
   * How frightened the house should sound, 0..1.
   *
   * Driven by how close the ghost is. As it rises the bed grows darker and
   * the random noises come more often, so a player learns to read the music
   * as a proximity sense without ever being told a number.
   */
  setDread(v: number): void {
    this.dread = Math.max(0, Math.min(1, v));
    const t = this.ctx.currentTime;
    if (this.filter) {
      this.filter.frequency.setTargetAtTime(340 + this.dread * 520, t, 1.2);
      this.filter.Q.setTargetAtTime(0.7 + this.dread * 2.4, t, 1.2);
    }
    if (this.drone) {
      this.drone.gain.gain.setTargetAtTime(0.42 + this.dread * 0.38, t, 1.5);
    }
  }

  /**
   * Chase music: the house panicking because you have been seen.
   *
   * Everything else here drifts and never resolves, which is right for dread
   * but wrong for a chase — being hunted needs a pulse, something that tells
   * your body to move. This adds a fast, hard heartbeat under a rising
   * dissonant swell, holds it while the chase lasts, and then lets it decay,
   * so the music going quiet again is itself a piece of information: it means
   * you got away.
   */
  panic(seconds: number): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    // Restarting the layer on every re-spot would stack drones on top of each
    // other; extend the existing one instead.
    if (this.panicUntil > t) {
      this.panicUntil = t + seconds;
      return;
    }
    this.panicUntil = t + seconds;

    const bus = this.ctx.createGain();
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(1, t + 0.25);
    bus.connect(this.out);

    // --- A tritone swell: the interval the ear reads as alarm. ---
    for (const [f, level] of [[146.8, 0.10], [207.7, 0.085], [293.7, 0.05]] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.setValueAtTime(-8, t);
      o.detune.linearRampToValueAtTime(10, t + seconds);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(600, t);
      lp.frequency.linearRampToValueAtTime(1700, t + seconds * 0.4);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.5);
      g.gain.setValueAtTime(level, t + seconds * 0.72);
      g.gain.exponentialRampToValueAtTime(0.0005, t + seconds);
      o.connect(lp).connect(g).connect(bus);
      o.start(t);
      o.stop(t + seconds + 0.2);
    }

    // --- The heartbeat: two thumps a beat apart, accelerating. ---
    const bpmStart = 96;
    const bpmEnd = 138;
    let beat = 0;
    let at = t + 0.1;
    while (at < t + seconds) {
      const k = (at - t) / seconds;
      const bpm = bpmStart + (bpmEnd - bpmStart) * k;
      const period = 60 / bpm;
      const fade = 1 - Math.max(0, (k - 0.75) / 0.25);

      for (const [off, amp] of [[0, 0.30], [period * 0.32, 0.20]] as const) {
        const bt = at + off;
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(86, bt);
        o.frequency.exponentialRampToValueAtTime(38, bt + 0.13);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(amp * fade, bt);
        g.gain.exponentialRampToValueAtTime(0.0005, bt + 0.21);
        o.connect(g).connect(bus);
        o.start(bt);
        o.stop(bt + 0.26);
      }
      at += period;
      beat++;
      if (beat > 400) break;
    }

    setTimeout(() => bus.disconnect(), (seconds + 1) * 1000);
  }

  /** Duck the bed, for the moment a scare owns the screen. */
  duck(seconds: number): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0.04, t + 0.08);
    this.out.gain.linearRampToValueAtTime(0.5, t + seconds);
  }

  stop(): void {
    this.stopped = true;
    if (this.padTimer !== null) clearTimeout(this.padTimer);
    if (this.eventTimer !== null) clearTimeout(this.eventTimer);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.4);
    // Let the fade finish before tearing the graph down.
    setTimeout(() => {
      for (const n of this.nodes) { n.stop?.(); n.disconnect(); }
      this.out.disconnect();
    }, 1200);
  }
}
