/**
 * The ghost talking to itself while it hunts.
 *
 * A hunter that moves in silence is a mechanic; one that keeps up a running
 * commentary is a character, and in a house with no map it is also the single
 * most useful piece of information a survivor gets. A taunt is a footstep that
 * tells you something: it places the ghost, it says roughly what it is doing,
 * and because it carries over a longer range than footfalls it is often the
 * first warning you get.
 *
 * The lines are synthesised, not recorded. That is not only about shipping
 * assets — a recorded line is identical every time and stops landing after the
 * third hearing, whereas these vary in pitch, pace and rasp on every
 * utterance, so the same sentence is never quite the same twice.
 *
 * Speech here means *prosody*, not intelligibility. What is synthesised is the
 * rhythm and melody of a sentence — a syllable train with stresses, pauses and
 * a falling final cadence — voiced through a formant filter bank so it reads
 * as a mouth. You hear something speaking, and the subtitle tells you what.
 * That is a deliberate trade: attempting real phonemes with oscillators lands
 * squarely in the uncanny valley and sounds comic rather than frightening.
 */

/** A thing the ghost says, with the rhythm to speak it by. */
export interface Taunt {
  /** Shown as a subtitle when close enough to hear it. */
  text: string;
  /**
   * Syllable weights. Each entry is one syllable; the value is its stress,
   * from 0.3 (throwaway) to 1.4 (hit hard). A negative value is a pause of
   * that many beats.
   */
  rhythm: number[];
  /** Overall pitch multiplier — low for threats, higher for taunting. */
  pitch: number;
  /** Ends on a laugh. */
  laugh?: boolean;
  /** When this line is appropriate. */
  mood: 'hunting' | 'close' | 'spotted' | 'gloat';
}

export const TAUNTS: Taunt[] = [
  {
    text: 'Hide as you like… I will find you.',
    rhythm: [0.9, 0.6, 0.7, 0.8, -1.2, 0.7, 0.6, 1.1, 0.9],
    pitch: 0.86,
    mood: 'hunting',
  },
  {
    text: 'Tick tock, tick tock… the clock is running.',
    rhythm: [1.2, 1.0, -0.4, 1.2, 1.0, -1.0, 0.6, 0.9, 0.5, 0.8, 0.6],
    pitch: 1.04,
    mood: 'hunting',
    laugh: true,
  },
  {
    text: 'I know you are in here.',
    rhythm: [1.0, 0.8, 0.6, 0.5, 0.6, 1.2],
    pitch: 0.92,
    mood: 'hunting',
  },
  {
    text: 'Come out… come out…',
    rhythm: [0.9, 0.7, -1.4, 0.9, 0.7],
    pitch: 1.10,
    mood: 'hunting',
  },
  {
    text: 'I can smell you from here.',
    rhythm: [0.8, 0.7, 1.1, 0.6, -0.5, 0.7, 0.9],
    pitch: 0.88,
    mood: 'close',
  },
  {
    text: 'Closer… warmer… almost.',
    rhythm: [1.0, 0.6, -0.8, 1.0, 0.6, -0.8, 0.9, 0.7],
    pitch: 0.98,
    mood: 'close',
  },
  {
    text: 'Is that you breathing?',
    rhythm: [0.7, 0.8, 0.9, -0.3, 1.1, 0.6],
    pitch: 1.06,
    mood: 'close',
    laugh: true,
  },
  {
    text: 'There you are.',
    rhythm: [1.3, 0.9, 1.2],
    pitch: 0.82,
    mood: 'spotted',
  },
  {
    text: 'Run. It only makes it sweeter.',
    rhythm: [1.4, -0.6, 0.7, 0.8, 0.9, 0.6, 0.7, 1.0, 0.6],
    pitch: 0.90,
    mood: 'spotted',
    laugh: true,
  },
  {
    text: 'Once I catch you, you are dead.',
    rhythm: [0.8, 0.7, 1.1, 0.7, -0.4, 0.7, 0.6, 1.3],
    pitch: 0.84,
    mood: 'spotted',
    laugh: true,
  },
  {
    text: 'No key will save you.',
    rhythm: [1.0, 1.1, 0.6, 0.9, 0.7],
    pitch: 0.94,
    mood: 'gloat',
  },
  {
    text: 'This house is mine. You are only visiting.',
    rhythm: [0.8, 1.1, 0.6, 1.2, -0.9, 0.7, 0.6, 0.8, 0.9, 0.6, 0.5],
    pitch: 0.88,
    mood: 'gloat',
    laugh: true,
  },
  {
    text: 'Where did you go, little thing?',
    rhythm: [0.9, 0.6, 0.6, 0.9, -0.5, 0.8, 0.6, 1.0],
    pitch: 1.08,
    mood: 'hunting',
  },
  {
    text: 'One of you is already gone.',
    rhythm: [1.0, 0.6, 0.7, 0.6, 0.9, 0.7, 0.6, 1.1],
    pitch: 0.86,
    mood: 'gloat',
  },
];

/**
 * Build one spoken line into the given destination node.
 *
 * Returns how long it lasts, so the caller can schedule the next one without
 * talking over this one.
 */
