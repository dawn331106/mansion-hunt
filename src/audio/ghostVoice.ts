/**
 * Turning a human voice into a ghost's, in real time.
 *
 * The brief called this "a challenge probably", and the reason is that the
 * obvious approach does not work. Web Speech is speech *recognition* — it
 * gives you text, so routing voice through it would throw away timing, tone
 * and everything that makes a human ghost frightening, and hand back a robot
 * reading a transcript. What you want is the player's actual performance,
 * wearing a mask.
 *
 * So this is a Web Audio effects chain applied to the raw microphone stream.
 * It runs on the *listener's* machine, at the end of the graph, which matters:
 * the same node feeds a PannerNode, so distance attenuation and the ghost
 * effect compose for free and a distant ghost is both quieter and less
 * intelligible, exactly as it should be.
 *
 * The chain, in order:
 *   1. High-pass      — strips rumble and mic handling noise.
 *   2. Pitch shift    — the core of it, roughly a fifth down, via granular
 *                       resampling in an AudioWorklet.
 *   3. Ring modulator — a slow carrier adds the metallic detune that reads as
 *                       "not a person" without destroying the words.
 *   4. Waveshaper     — gentle saturation, so shouting distorts like it is
 *                       coming through something.
 *   5. Convolver      — a long, dark reverb tail; the house answering.
 *   6. Low-pass       — takes the top off so it sits behind the world.
 */

/** Worklet source, inlined so there is no separate file to serve. */
const PITCH_WORKLET = `
/**
 * Granular pitch shifter.
 *
 * Reads from a ring buffer at a rate other than 1.0 and crossfades two
 * overlapping grains, which avoids the clicking a naive resample produces at
 * the loop point. Latency is one grain, a few milliseconds — imperceptible in
 * conversation.
 */
class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 0.62, minValue: 0.25, maxValue: 2.0 }];
  }

  constructor() {
    super();
    this.bufferSize = 8192;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    // Grain length in samples; long enough for low voices to stay warm.
    this.grain = 1400;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inCh = input[0];
    const outCh = output[0];
    const pitch = parameters.pitch.length > 1 ? null : parameters.pitch[0];

    for (let i = 0; i < inCh.length; i++) {
      this.buffer[this.writeIndex] = inCh[i];
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

      const rate = pitch !== null ? pitch : parameters.pitch[i];

      // Two grains, half a grain apart, crossfaded by their position.
      const r1 = this.readIndex;
      const r2 = (this.readIndex + this.grain / 2) % this.bufferSize;
      const phase = (this.readIndex % this.grain) / this.grain;
      const w1 = Math.cos(phase * Math.PI * 0.5);
      const w2 = Math.sin(phase * Math.PI * 0.5);

      outCh[i] = this.sample(r1) * w1 + this.sample(r2) * w2;

      this.readIndex += rate;
      if (this.readIndex >= this.bufferSize) this.readIndex -= this.bufferSize;
      if (this.readIndex < 0) this.readIndex += this.bufferSize;
    }

    return true;
  }

  /** Linearly interpolated read, so fractional rates do not alias. */
  sample(pos) {
    const i0 = Math.floor(pos) % this.bufferSize;
    const i1 = (i0 + 1) % this.bufferSize;
    const frac = pos - Math.floor(pos);
    return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac;
  }
}

registerProcessor('pitch-shift', PitchShiftProcessor);
`;

let workletReady: Promise<void> | null = null;

