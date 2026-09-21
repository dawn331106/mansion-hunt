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

  /** Reused footstep buffers, one per surface, generated not loaded. */
  private readonly stepBuffers: AudioBuffer[] = [];

  /** The house's own voice: drone, wind, creaks. Started on resume. */
  private ambience: Ambience | null = null;

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
    // Slight random pitch, so a run does not sound like a metronome.
    src.playbackRate.value = 0.9 + Math.random() * 0.2;

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
   * to be carried entirely by sound. This is a rising shriek — a fast upward
   * sweep with a hard attack — over a low swell, which reads as *something
   * has noticed you* rather than as a hit or a hurt.
   *
   * It plays for the survivor who was spotted, not for the ghost. The ghost
   * already knows.
   */
  private spottedStinger(t: number): void {
    // 1. The shriek: two detuned saws swept up fast, then choked.
    for (const [base, detune] of [[520, 0], [523, 14]] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = detune;
      o.frequency.setValueAtTime(base * 0.55, t);
      o.frequency.exponentialRampToValueAtTime(base * 2.6, t + 0.28);
      o.frequency.exponentialRampToValueAtTime(base * 1.7, t + 0.85);

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(900, t);
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.3);
      bp.Q.value = 3.5;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.03);
      g.gain.setValueAtTime(0.16, t + 0.30);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 1.0);

      o.connect(bp).connect(g).connect(this.ui);
      o.start(t);
      o.stop(t + 1.05);
    }

    // 2. A low swell underneath, so it lands in the chest as well as the ear.
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(70, t);
    sub.frequency.linearRampToValueAtTime(52, t + 1.1);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.32, t + 0.10);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    sub.connect(sg).connect(this.ui);
    sub.start(t);
    sub.stop(t + 1.35);

    // 3. A noise slap on the transient, for the flinch.
    const len = Math.floor(this.ctx.sampleRate * 0.25);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const ng = this.ctx.createGain();
    ng.gain.value = 0.2;
    src.connect(hp).connect(ng).connect(this.ui);
    src.start(t);

    // The house holds its breath, then comes back louder.
    this.ambience?.panic(6.0);
  }

  /**
   * The catch.
   *
   * A hard scare needs three things at once: a transient loud enough to make
   * you flinch, a low sub that you feel rather than hear, and a dissonant tail
   * that keeps the moment going a beat longer than is comfortable.
   */
  private jumpscareStinger(t: number): void {
    // The house goes quiet while the scare has the screen.
    this.ambience?.duck(4.2);
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

    // Duck the world so the scare owns the moment, then bring it back.
    this.world.gain.cancelScheduledValues(t);
    this.world.gain.setValueAtTime(this.world.gain.value, t);
    this.world.gain.linearRampToValueAtTime(0.12, t + 0.05);
    this.world.gain.linearRampToValueAtTime(1.0, t + 2.2);
  }

  /**
   * The ghost's roar — the "arrrgh" as it takes you.
   *
   * Synthesised rather than a recording, because a sampled scream is instantly
   * recognisable as a stock asset and stops being frightening the second time
   * you hear it. This is built the way a voice is: a buzzing source at roughly
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

  /** A short, dry footfall: a filtered noise thump with a little body. */
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
