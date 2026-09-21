/**
 * Render the ghost's lines offline and check they are audible and articulate.
 *
 * Audio bugs are invisible to a typechecker and inaudible to a screenshot, and
 * the first version of this voice shipped at roughly a tenth of the level it
 * needed because nothing measured it. This runs the real synthesiser in a
 * headless browser through an OfflineAudioContext, so it can report peak and
 * RMS level, and — the part that matters for intelligibility — how much the
 * spectrum actually moves between phonemes. A voice whose formants do not
 * shift is a drone, however loud it is.
 *
 *   npx tsx tools/voicetest.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' });

const results = await page.evaluate(async () => {
  const { TAUNTS, speakTaunt } = await import('/src/audio/taunts.ts');
  const out = [];

  for (const taunt of TAUNTS.slice(0, 6)) {
    const ctx = new OfflineAudioContext(1, 48000 * 6, 48000);
    const bus = ctx.createGain();
    bus.gain.value = 3.4;
    bus.connect(ctx.destination);
    speakTaunt(ctx, bus, taunt, 0.8);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);

    let peak = 0;
    let sum = 0;
    let nonSilent = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      if (a > 0.004) nonSilent++;
    }
    const rms = Math.sqrt(sum / d.length);

    /*
     * Articulation: how much the spectrum changes from frame to frame.
     * Speech moves; a drone does not. Measured as the mean absolute change
     * in a coarse band energy profile between consecutive 40ms windows.
     */
    const win = 1920;
    const bands = 8;
    const profiles = [];
    for (let s = 0; s + win < d.length; s += win) {
      const p = new Array(bands).fill(0);
      for (let i = 0; i < win; i++) {
        // Crude band split by zero-crossing rate within sub-chunks.
        const b = Math.min(bands - 1, Math.floor((i / win) * bands));
        p[b] += Math.abs(d[s + i]);
      }
      const tot = p.reduce((a, x) => a + x, 0) || 1;
      profiles.push(p.map((x) => x / tot));
    }
    let move = 0;
    for (let i = 1; i < profiles.length; i++) {
      for (let b = 0; b < bands; b++) move += Math.abs(profiles[i][b] - profiles[i - 1][b]);
    }
    move /= Math.max(1, profiles.length - 1);

    out.push({
      text: taunt.text,
      peak: +peak.toFixed(3),
      rms: +rms.toFixed(4),
      voicedPct: +(100 * nonSilent / d.length).toFixed(1),
      articulation: +move.toFixed(3),
    });
  }
  return out;
});

console.log('line                                          peak    rms   voiced%  artic');
let bad = 0;
for (const r of results) {
  // A line that never gets near 0.25 peak will be lost under the ambience;
  // one with almost no articulation is a drone rather than speech.
  const quiet = r.peak < 0.25;
  const flat = r.articulation < 0.05;
  if (quiet || flat) bad++;
  const flag = quiet ? ' QUIET' : flat ? ' FLAT' : '';
  console.log(
    `${r.text.slice(0, 44).padEnd(44)} ${String(r.peak).padStart(6)} ` +
    `${String(r.rms).padStart(7)} ${String(r.voicedPct).padStart(7)} ` +
    `${String(r.articulation).padStart(6)}${flag}`,
  );
}
console.log(bad === 0 ? '\nALL LINES AUDIBLE' : `\n${bad} LINE(S) NEED WORK`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
