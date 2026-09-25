import { AUDIO } from '../game/config.js';
import { Ambience } from './ambience.js';
import { createGhostVoice, ensureGhostWorklet, type GhostVoiceChain } from './ghostVoice.js';

/**
 * The world's ears.
 *
 * Every sound that carries information — footsteps, the ghost's voice, an
 * almirah door — is placed in space through a PannerNode, so "louder when
 * nearer" is not a volume curve anyone has to write: it falls out of the
 * listener's position, which the renderer updates from the camera each frame.
 *
 * With no minimap, this is the primary way a player knows anything about where
 * other people are. It is a navigation instrument, not decoration.
 */

/** Where the ghost's chant comes from, vertically: roughly its mouth. */
const GHOST_MOUTH_HEIGHT = 1.75;

/**
 * The catch, as a recording.
 *
 * The file opens with 2.44s of silence before the scream. Played from the top
 * it would land after the scare was already over, so it is always started
 * just short of the onset, and the sound hits on the frame the ghost does.
 */
const JUMPSCARE_URL = 'assets/jumpscare.mp3';
const JUMPSCARE_ONSET = 2.42;
/**
 * The recording is mastered very hot: it peaks above full scale and averages
 * around -5dB. At 0.5 it is still the loudest thing the game ever plays,
 * which is the point, without clipping the master.
 */
const JUMPSCARE_GAIN = 0.5;

/**
 * The ghost's voice: a demon speaking Latin, on a continuous loop.
 *
 * It replaces the synthesised taunts. The recording fades in over its first
 * quarter second and out over its last half, so the loop skips both and a
 * repetition reads as a breath rather than as the track starting over.
 */
const CHANT_URL = 'assets/ghost-chant.mp3';
const CHANT_LOOP_START = 0.25;
const CHANT_LOOP_END = 26.1;
/**
 * The chant's level at the panner.
 *
 * The recording is quiet — it peaks around -15dB and averages -34dB — so it
 * needs real gain to carry across a room. It is not loud next to a footstep
 * up close; it is the thing you hear first, two rooms away, and track.
 */
const CHANT_GAIN = 2.6;

/**
 * Recorded footsteps: a take of single steps, cut apart at load.
 *
 * The file is eight separate footfalls about 0.6s apart. Each is cut out on
 * its own, from just before its attack to just before the next one begins,
 * and one is picked at random for every step, so a run never repeats a
 * sample twice in a row the way a loop would.
 */
const FOOTSTEPS_URL = 'assets/footsteps.mp3';
/** Longest a single cut step may be; the tail past this is room noise. */
const STEP_MAX_SECONDS = 0.45;
/**
 * The recorded steps' level, against the synthesised ones they replace.
 *
 * Set to land where the synthesised steps did, measured over each step's
 * first 100ms (the part that carries): footsteps are the game's main warning
 * system, and changing their loudness would change how far away people seem.
 * At 1.1 a cut step peaks just under full scale.
 */
const STEP_GAIN = 1.1;

/**
 * Being spotted, as a recording.
 *
 * It replaced the synthesised shriek. The file is mastered to full scale, so
 * it is brought well under the jumpscare, which has to stay the loudest thing
 * in the game.
 */
const SPOTTED_URL = 'assets/spotted.mp3';
const SPOTTED_GAIN = 0.4;