/** Load the pitch worklet once per context. */
export async function ensureGhostWorklet(ctx: AudioContext): Promise<void> {
  if (!workletReady) {
    const blob = new Blob([PITCH_WORKLET], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    workletReady = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  }
  return workletReady;
}

export interface GhostVoiceChain {
  /** Feed the raw voice in here. */
  input: AudioNode;
  /** Take the ghostly result from here — connect it to a panner. */
  output: AudioNode;
  /** 0 = untouched voice, 1 = fully spectral. Ramped, never stepped. */
  setIntensity(v: number): void;
  dispose(): void;
}

/**
 * Build the effect chain.
 *
 * `intensity` exists so the ghost can sound worse the closer it gets: at the
 * edge of hearing it is a distorted whisper, and at catching distance it is
 * fully inhuman. That ramp does more for dread than any single fixed setting.
 */
export function createGhostVoice(ctx: AudioContext): GhostVoiceChain {
  const input = ctx.createGain();

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 110;

  // --- Pitch shift. Falls back to a plain pass-through if the worklet is
  //     unavailable, so a browser without AudioWorklet still has voice chat. ---
  let pitchNode: AudioNode;
  try {
    const w = new AudioWorkletNode(ctx, 'pitch-shift', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // A fifth down. Lower than this and consonants stop surviving the shift.
    w.parameters.get('pitch')!.value = 0.62;
    pitchNode = w;
  } catch {
    pitchNode = ctx.createGain();
  }

  // --- Ring modulation. A gain node used as a multiplier: the oscillator
  //     drives the gain, so the signal is multiplied by the carrier. ---
  const ringGain = ctx.createGain();
  ringGain.gain.value = 0;
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  // Low and slow: a metallic shimmer rather than a dalek.
  carrier.frequency.value = 33;
  const carrierDepth = ctx.createGain();
  carrierDepth.gain.value = 0.55;
  carrier.connect(carrierDepth).connect(ringGain.gain);
  carrier.start();

  // Blend the ring-modulated signal against the dry one so the words survive.
  const ringWet = ctx.createGain();
  ringWet.gain.value = 0.45;
  const ringDry = ctx.createGain();
  ringDry.gain.value = 0.55;

  // --- Saturation. A soft-clip curve, so loud passages tear. ---
  const shaper = ctx.createWaveShaper();
  shaper.curve = saturationCurve(2.2);
  shaper.oversample = '2x';

  // --- Reverb. A synthesised dark tail; no impulse file to ship. ---
  const convolver = ctx.createConvolver();
  convolver.buffer = darkImpulse(ctx, 2.6, 3.4);
  const revWet = ctx.createGain();
  revWet.gain.value = 0.38;
  const revDry = ctx.createGain();
  revDry.gain.value = 0.72;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 3200;

  const output = ctx.createGain();

  // --- Wire it up. ---
  input.connect(highpass);
  highpass.connect(pitchNode);

  pitchNode.connect(ringGain);
  pitchNode.connect(ringDry);
  ringGain.connect(ringWet);

  const postRing = ctx.createGain();
  ringWet.connect(postRing);
  ringDry.connect(postRing);

  postRing.connect(shaper);

  shaper.connect(convolver);
  shaper.connect(revDry);
  convolver.connect(revWet);

  revWet.connect(lowpass);
  revDry.connect(lowpass);
  lowpass.connect(output);

  return {
    input,
    output,
    setIntensity(v: number) {
      const t = ctx.currentTime;
      const k = Math.max(0, Math.min(1, v));
      // Ramp rather than set, or every change is an audible click.
      carrierDepth.gain.setTargetAtTime(0.25 + k * 0.5, t, 0.15);
      ringWet.gain.setTargetAtTime(0.2 + k * 0.4, t, 0.15);
      ringDry.gain.setTargetAtTime(0.8 - k * 0.3, t, 0.15);
      revWet.gain.setTargetAtTime(0.2 + k * 0.35, t, 0.2);
      lowpass.frequency.setTargetAtTime(4200 - k * 1600, t, 0.2);
    },
    dispose() {
      try { carrier.stop(); } catch { /* already stopped */ }
      input.disconnect();
      output.disconnect();
    },
  };
}

/** Soft-clipping transfer curve. */
function saturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(1024 * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/**
 * A synthesised reverb impulse: exponentially decaying noise, filtered dark.
 *
 * Cheaper than shipping an impulse response and easier to tune — `decay`
 * controls how long the house holds the voice, which is the parameter that
 * actually matters here.
 */
function darkImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      // One-pole low-pass on the noise, so the tail is dark rather than hissy.
      last = last * 0.72 + (Math.random() * 2 - 1) * 0.28;
      data[i] = last * env;
    }
  }
  return buf;
}
