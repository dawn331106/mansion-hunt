import { AUDIO } from '../game/config.js';
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
  stinger(kind: 'jumpscare' | 'pulse' | 'key' | 'hide' | 'unhide' | 'escape'): void {
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'jumpscare': this.jumpscareStinger(t); break;
      case 'pulse': this.tone(t, 180, 0.5, 0.18, 'sine'); break;
      case 'key': this.tone(t, 880, 0.25, 0.16, 'triangle'); break;
      case 'hide': this.noiseBurst(t, 0.16, 0.2, 900); break;
      case 'unhide': this.noiseBurst(t, 0.14, 0.18, 1200); break;
      case 'escape': this.tone(t, 520, 0.7, 0.2, 'sine'); break;
    }
  }

  /**
   * The catch.
   *
   * A hard scare needs three things at once: a transient loud enough to make
   * you flinch, a low sub that you feel rather than hear, and a dissonant tail
   * that keeps the moment going a beat longer than is comfortable.
   */
  private jumpscareStinger(t: number): void {
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
