/**
 * A small formant speech synthesiser, for the ghost's taunts.
 *
 * The first version of this synthesised only prosody — syllable rhythm,
 * stress and a falling cadence — on the theory that a caption could carry the
 * words. That was wrong. It sounded like a growling presence, not like
 * something speaking to you, and a ghost that says "hide as you like, I will
 * find you" has to actually say it.
 *
 * The honest alternative, the Web Speech API, cannot be used here: its output
 * goes straight to the output device and cannot be routed into a Web Audio
 * graph, so it could be neither pitch-shifted into something inhuman nor
 * placed in the house through a panner. A voice that is always at full volume
 * in the centre of your head is useless in a game where sound is how you find
 * people.
 *
 * So this synthesises speech directly, the way a formant synthesiser does:
 *
 *   - Voiced sounds are a glottal buzz — a sawtooth at the pitch of the voice
 *     — shaped by three bandpass filters parked at the formant frequencies of
 *     the intended vowel. Those first three resonances are what the ear reads
 *     as "ah" versus "ee"; get them right and the vowel is unmistakable.
 *   - Unvoiced consonants are filtered noise: sibilants are a high band, plosives
 *     a burst with a gap of silence in front of them, nasals a low buzz with
 *     the mouth closed.
 *   - Formants glide between neighbouring phonemes rather than jumping, which
 *     is most of what makes a string of sounds read as a word instead of as a
 *     list of separate noises.
 *
 * It will never pass for a person, and it should not: the result is a hollow,
 * inhuman articulation that is still clearly saying English words, which is
 * exactly the register this game wants.
 */

/** A single phoneme: how to voice it, and how long it lasts. */
interface Phoneme {
  /** Formant frequencies F1, F2, F3 in Hz. */
  f: [number, number, number];
  /** Relative duration, 1 = a normal short vowel. */
  d: number;
  /** How voiced it is: 1 = full buzz, 0 = pure noise. */
  v: number;
  /** Noise band centre, for fricatives and plosives. */
  nf?: number;
  /** Silence before it, in units of duration — what makes a plosive plosive. */
  stop?: number;
  /** Amplitude scale. */
  a?: number;
}

/**
 * The phoneme table.
 *
 * Formant values are the standard measured averages for a male speaker. They
 * matter far more than anything else here: F1 and F2 alone identify a vowel,
 * which is why "ee" (270/2290) and "oo" (300/870) are unmistakably different
 * despite both being high, close vowels.
 */
