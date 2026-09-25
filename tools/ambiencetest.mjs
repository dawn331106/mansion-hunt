/**
 * Measure the ambient layers against each other.
 *
 * The one-off sounds once shipped at roughly a sixth of the level
 * of the wind bed they have to cut through, which made them inaudible — and
 * nothing caught it, because a gain constant looks perfectly reasonable in
 * source and an event you cannot hear leaves no other trace.
 *
 * So this renders each layer alone through an OfflineAudioContext and reports
 * its peak and RMS, then reports each event as a ratio against the continuous
 * bed. That ratio is the number that actually matters: a sound is audible
 * because it is louder than what is already playing, not because its own
 * figure looks large.
 *
 *   npx tsx tools/ambiencetest.mjs
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
  const { Ambience } = await import('/src/audio/ambience.ts');

  /** Render one ambient method in isolation and measure it. */
  const measure = async (name, drive, seconds) => {
    const ctx = new OfflineAudioContext(1, 48000 * seconds, 48000);
    const dest = ctx.createGain();
    dest.gain.value = 1;
    dest.connect(ctx.destination);

    const amb = new Ambience(ctx, dest);
    /*
     * The constructor ramps the bus in with `setTargetAtTime`, which is
     * exponential and never actually arrives — cancelling it and setting the
     * value outright is the only way a short offline render measures the
     * steady state rather than the fade. Getting this wrong made every layer
     * read as the same level, because the fade dominated all of them.
     */
    amb.out.gain.cancelScheduledValues(0);
    amb.out.gain.setValueAtTime(0.5, 0);
    // The calls are recordings; wait for them to decode first.
    await amb.samplesReady;
    drive(amb, ctx);

    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);

    /*
     * Measure only after the first second.
     *
     * The drone and wind take a moment to reach level, and an event scheduled
     * at 0.1s would otherwise be compared against a bed that is still
     * arriving.
     */
    const from = Math.floor(48000 * 0.9);
    let peak = 0;
    let sum = 0;
    for (let i = from; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
    }
    return {
      name,
      peak: +peak.toFixed(4),
      rms: +Math.sqrt(sum / (d.length - from)).toFixed(5),
    };
  };

  const out = [];
  // The continuous bed on its own: drone plus wind, no events.
  out.push(await measure('bed (drone + wind)', () => {}, 4));
  out.push(await measure('howl', (a, c) => a.howl(c.currentTime + 0.1), 5));
  out.push(await measure('owl', (a, c) => a.owl(c.currentTime + 0.1), 4));
  out.push(await measure('scream', (a, c) => a.scream(c.currentTime + 0.1), 5));
  return out;
});

const bed = results.find((r) => r.name.startsWith('bed'));
console.log('layer                  peak      rms   vs bed');
let bad = 0;
for (const r of results) {
  const ratio = bed && r !== bed ? r.peak / bed.peak : 1;
  // An event needs to be clearly above the bed to register as an event. Below
  // about 1.5x it is just part of the texture.
  const weak = r !== bed && ratio < 1.5;
  if (weak) bad++;
  console.log(
    `${r.name.padEnd(20)} ${String(r.peak).padStart(7)} ${String(r.rms).padStart(8)}` +
    `${r === bed ? '' : `   ${ratio.toFixed(2)}x${weak ? '  TOO QUIET' : ''}`}`,
  );
}
console.log(bad === 0 ? '\nALL EVENTS AUDIBLE OVER THE BED' : `\n${bad} EVENT(S) TOO QUIET`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
