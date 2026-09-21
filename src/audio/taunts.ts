import { speakLaugh, speakPhonemes } from './speech.js';

/**
 * The ghost talking to itself while it hunts.
 *
 * A hunter that moves in silence is a mechanic; one that keeps up a running
 * commentary is a character, and in a house with no map it is also the single
 * most useful piece of information a survivor gets. A taunt is a footstep that
 * tells you something: it places the ghost, it says roughly what it is doing,
 * and because it carries further than footfalls it is often the first warning
 * you get.
 *
 * Each line carries a phoneme transcription, because the words have to be
 * audible as words — an earlier version synthesised only the rhythm of speech
 * and left the text to a subtitle, which sounded like a growl and not like
 * something talking to you. See `speech.ts` for how the phonemes are voiced,
 * and for why the Web Speech API cannot be used here.
 */

export interface Taunt {
  /** Shown as a subtitle, and what the phonemes spell out. */
  text: string;
  /**
   * Space-separated phonemes from the table in `speech.ts`. `_` is a pause
   * and a leading `|` marks a stressed syllable.
   */
  say: string;
  /** Pitch in Hz. Lower is more threatening. */
  pitch: number;
  /** Ends on a laugh. */
  laugh?: boolean;
  /** When this line is appropriate. */
  mood: 'hunting' | 'close' | 'spotted' | 'gloat';
}

export const TAUNTS: Taunt[] = [
  {
    text: 'Hide as you like… I will find you.',
    say: '|hh ay d _ ae z _ y uw _ |l ay k _ _ ay _ w ih l _ |f ay n d _ y uw',
    pitch: 84,
    mood: 'hunting',
  },
  {
    text: 'Tick tock, tick tock… the clock is running.',
    say: '|t ih k _ |t aa k _ |t ih k _ |t aa k _ _ dh ah _ |k l aa k _ ih z _ |r ah n ih ng',
    pitch: 96,
    mood: 'hunting',
    laugh: true,
  },
  {
    text: 'I know you are in here.',
    say: '|ay _ |n ow _ y uw _ aa r _ |ih n _ |hh ih r',
    pitch: 86,
    mood: 'hunting',
  },
  {
    text: 'Come out… come out…',
    say: '|k ah m _ |aw t _ _ |k ah m _ |aw t',
    pitch: 100,
    mood: 'hunting',
  },
  {
    text: 'Where did you go, little thing?',
    say: '|w eh r _ d ih d _ y uw _ |g ow _ _ |l ih t ah l _ |th ih ng',
    pitch: 98,
    mood: 'hunting',
  },
  {
    text: 'I can smell you.',
    say: '|ay _ k ae n _ |s m eh l _ y uw',
    pitch: 82,
    mood: 'close',
  },
  {
    text: 'Closer… warmer…',
    say: '|k l ow s er _ _ |w ao r m er',
    pitch: 92,
    mood: 'close',
  },
  {
    text: 'Is that you breathing?',
    say: '|ih z _ dh ae t _ |y uw _ |b r iy dh ih ng',
    pitch: 99,
    mood: 'close',
    laugh: true,
  },
  {
    text: 'There you are.',
    say: '|dh eh r _ |y uw _ |aa r',
    pitch: 78,
    mood: 'spotted',
  },
  {
    text: 'Run. It makes it sweeter.',
    say: '|r ah n _ _ ih t _ |m ey k s _ ih t _ |s w iy t er',
    pitch: 86,
    mood: 'spotted',
    laugh: true,
  },
  {
    text: 'Once I catch you, you are dead.',
    say: '|w ah n s _ |ay _ |k ae ch _ y uw _ _ y uw _ aa r _ |d eh d',
    pitch: 80,
    mood: 'spotted',
    laugh: true,
  },
  {
    text: 'No key will save you.',
    say: '|n ow _ |k iy _ w ih l _ |s ey v _ y uw',
    pitch: 88,
    mood: 'gloat',
  },
  {
    text: 'This house is mine.',
    say: '|dh ih s _ |hh aw s _ ih z _ |m ay n',
    pitch: 84,
    mood: 'gloat',
    laugh: true,
  },
  {
    text: 'One of you is already gone.',
    say: '|w ah n _ ah v _ y uw _ ih z _ ao l |r eh d iy _ |g ao n',
    pitch: 82,
    mood: 'gloat',
  },
];

/**
 * Speak a line into the given destination.
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
  // Closer means lower and slower as well as louder: the ghost sounds worse
  // the nearer it gets, which the panner alone cannot convey.
  const pitch = taunt.pitch * (1 - intensity * 0.14);
  const rate = 0.108 + intensity * 0.012;

  const spoken = speakPhonemes(ctx, destination, taunt.say, {
    pitch, rate, intensity, gain: 1,
  });

  if (!taunt.laugh) return spoken;

  /*
   * Schedule the laugh after the line by building it against a delayed
   * context time. `speakPhonemes` always starts at `currentTime`, so the
   * laugh is queued with a timer rather than scheduled ahead — a few
   * milliseconds of drift is irrelevant next to a pause of nearly a second.
   */
  const gap = 0.35;
  setTimeout(() => {
    speakLaugh(ctx, destination, { pitch: pitch * 1.1, intensity, gain: 0.9 });
  }, (spoken + gap) * 1000);

  return spoken + gap + 1.6;
}

/** Pick a line suited to the situation, avoiding the one just used. */
export function pickTaunt(mood: Taunt['mood'], lastText: string | null): Taunt {
  const pool = TAUNTS.filter((t) => t.mood === mood && t.text !== lastText);
  const from = pool.length > 0 ? pool : TAUNTS.filter((t) => t.mood === mood);
  return from[Math.floor(Math.random() * from.length)];
}