const P: Record<string, Phoneme> = {
  // --- Vowels ---
  aa: { f: [730, 1090, 2440], d: 1.25, v: 1 },     // f-a-ther
  ae: { f: [660, 1720, 2410], d: 1.15, v: 1 },     // c-a-t
  ah: { f: [640, 1190, 2390], d: 0.85, v: 1 },     // c-u-t
  ao: { f: [570, 840, 2410], d: 1.2, v: 1 },       // th-ou-ght
  eh: { f: [530, 1840, 2480], d: 0.95, v: 1 },     // b-e-d
  er: { f: [490, 1350, 1690], d: 1.1, v: 1 },      // h-er
  ih: { f: [390, 1990, 2550], d: 0.75, v: 1 },     // b-i-t
  iy: { f: [270, 2290, 3010], d: 1.1, v: 1 },      // b-ea-t
  ow: { f: [450, 1030, 2380], d: 1.2, v: 1 },      // b-oa-t
  uh: { f: [440, 1020, 2240], d: 0.8, v: 1 },      // b-oo-k
  uw: { f: [300, 870, 2240], d: 1.15, v: 1 },      // b-oo-t
  ay: { f: [700, 1400, 2500], d: 1.4, v: 1 },      // b-i-te (glide)
  aw: { f: [680, 1100, 2300], d: 1.35, v: 1 },     // n-ow
  ey: { f: [480, 1900, 2500], d: 1.3, v: 1 },      // b-ai-t (glide)
  oy: { f: [520, 1000, 2400], d: 1.35, v: 1 },     // b-oy

  // --- Nasals: voiced, but the mouth is shut, so low and dull. ---
  m: { f: [250, 1100, 2100], d: 0.55, v: 1, a: 0.6 },
  n: { f: [250, 1600, 2600], d: 0.55, v: 1, a: 0.6 },
  ng: { f: [250, 2100, 2800], d: 0.6, v: 1, a: 0.55 },

  // --- Liquids and glides ---
  l: { f: [360, 1300, 2700], d: 0.6, v: 1, a: 0.8 },
  r: { f: [420, 1100, 1600], d: 0.6, v: 1, a: 0.8 },
  w: { f: [300, 800, 2200], d: 0.5, v: 1, a: 0.75 },
  y: { f: [290, 2200, 2900], d: 0.45, v: 1, a: 0.75 },

  // --- Voiced fricatives: buzz plus noise. ---
  v: { f: [350, 1100, 2400], d: 0.5, v: 0.55, nf: 2400, a: 0.7 },
  z: { f: [320, 1400, 2600], d: 0.6, v: 0.45, nf: 5200, a: 0.75 },
  dh: { f: [300, 1300, 2500], d: 0.5, v: 0.5, nf: 3600, a: 0.6 },

  // --- Unvoiced fricatives: noise only. ---
  s: { f: [320, 1400, 2600], d: 0.75, v: 0, nf: 6000, a: 0.9 },
  sh: { f: [400, 1800, 2500], d: 0.8, v: 0, nf: 3200, a: 0.95 },
  f: { f: [350, 1100, 2400], d: 0.6, v: 0, nf: 4200, a: 0.6 },
  th: { f: [300, 1300, 2500], d: 0.55, v: 0, nf: 4600, a: 0.5 },
  hh: { f: [500, 1500, 2500], d: 0.45, v: 0, nf: 1800, a: 0.45 },

  // --- Plosives: a beat of silence, then a burst. ---
  p: { f: [400, 1100, 2200], d: 0.28, v: 0, nf: 1400, stop: 0.55, a: 0.8 },
  b: { f: [350, 1100, 2200], d: 0.26, v: 0.6, nf: 1200, stop: 0.42, a: 0.7 },
  t: { f: [400, 1700, 2600], d: 0.28, v: 0, nf: 3800, stop: 0.55, a: 0.85 },
  d: { f: [350, 1600, 2600], d: 0.26, v: 0.6, nf: 3000, stop: 0.42, a: 0.75 },
  k: { f: [450, 1900, 2400], d: 0.3, v: 0, nf: 2400, stop: 0.6, a: 0.85 },
  g: { f: [400, 1800, 2400], d: 0.27, v: 0.6, nf: 2000, stop: 0.45, a: 0.75 },

  // --- Affricates ---
  ch: { f: [400, 1800, 2500], d: 0.5, v: 0, nf: 3400, stop: 0.5, a: 0.9 },
  jh: { f: [380, 1700, 2500], d: 0.5, v: 0.5, nf: 3000, stop: 0.4, a: 0.8 },

  // --- A pause. ---
  _: { f: [400, 1200, 2400], d: 0.7, v: 0, a: 0 },
};

/**
 * Speak a phoneme string into the given destination.
 *
 * `phonemes` is a space-separated list of keys from the table above, with `_`
 * for a pause and `|` marking a stressed syllable's vowel.
 *
 * Returns the duration in seconds so the caller can schedule what comes next.
 */