/** Resolve a file in `public/` against wherever the game is served from. */
function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return (base.endsWith('/') ? base : `${base}/`) + path;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  /** Everything diegetic routes through here, so it can duck as one. */
  private readonly world: GainNode;
  /** Stingers and UI sit outside the world bus and never attenuate. */
  private readonly ui: GainNode;

  private readonly voices = new Map<string, {
    panner: PannerNode;
    chain: GhostVoiceChain | null;
    gain: GainNode;
    source: MediaStreamAudioSourceNode | null;
  }>();

  /**
   * Reused footstep buffers.
   *
   * Starts as synthesised steps, so footsteps work from the first frame, and
   * is swapped for the recorded ones once they have loaded.
   */
  private stepBuffers: AudioBuffer[] = [];
  /** Whether `stepBuffers` holds the recording yet. */
  private stepsRecorded = false;

  /** The house's own voice: drone, wind, creaks. Started on resume. */
  private ambience: Ambience | null = null;
  /** The decoded jumpscare recording, once it has arrived. */
  private jumpscareBuffer: AudioBuffer | null = null;
  /** The decoded spotted recording, once it has arrived. */
  private spottedBuffer: AudioBuffer | null = null;
  /** The spotted sound currently playing, so a re-spot or a catch can cut it. */
  private spottedPlaying: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  /** The ghost's looping chant, once it is playing. */
  private chant: { source: AudioBufferSourceNode; panner: PannerNode; gain: GainNode } | null = null;
  /** Set once the chant has been asked for, so it is only ever started once. */
  private chantRequested = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.world = this.ctx.createGain();
    this.ui = this.ctx.createGain();
    this.world.connect(this.master);
    this.ui.connect(this.master);
    this.master.connect(this.ctx.destination);

    // Inverse-distance rolloff throughout, which is how real sound behaves and
    // therefore what a player's intuition about distance is calibrated to.
    this.ctx.listener.upX?.setValueAtTime(0, this.ctx.currentTime);
    this.ctx.listener.upY?.setValueAtTime(1, this.ctx.currentTime);
    this.ctx.listener.upZ?.setValueAtTime(0, this.ctx.currentTime);

    for (let i = 0; i < 4; i++) this.stepBuffers.push(this.makeFootstep(i));
    void this.loadJumpscare();
    void this.loadSpotted();
    void this.loadFootsteps();
  }

  /**
   * Fetch the footstep recording and cut it into single steps.
   *
   * If it fails, the synthesised steps simply stay: a survivor who cannot hear
   * footsteps has lost the only way to know where anyone is.
   */
  private async loadFootsteps(): Promise<void> {
    try {
      const res = await fetch(assetUrl(FOOTSTEPS_URL));
      if (!res.ok) return;
      const steps = this.cutSteps(await this.ctx.decodeAudioData(await res.arrayBuffer()));
      if (steps.length > 0) {
        this.stepBuffers = steps;
        this.stepsRecorded = true;
      }
    } catch {
      /* Keep the synthesised steps. */
    }
  }

  /**
   * Find each footfall in a recording of several and cut it out.
   *
   * A step is where the signal jumps above a fifth of the recording's peak
   * after at least 0.3s of nothing that loud — every footfall has a hard
   * attack and the gaps between them are quiet, so this is enough. Each cut
   * starts 5ms before the attack, stops before the next step or after
   * `STEP_MAX_SECONDS`, is mixed to mono for the panner, and fades out over
   * its last 60ms so it never ends on a click.
   */
  private cutSteps(buf: AudioBuffer): AudioBuffer[] {
    const rate = buf.sampleRate;
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
    if (peak === 0) return [];

    const threshold = peak * 0.2;
    const gap = Math.floor(rate * 0.3);
    const onsets: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(mono[i]) < threshold) continue;
      if (onsets.length === 0 || i - onsets[onsets.length - 1] > gap) onsets.push(i);
    }

    const lead = Math.floor(rate * 0.005);
    const fade = Math.floor(rate * 0.06);
    return onsets.map((onset, k) => {
      const start = Math.max(0, onset - lead);
      const next = k + 1 < onsets.length ? onsets[k + 1] - lead : n;
      const len = Math.min(next - start, Math.floor(rate * STEP_MAX_SECONDS));
      const out = this.ctx.createBuffer(1, len, rate);
      const d = out.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const tail = i > len - fade ? (len - i) / fade : 1;
        d[i] = mono[start + i] * STEP_GAIN * tail;
      }
      return out;
    });
  }

  /**
   * Fetch and decode the jumpscare recording up front.
   *
   * A catch can come at any moment, and a scare that waits on the network is
   * not a scare. Decoding works on a suspended context, so this starts at
   * construction, long before the first click. If it fails the synthesised
   * stinger plays instead: a silent catch would be worse than either.
   */
  /**
   * Fetch and decode the spotted recording up front, for the same reason as
   * the jumpscare: it has to land on the frame the ghost sees you.
   */
  private async loadSpotted(): Promise<void> {
    try {
      const res = await fetch(assetUrl(SPOTTED_URL));
      if (!res.ok) return;
      this.spottedBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      /* The spot goes unannounced; the chase layer below still starts. */
    }
  }

  private async loadJumpscare(): Promise<void> {
    try {
      const res = await fetch(assetUrl(JUMPSCARE_URL));
      if (!res.ok) return;
      this.jumpscareBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      /* Fall back to the synthesised stinger. */
    }
  }

  /** Browsers block audio until a gesture; call this from a click. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await ensureGhostWorklet(this.ctx).catch(() => { /* fallback handles it */ });
  }

  /**
   * Start the ambient bed.
   *
   * Separate from `resume` because it should begin when the match does, not
   * when the context wakes — a drone playing under the menu is atmosphere
   * wasted before anyone is in the house to be unsettled by it.
   */
  startAmbience(): void {
    if (!this.ambience) this.ambience = new Ambience(this.ctx, this.world);
  }

  /** How close the ghost feels, 0..1. Darkens the ambient bed. */
  setDread(v: number): void {
    this.ambience?.setDread(v);
  }

  /**
   * Move the listener to the camera.
   *
   * Called every frame. Orientation matters as much as position: without it
   * the panner cannot tell left from right, and footsteps behind you sound
   * exactly like footsteps in front.
   */
  setListener(x: number, y: number, z: number, yaw: number, pitch: number): void {
    const l = this.ctx.listener;
    const fx = Math.cos(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = Math.sin(yaw) * Math.cos(pitch);

    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(x, t, 0.02);
      l.positionY.setTargetAtTime(y, t, 0.02);
      l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(fy, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
    } else {
      // Older Safari.
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
      (l as unknown as { setOrientation(...a: number[]): void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** A footstep at a world position. */
  footstep(x: number, z: number, volume: number): void {
    const buf = this.stepBuffers[(Math.random() * this.stepBuffers.length) | 0];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // Slight random pitch, so a run does not sound like a metronome. The
    // recording has variety of its own, so it needs less help.
    src.playbackRate.value = this.stepsRecorded
      ? 0.94 + Math.random() * 0.12
      : 0.9 + Math.random() * 0.2;

    const gain = this.ctx.createGain();
    gain.gain.value = volume;

    const panner = this.makePanner(AUDIO.footstepRefDistance, AUDIO.footstepMaxDistance);
    this.positionPanner(panner, x, 0.1, z);

    src.connect(gain).connect(panner).connect(this.world);
    src.start();
    src.onended = () => { src.disconnect(); gain.disconnect(); panner.disconnect(); };
  }

  /**
   * Attach a live voice stream at a world position.
   *
   * `ghostly` routes it through the effect chain. Survivor voices are left
   * alone: the asymmetry is the point — the ghost's voice is the thing you
   * dread hearing, and it only reads that way if it does not sound like
   * everyone else.
   */
  async addVoice(id: string, stream: MediaStream, ghostly: boolean): Promise<void> {
    await this.resume();
    this.removeVoice(id);

    const source = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const panner = this.makePanner(AUDIO.voiceRefDistance, AUDIO.voiceMaxDistance);

    let chain: GhostVoiceChain | null = null;
    if (ghostly) {
      chain = createGhostVoice(this.ctx);
      source.connect(chain.input);
      chain.output.connect(gain);
    } else {
      source.connect(gain);
    }
    gain.connect(panner).connect(this.world);

    this.voices.set(id, { panner, chain, gain, source });
  }

  /**
   * Move a voice and, for the ghost, tighten the effect as it closes in.
   *
   * `listenerDist` drives the intensity ramp — far away it is a warped
   * whisper, at catching distance it is fully inhuman.
   */
  moveVoice(id: string, x: number, y: number, z: number, listenerDist: number): void {
    const v = this.voices.get(id);
    if (!v) return;
    this.positionPanner(v.panner, x, y, z);
    if (v.chain) {
      const k = 1 - Math.min(1, listenerDist / AUDIO.voiceMaxDistance);
      v.chain.setIntensity(k);
    }
  }

  removeVoice(id: string): void {
    const v = this.voices.get(id);
    if (!v) return;
    v.source?.disconnect();
    v.chain?.dispose();
    v.gain.disconnect();
    v.panner.disconnect();
    this.voices.delete(id);
  }

  /**
   * Start the ghost's chant, looping from where the ghost is.
   *
   * Routed through a panner exactly like a footstep, so proximity and
   * direction come out of the listener's position rather than a hand-written
   * volume curve: it carries across the house faintly and without a clear
   * bearing, and is loud and placed when the ghost is close. It never stops
   * while the match runs, so the ghost is always somewhere you can hear.
   *
   * A decode failure is silent: the ghost loses its voice, not the match.
   */
  async startGhostChant(x: number, z: number): Promise<void> {
    if (this.chantRequested) return;
    this.chantRequested = true;
    try {
      const res = await fetch(assetUrl(CHANT_URL));
      if (!res.ok) return;
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      if (this.ctx.state === 'closed') return;

      const panner = this.makePanner(AUDIO.chantRefDistance, AUDIO.chantMaxDistance);
      // A voice carries further than a footfall does; see the config.
      panner.rolloffFactor = 0.9;
      this.positionPanner(panner, x, GHOST_MOUTH_HEIGHT, z);

      const gain = this.ctx.createGain();
      gain.gain.value = CHANT_GAIN;

      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.loopStart = Math.min(CHANT_LOOP_START, buf.duration);
      source.loopEnd = Math.min(CHANT_LOOP_END, buf.duration);
      source.connect(gain).connect(panner).connect(this.world);
      source.start(0, source.loopStart);
      this.chant = { source, panner, gain };
    } catch {
      /* No chant is survivable. */
    }
  }

  /** Keep the chant at the ghost's mouth as it moves. */
  moveGhostChant(x: number, z: number): void {
    if (this.chant) this.positionPanner(this.chant.panner, x, GHOST_MOUTH_HEIGHT, z);
  }

  /** A non-positional stinger: the jumpscare, the key pickup, the pulse. */
  stinger(kind: 'jumpscare' | 'pulse' | 'key' | 'hide' | 'unhide' | 'escape' | 'spotted'): void {
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'jumpscare': this.jumpscareStinger(t); break;
      case 'spotted': this.spottedStinger(t); break;
      case 'pulse': this.tone(t, 180, 0.5, 0.18, 'sine'); break;
      case 'key': this.tone(t, 880, 0.25, 0.16, 'triangle'); break;
      case 'hide': this.noiseBurst(t, 0.16, 0.2, 900); break;
      case 'unhide': this.noiseBurst(t, 0.14, 0.18, 1200); break;
      case 'escape': this.tone(t, 520, 0.7, 0.2, 'sine'); break;
    }
  }

  /**
   * Being seen.
   *
   * The moment the ghost's eyes land on you is the most important information
   * the game can give a survivor, and with no map and no UI indicator it has
   * to be carried entirely by sound. It is a recording now, in place of the
   * synthesised shriek.
   *
   * A new spot restarts it rather than stacking a second copy, since the
   * ghost can lose you and find you again inside the recording's four
   * seconds. It plays for the survivor who was spotted, not for the ghost.
   * The ghost already knows.
   */
  private spottedStinger(t: number): void {
    this.cutSpotted(t, 0.05);
    const buf = this.spottedBuffer;
    if (buf) {
      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      const gain = this.ctx.createGain();
      gain.gain.value = SPOTTED_GAIN;
      source.connect(gain).connect(this.ui);
      source.start(t);
      const playing = { source, gain };
      this.spottedPlaying = playing;
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        if (this.spottedPlaying === playing) this.spottedPlaying = null;
      };
    }

    // The house holds its breath, then comes back louder.
    this.ambience?.panic(6.0);
  }

  /** Fade out the spotted sound, if it is still playing, over `fade` seconds. */
  private cutSpotted(t: number, fade: number): void {
    const p = this.spottedPlaying;
    if (!p) return;
    this.spottedPlaying = null;
    p.gain.gain.cancelScheduledValues(t);
    p.gain.gain.setValueAtTime(p.gain.gain.value, t);
    p.gain.gain.linearRampToValueAtTime(0, t + fade);
    try { p.source.stop(t + fade + 0.02); } catch { /* already stopped */ }
  }

  /**
   * The catch: the jumpscare recording, over a ducked world.
   */
  private jumpscareStinger(t: number): void {
    // The house goes quiet while the scare has the screen.
    this.ambience?.duck(4.2);
    // A spot seconds before the catch is still playing; the scare owns this.
    this.cutSpotted(t, 0.12);

    const buf = this.jumpscareBuffer;
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = JUMPSCARE_GAIN;
      src.connect(g).connect(this.ui);
      src.start(t, Math.min(JUMPSCARE_ONSET, buf.duration));
    } else {
      this.jumpscareSynth(t);
    }

    // Duck the world so the scare owns the moment, then bring it back.
    this.world.gain.cancelScheduledValues(t);
    this.world.gain.setValueAtTime(this.world.gain.value, t);
    this.world.gain.linearRampToValueAtTime(0.12, t + 0.05);
    this.world.gain.linearRampToValueAtTime(1.0, t + 2.2);
  }

  /**
   * The synthesised catch, for when the recording has not loaded.
   *
   * A hard scare needs three things at once: a transient loud enough to make
   * you flinch, a low sub that you feel rather than hear, and a dissonant tail
   * that keeps the moment going a beat longer than is comfortable.
   */
  private jumpscareSynth(t: number): void {
    this.ghostRoar(t);
    // 1. The transient: filtered noise, fast attack, immediate.
    const noise = this.ctx.createBufferSource();
    const len = Math.floor(this.ctx.sampleRate * 1.4);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    }
    noise.buffer = buf;
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1400;
    nf.Q.value = 0.8;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.85, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    noise.connect(nf).connect(ng).connect(this.ui);
    noise.start(t);

    // 2. The sub: a falling sine you feel in the chest.
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 1.1);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.7, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    sub.connect(sg).connect(this.ui);
    sub.start(t);
    sub.stop(t + 1.4);

    // 3. The tail: two detuned oscillators a tritone apart.
    for (const f of [311, 440]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * 0.94, t + 1.5);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      o.connect(g).connect(lp).connect(this.ui);
      o.start(t);
      o.stop(t + 1.6);
    }
  }

  /**
   * The ghost's roar — the "arrrgh" as it takes you.
   *
   * Part of the synthesised fallback, used only when the jumpscare recording
   * has not loaded. It is built the way a voice is: a buzzing source at roughly
   * vocal-fold frequency, shaped by two formant filters to make it read as a
   * throat rather than a synthesiser, with the pitch falling as it tears.
   *
   * It runs long and deliberately overstays, because the point is that
   * something has hold of you and is not finished.
   */
  private ghostRoar(t: number): void {
    const dur = 3.4;

    // --- The voice source: a harsh saw, pitch dropping as it strains. ---
    const bus = this.ctx.createGain();
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(1.0, t + 0.06);
    bus.gain.setValueAtTime(1.0, t + dur * 0.62);
    bus.gain.exponentialRampToValueAtTime(0.001, t + dur);
    bus.connect(this.ui);

    for (const [mult, level, detune] of [[1, 0.5, 0], [1.005, 0.4, 9], [0.5, 0.3, -6]] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = detune;
      const f0 = 118 * mult;
      // Up into the scream, then a long fall as it gives out.
      o.frequency.setValueAtTime(f0 * 0.8, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.45, t + 0.18);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + dur);

      const g = this.ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(bus);
      o.start(t);
      o.stop(t + dur + 0.1);
    }

    // --- Formants: two resonant peaks are what make noise sound like a
    //     throat. These sit roughly where a shouted vowel does, and drift
    //     downward so the cry sags as it goes on. ---
    const shaped = this.ctx.createGain();
    for (const [freq, q, gain] of [[620, 7, 1.0], [1180, 9, 0.7], [2500, 6, 0.35]] as const) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(freq, t);
      f.frequency.exponentialRampToValueAtTime(freq * 0.62, t + dur);
      f.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      bus.connect(f).connect(g).connect(shaped);
    }

    // --- Tear: hard saturation, so it distorts like a voice pushed past
    //     what it can produce. ---
    const shaper = this.ctx.createWaveShaper();
    const curve = new Float32Array(new ArrayBuffer(1024 * 4));
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 3.6);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';

    // --- Breath: noise under the voice, so it has air in it. ---
    const len = Math.floor(this.ctx.sampleRate * dur);
    const nb = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const nd = nb.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.6 + (Math.random() * 2 - 1) * 0.4;
      // Rasping amplitude, so the breath is ragged rather than smooth.
      const env = Math.pow(1 - i / len, 1.4) * (0.7 + 0.3 * Math.sin(i * 0.0021));
      nd[i] = last * env;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = nb;
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1500;
    nf.Q.value = 1.2;
    const ng = this.ctx.createGain();
    ng.gain.value = 0.30;

    // --- A long, dark tail: the house keeping the sound. ---
    const verb = this.ctx.createConvolver();
    const vlen = Math.floor(this.ctx.sampleRate * 2.4);
    const vb = this.ctx.createBuffer(2, vlen, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = vb.getChannelData(ch);
      let l = 0;
      for (let i = 0; i < vlen; i++) {
        l = l * 0.7 + (Math.random() * 2 - 1) * 0.3;
        d[i] = l * Math.pow(1 - i / vlen, 2.8);
      }
    }
    verb.buffer = vb;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.45;
    const dry = this.ctx.createGain();
    dry.gain.value = 0.85;

    const outG = this.ctx.createGain();
    outG.gain.value = 0.62;

    shaped.connect(shaper);
    noise.connect(nf).connect(ng).connect(shaper);
    shaper.connect(dry).connect(outG);
    shaper.connect(verb).connect(wet).connect(outG);
    outG.connect(this.ui);
    noise.start(t);
  }

  private tone(t: number, freq: number, dur: number, vol: number, type: OscillatorType): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ui);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noiseBurst(t: number, dur: number, vol: number, freq: number): void {
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.ui);
    src.start(t);
  }

  /**
   * Release the audio context.
   *
   * Browsers permit only a small number of concurrent AudioContexts, so a
   * match that ends without closing its own leaves the next one unable to
   * make a sound after a few rounds.
   */
  async close(): Promise<void> {
    this.ambience?.stop();
    this.ambience = null;
    for (const id of [...this.voices.keys()]) this.removeVoice(id);
    if (this.ctx.state !== 'closed') {
      await this.ctx.close().catch(() => { /* already closing */ });
    }
  }

  private makePanner(refDistance: number, maxDistance: number): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = maxDistance;
    // A rolloff above 1 makes sound fade faster than physics would, which is
    // what a building full of walls actually sounds like.
    p.rolloffFactor = 1.6;
    return p;
  }

  private positionPanner(p: PannerNode, x: number, y: number, z: number): void {
    if (p.positionX) {
      const t = this.ctx.currentTime;
      p.positionX.setTargetAtTime(x, t, 0.02);
      p.positionY.setTargetAtTime(y, t, 0.02);
      p.positionZ.setTargetAtTime(z, t, 0.02);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }

  /**
   * A short, dry footfall: a filtered noise thump with a little body.
   *
   * The fallback, used until the recorded steps have loaded.
   */
  private makeFootstep(variant: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * 0.18);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    const bodyFreq = 90 + variant * 14;
    let last = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / rate;
      const env = Math.pow(1 - i / len, 3.5);
      last = last * 0.55 + (Math.random() * 2 - 1) * 0.45;
      const body = Math.sin(2 * Math.PI * bodyFreq * tt) * Math.exp(-tt * 45);
      d[i] = (last * 0.6 + body * 0.5) * env;
    }
    return buf;
  }
}
