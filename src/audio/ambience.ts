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
 *   - One-off calls taking turns, the first 7s in and then 7-12s apart: a
 *     wolf howling outside, an owl, then something screaming inside the
 *     house, and round again.
 *
 * The whole thing ducks when a jumpscare fires, because the scare owns that
 * moment, and it tightens as the match goes on.
 */

/** The wolf, served from `public/`. */
const HOWL_URL = 'assets/werewolf-howl.mp3';
/** Seconds of silence at the top of the recording. */
const HOWL_LEAD_IN = 0.26;
/**
 * The howl's level on the event bus.
 *
 * 0.55 was tuned to sit with the synthesised events, and in play it simply
 * went unheard under the bed, so it is set to stand out: loud enough to stop
 * you in a corridor, still under the event limiter.
 * `tools/ambiencetest.mjs` checks it clears the bed.
 */
const HOWL_GAIN = 0.8;
/** An owl in the grounds, which took over from the synthesised dogs. */
const OWL_URL = 'assets/owl-hoot.mp3';
/** Seconds of silence at the top of the recording. */
const OWL_LEAD_IN = 0.84;
/**
 * The owl's level on the event bus.
 *
 * The recording is about 4dB hotter than the howl, and an owl should read as
 * the quieter, more ordinary night sound of the two, so it sits well under
 * the howl's level while still clearing the bed.
 */
const OWL_GAIN = 0.4;
/** Something screaming inside the house, which took over from the synthesised crying. */
const SCREAM_URL = 'assets/demon-scream.mp3';
/** Seconds of silence at the top of the recording. */
const SCREAM_LEAD_IN = 0.14;
/**
 * The scream's level on the event bus.
 *
 * The recording is about 1dB hotter than the howl; it sits just under it, so
 * the three calls land at much the same level and none of them dominates.
 */
const SCREAM_GAIN = 0.7;
/**
 * The one-off sounds take turns: the first 7s into the match, then each next
 * one 7-12 seconds after the last.
 *
 * A howl, then a hoot, then the scream, then the howl again, and so on (the
 * order is `rotation` in the class). They replaced every other one-off noise
 * in here: a small cast that keeps coming back reads as a place, where a
 * random scatter of creaks and cries read as a sound effects library. The gap
 * wanders so it never settles into a beat.
 */
const FIRST_CALL = 7;
const CALL_GAP = [7, 12] as const;

export class Ambience {
  /**
   * The bus every layer feeds.
   *
   * Readable so `tools/ambiencetest.mjs` can measure the layers against each
   * other; nothing in the game writes to it from outside.
   */
  readonly out: GainNode;
  /** The continuous layers: drone and wind. Deliberately quiet. */
  private readonly bed!: GainNode;
  /** One-off sounds: the howl, the owl and the scream. */
  private readonly events!: GainNode;
  private readonly nodes: { stop?: () => void; disconnect(): void }[] = [];
  private readonly drone: { osc: OscillatorNode[]; gain: GainNode } | null = null;
  private filter: BiquadFilterNode | null = null;
  private padTimer: number | null = null;
  /** The pending timer for the next call in the rotation. */
  private callTimer: number | null = null;
  private stopped = false;
  /** The decoded recordings, once they have arrived. */
  private howlBuffer: AudioBuffer | null = null;
  private owlBuffer: AudioBuffer | null = null;
  private screamBuffer: AudioBuffer | null = null;
  /** Resolves when the recordings have loaded (or failed to). Awaited by the tests. */
  readonly samplesReady: Promise<void>;

  /** 0 = calm, 1 = the ghost is close. Drives how ugly the bed becomes. */
  private dread = 0;
  /** Context time the current chase layer ends, so it is not restacked. */
  private panicUntil = 0;

  constructor(private readonly ctx: BaseAudioContext, destination: AudioNode) {
    this.samplesReady = Promise.all([
      this.loadSample(HOWL_URL).then((b) => { this.howlBuffer = b; }),
      this.loadSample(OWL_URL).then((b) => { this.owlBuffer = b; }),
      this.loadSample(SCREAM_URL).then((b) => { this.screamBuffer = b; }),
    ]).then(() => undefined);

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    /*
     * Two buses: the bed, and the things that happen.
     *
     * Everything used to share one, and the events were written at gains that
     * look reasonable in isolation — 0.045 for a bark, 0.03 for a sob — but
     * which sat at almost exactly the level of the drone and wind they had to
     * cut through. Measured, every event came out between 1.00x and 1.05x the
     * bed, which is another way of saying inaudible.
     *
     * The fix is at both ends. The event gains themselves were an order of
     * magnitude too small — no bus multiplier large enough to rescue them
     * would have left any headroom — and the drone and wind were loud enough
     * that nothing short of a shout could get over them. A bed is meant to be
     * felt rather than listened to, so it belongs well under whatever happens
     * on top of it.
     * `tools/ambiencetest.mjs` measures the ratio and fails below 1.5x.
     */
    this.bed = ctx.createGain();
    this.bed.gain.value = 0.28;
    this.bed.connect(this.out);

    this.events = ctx.createGain();
    this.events.gain.value = 1.6;

    /*
     * A limiter on the event bus.
     *
     * The recordings are mastered hot, and a slow howl pitched down runs
     * long enough that the next call can start under its tail. A compressor
     * with a hard ratio and a fast attack costs nothing and means a loud
     * moment is squashed rather than distorted.
     */
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;
    this.events.connect(limiter).connect(this.out);

    this.drone = this.buildDrone();
    this.buildWind();
    this.scheduleNextPad();
    this.scheduleNextCall(0);

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

    lp.connect(gain).connect(this.bed);
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

    src.connect(bp).connect(gain).connect(this.bed);
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
    lp.connect(g).connect(this.bed);
  }