export function speakPhonemes(
  ctx: AudioContext,
  destination: AudioNode,
  phonemes: string,
  opts: {
    /** Base pitch in Hz. Low is menacing; the ghost sits well under a man's. */
    pitch?: number;
    /** Seconds per unit duration. Lower is faster speech. */
    rate?: number;
    /** 0..1 — how inhuman. Drives detune, rasp and growl. */
    intensity?: number;
    /** Overall level. */
    gain?: number;
  } = {},
): number {
  const pitch = opts.pitch ?? 88;
  const rate = opts.rate ?? 0.105;
  const intensity = opts.intensity ?? 0.7;
  const level = opts.gain ?? 1;

  const t0 = ctx.currentTime;

  const out = ctx.createGain();
  out.gain.value = level;
  out.connect(destination);

  /*
   * The glottal source: three saws, one an octave down for chest, two
   * detuned against each other. The beating between them is most of what
   * makes the voice read as something other than a person.
   */
  const glottis = ctx.createGain();
  glottis.gain.value = 0;
  const oscs: OscillatorNode[] = [];
  for (const [mult, lvl, det] of [[1, 0.5, 0], [1, 0.34, 13], [0.5, 0.42, -9]] as const) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = det * (0.5 + intensity);
    o.frequency.value = pitch * mult;
    const g = ctx.createGain();
    g.gain.value = lvl;
    o.connect(g).connect(glottis);
    oscs.push(o);
  }

  // The noise source, for fricatives and plosive bursts.
  const nlen = Math.ceil(ctx.sampleRate * 8);
  const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
  const nd = nbuf.getChannelData(0);
  for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = nbuf;
  noise.loop = true;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  const noiseBand = ctx.createBiquadFilter();
  noiseBand.type = 'bandpass';
  noiseBand.frequency.value = 3000;
  noiseBand.Q.value = 1.4;
  noise.connect(noiseBand).connect(noiseGain);

  /*
   * The vocal tract: three bandpass filters at the formant frequencies.
   *
   * This is the whole trick. Park them at 730/1090/2440 and the buzz becomes
   * "ah"; at 270/2290/3010 it becomes "ee". Gliding between those positions
   * is what turns two phonemes into a syllable rather than two noises.
   */
  const tract = ctx.createGain();
  glottis.connect(tract);
  noiseGain.connect(tract);

  const formants = [0, 1, 2].map((i) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = [500, 1500, 2500][i];
    bp.Q.value = [9, 11, 9][i];
    const g = ctx.createGain();
    g.gain.value = [1.0, 0.72, 0.42][i];
    tract.connect(bp).connect(g).connect(out);
    return bp;
  });

  // A little of the raw source keeps consonants from vanishing entirely.
  const bypass = ctx.createGain();
  bypass.gain.value = 0.22;
  tract.connect(bypass).connect(out);

  // --- Walk the phonemes. ---
  const items = phonemes.trim().split(/\s+/);
  let t = t0 + 0.04;
  let spoken = 0;
  const voiced = items.filter((s) => !s.startsWith('_')).length;

  for (const raw of items) {
    const stressed = raw.startsWith('|');
    const key = stressed ? raw.slice(1) : raw;
    const ph = P[key];
    if (!ph) continue;

    // A plosive needs a beat of closure before its burst, or it sounds like
    // a fricative. This is the silence that makes a "t" a "t".
    if (ph.stop) {
      glottis.gain.setTargetAtTime(0.0001, t, 0.008);
      noiseGain.gain.setTargetAtTime(0.0001, t, 0.008);
      t += ph.stop * rate;
    }

    const dur = ph.d * rate * (stressed ? 1.25 : 1);
    const amp = (ph.a ?? 1) * (stressed ? 1.25 : 0.92);

    // Pitch: stressed syllables ride higher, and the line falls as it runs on
    // — the declination that makes a sequence sound like a finished sentence.
    const fall = 1 - (spoken / Math.max(1, voiced)) * 0.24;
    const f0 = pitch * fall * (stressed ? 1.1 : 1);
    for (let i = 0; i < oscs.length; i++) {
      oscs[i].frequency.setTargetAtTime(f0 * (i === 2 ? 0.5 : 1), t, 0.03);
    }

    // Glide the formants rather than jumping: this is what makes it words.
    for (let i = 0; i < 3; i++) {
      formants[i].frequency.setTargetAtTime(ph.f[i], t, dur * 0.35);
    }
    if (ph.nf) noiseBand.frequency.setTargetAtTime(ph.nf, t, 0.01);

    // Amplitude envelope, split between buzz and noise by how voiced it is.
    const vg = ph.v * amp * 0.5;
    const ng2 = (1 - ph.v) * amp * 0.22;

    glottis.gain.setTargetAtTime(vg, t, dur * 0.18);
    noiseGain.gain.setTargetAtTime(ng2, t, dur * 0.12);
    // Taper the tail so phonemes join rather than clicking.
    glottis.gain.setTargetAtTime(vg * 0.72, t + dur * 0.7, dur * 0.3);

    t += dur;
    spoken++;
  }

  // Close the mouth.
  glottis.gain.setTargetAtTime(0.0001, t, 0.05);
  noiseGain.gain.setTargetAtTime(0.0001, t, 0.05);
  const end = t + 0.25;

  for (const o of oscs) { o.start(t0); o.stop(end); }
  noise.start(t0);
  noise.stop(end);
  setTimeout(() => out.disconnect(), (end - t0 + 1) * 1000);

  return end - t0;
}

/**
 * A laugh, built from the same machinery.
 *
 * Falling "ha" bursts, each lower and quieter than the last. Written here
 * rather than as phonemes because the timing is the whole character of it.
 */
export function speakLaugh(
  ctx: AudioContext,
  destination: AudioNode,
  opts: { pitch?: number; intensity?: number; gain?: number } = {},
): number {
  const beats = 4 + Math.floor(Math.random() * 3);
  let phon = '';
  for (let i = 0; i < beats; i++) phon += (i === 0 ? '|hh aa' : ' hh aa') + ' _';
  return speakPhonemes(ctx, destination, phon, {
    pitch: (opts.pitch ?? 88) * 1.15,
    rate: 0.075,
    intensity: opts.intensity ?? 0.8,
    gain: opts.gain ?? 1,
  });
}