export function speakTaunt(
  ctx: AudioContext,
  destination: AudioNode,
  taunt: Taunt,
  /** 0..1 — how ghostly. Higher is lower, rougher and more detuned. */
  intensity = 0.7,
): number {
  const t0 = ctx.currentTime;

  const bus = ctx.createGain();
  bus.gain.value = 0.9;

  /*
   * The voice: a pulse-ish source at speech fundamental, plus a sub-octave to
   * give it a chest. Two detuned copies beat against each other, which is
   * most of what makes it sound inhuman rather than merely deep.
   */
  const voice = ctx.createGain();
  voice.gain.value = 0;

  const base = 104 * taunt.pitch * (1 - intensity * 0.22);
  const oscs: OscillatorNode[] = [];
  for (const [mult, level, det] of [[1, 0.55, 0], [1, 0.4, 11], [0.5, 0.45, -7]] as const) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = det * (1 + intensity);
    o.frequency.value = base * mult;
    const g = ctx.createGain();
    g.gain.value = level;
    o.connect(g).connect(voice);
    oscs.push(o);
  }

  /*
   * Formants: three resonant peaks are the minimum that reads as a mouth
   * rather than a synthesiser. These sit near a neutral vowel and are swept
   * per syllable below, which is what turns a drone into speech-shaped sound.
   */
  const formants = [620, 1180, 2600].map((f, i) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = [8, 10, 7][i];
    const g = ctx.createGain();
    g.gain.value = [1.0, 0.62, 0.3][i];
    voice.connect(bp).connect(g).connect(bus);
    return bp;
  });

  // Breath under the voice, so there is air in it.
  const nlen = Math.floor(ctx.sampleRate * 6);
  const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
  const nd = nbuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < nlen; i++) {
    last = last * 0.65 + (Math.random() * 2 - 1) * 0.35;
    nd[i] = last;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = nbuf;
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = 1400;
  nf.Q.value = 0.9;
  const ng = ctx.createGain();
  ng.gain.value = 0;
  noise.connect(nf).connect(ng).connect(bus);

  // A little rasp, so it tears at the edges.
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(new ArrayBuffer(512 * 4));
  for (let i = 0; i < 512; i++) {
    const x = (i / 511) * 2 - 1;
    curve[i] = Math.tanh(x * (1.6 + intensity * 2.4));
  }
  shaper.curve = curve;
  bus.connect(shaper).connect(destination);

  /*
   * Speak the rhythm.
   *
   * Each syllable is an amplitude burst with its own formant positions and a
   * small pitch step, and the whole line drifts downward in pitch — the
   * falling cadence that makes a sequence of sounds read as a finished
   * sentence rather than a list.
   */
  const syllable = 0.17 + intensity * 0.04;
  let t = t0 + 0.05;
  const total = taunt.rhythm.reduce((a, r) => a + (r < 0 ? -r : 1), 0);
  let spoken = 0;

  for (const r of taunt.rhythm) {
    if (r < 0) {
      t += -r * syllable;
      continue;
    }
    const dur = syllable * (0.75 + r * 0.35);
    const progress = spoken / Math.max(1, total);

    // Amplitude: a quick attack, a held body, a soft release.
    voice.gain.setValueAtTime(0.0001, t);
    voice.gain.exponentialRampToValueAtTime(0.10 + r * 0.16, t + dur * 0.22);
    voice.gain.setValueAtTime(0.10 + r * 0.16, t + dur * 0.62);
    voice.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.05 + r * 0.05, t + dur * 0.3);
    ng.gain.linearRampToValueAtTime(0.0, t + dur);

    // Pitch: stressed syllables ride higher, and the line falls as it goes.
    const f = base * (1 + (r - 0.8) * 0.16) * (1 - progress * 0.22);
    for (let i = 0; i < oscs.length; i++) {
      const mult = i === 2 ? 0.5 : 1;
      oscs[i].frequency.setTargetAtTime(f * mult, t, 0.04);
    }

    // Vowel colour: shifting the formants per syllable is what stops every
    // syllable sounding like the same "uh".
    const vowel = (spoken * 0.61) % 1;
    formants[0].frequency.setTargetAtTime(430 + vowel * 420, t, 0.05);
    formants[1].frequency.setTargetAtTime(1750 - vowel * 750, t, 0.05);
    formants[2].frequency.setTargetAtTime(2500 + vowel * 400, t, 0.06);

    t += dur;
    spoken++;
  }

  // --- The laugh: short, falling, repeated. ---
  if (taunt.laugh) {
    t += syllable * 0.9;
    const beats = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < beats; i++) {
      const dur = syllable * 0.52;
      const decay = 1 - i / (beats + 1);
      voice.gain.setValueAtTime(0.0001, t);
      voice.gain.exponentialRampToValueAtTime(0.20 * decay, t + dur * 0.16);
      voice.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      const f = base * (1.28 - i * 0.07);
      for (let k = 0; k < oscs.length; k++) {
        oscs[k].frequency.setTargetAtTime(f * (k === 2 ? 0.5 : 1), t, 0.02);
      }
      formants[0].frequency.setTargetAtTime(700, t, 0.03);
      formants[1].frequency.setTargetAtTime(1150, t, 0.03);
      t += dur * 1.28;
    }
  }

  const end = t + 0.35;
  for (const o of oscs) { o.start(t0); o.stop(end); }
  noise.start(t0);
  noise.stop(end);
  setTimeout(() => { bus.disconnect(); shaper.disconnect(); }, (end - t0 + 1) * 1000);

  return end - t0;
}

/** Pick a line suited to the situation, avoiding the one just used. */
export function pickTaunt(mood: Taunt['mood'], lastText: string | null): Taunt {
  const pool = TAUNTS.filter((t) => t.mood === mood && t.text !== lastText);
  const from = pool.length > 0 ? pool : TAUNTS.filter((t) => t.mood === mood);
  return from[Math.floor(Math.random() * from.length)];
}