  /**
   * The one-off sounds, in the order they take turns.
   *
   * To add a sound to the rotation, give it a method like `howl` and add it
   * here; it slots in after the last one, 7-12s on, and the cycle comes back
   * round to the first.
   */
  private readonly rotation: ((t: number) => void)[] = [
    (t) => this.howl(t),
    (t) => this.owl(t),
    (t) => this.scream(t),
  ];

  /**
   * Queue call number `n` of the rotation: the first at `FIRST_CALL`, then
   * each next one 7-12s after the last, so they strictly take turns.
   *
   * These are not positional: they come from the house, not from a place in
   * it, so they can never be mistaken for a player.
   */
  private scheduleNextCall(n: number): void {
    if (this.stopped) return;
    const wait = n === 0
      ? FIRST_CALL
      : CALL_GAP[0] + Math.random() * (CALL_GAP[1] - CALL_GAP[0]);
    this.callTimer = window.setTimeout(() => {
      this.callTimer = null;
      if (this.stopped) return;
      this.rotation[n % this.rotation.length](this.ctx.currentTime);
      this.scheduleNextCall(n + 1);
    }, wait * 1000);
  }

  /**
   * Play one of the recordings on the event bus.
   *
   * Each is close-miked, so it is rolled off above `cutoff` the way distance
   * would roll it off, re-pitched within `rate` so the same take never plays
   * twice alike, and started past its opening silence so it lands when fired.
   */
  private playSample(
    buf: AudioBuffer | null, t: number, leadIn: number, gain: number,
    cutoff: number, rate: readonly [number, number],
  ): void {
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate[0] + Math.random() * (rate[1] - rate[0]);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(lp).connect(g).connect(this.events);
    src.start(t, Math.min(leadIn, buf.duration));
  }

  /**
   * Fetch and decode one of the recordings.
   *
   * Loaded once, when the ambience starts, so each sound plays from a decoded
   * buffer rather than waiting on the network. A failure is silent: the house
   * simply goes without that sound, which costs atmosphere, not the match.
   */
  private async loadSample(url: string): Promise<AudioBuffer | null> {
    try {
      const base = import.meta.env.BASE_URL || '/';
      const res = await fetch((base.endsWith('/') ? base : `${base}/`) + url);
      if (!res.ok) return null;
      return await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * A wolf, a long way off.
   *
   * A recording, not a synthesis. The synthesised howl — a sawtooth glide
   * through a formant filter — read as a synthesiser however it was shaped,
   * and a howl is exactly the sound where that gives the game away.
   */
  /** @internal — exposed for `tools/ambiencetest.mjs`. */
  howl(t: number): void {
    this.playSample(this.howlBuffer, t, HOWL_LEAD_IN, HOWL_GAIN, 3400, [0.9, 1.04]);
  }

  /**
   * An owl, out in the grounds.
   *
   * A recording, replacing the synthesised dogs: a burst of filtered sawtooth
   * barks that never quite read as an animal. It does the same job they did:
   * tells you there is a world beyond these walls that you are cut off from.
   */
  /** @internal — exposed for `tools/ambiencetest.mjs`. */
  owl(t: number): void {
    this.playSample(this.owlBuffer, t, OWL_LEAD_IN, OWL_GAIN, 3000, [0.94, 1.04]);
  }

  /**
   * Something screaming, somewhere else in the house.
   *
   * A recording, in the slot the synthesised crying had: the one call in the
   * rotation that is inside with you rather than out in the grounds. Rolled
   * off a little less than the animals, since it is only a few rooms away.
   */
  /** @internal — exposed for `tools/ambiencetest.mjs`. */
  scream(t: number): void {
    this.playSample(this.screamBuffer, t, SCREAM_LEAD_IN, SCREAM_GAIN, 4200, [0.92, 1.04]);
  }

  /**
   * How frightened the house should sound, 0..1.
   *
   * Driven by how close the ghost is. As it rises the bed grows darker, so a
   * player learns to read it as a proximity sense without ever being told a
   * number.
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
    if (this.callTimer !== null) clearTimeout(this.callTimer);
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
