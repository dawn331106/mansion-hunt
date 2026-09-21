/**
 * Headless balance harness.
 *
 * Runs whole matches with bots on both sides, as fast as the CPU allows, and
 * reports how they ended. This exists because balance questions cannot be
 * answered by playing: "is the ghost too strong" is a question about a
 * distribution, and watching three matches tells you nothing about it.
 *
 * It found every real problem in this game's tuning. The first survivor was
 * dying 5.9 seconds into a match — before anyone had crossed a room — which
 * is invisible when you are the one playing and obvious the moment you
 * average it over a hundred runs.
 *
 *   npx tsx tools/balance.mjs [matches] [survivors]
 */

import { buildMansion } from '../src/game/map.ts';
import { createMatch, step } from '../src/game/sim.ts';
import { survivorBotIntent, resetSurvivorBots } from '../src/ai/survivorBot.ts';
import { ghostBotIntent, resetGhostBot } from '../src/ai/ghostBot.ts';

const mansion = buildMansion();
const DT = 1 / 60;
const MATCHES = Number(process.argv[2] || 100);
const SURVIVORS = Number(process.argv[3] || 3);
/** Hard stop, above the in-game clock, so a runaway match cannot hang the run. */
const MAX_SECONDS = 300;

let ghostWins = 0;
let survivorWins = 0;
let unresolved = 0;
let keyFound = 0;
let escapes = 0;
let hideEvents = 0;
let carrierDeaths = 0; let keyEscapes = 0;
let totalTime = 0;
const firstDeaths = [];
const keyTimes = [];
const reasons = {};

for (let seed = 1; seed <= MATCHES; seed++) {
  resetSurvivorBots();
  resetGhostBot();

  const state = createMatch(mansion, {
    survivorCount: SURVIVORS,
    // With a bot ghost every actor is driven by AI, which is what we want.
    humanRole: 'ghost',
    seed,
  });

  let tookKey = false;
  let sawDeath = false;

  for (let i = 0; i < 60 * MAX_SECONDS; i++) {
    const intents = new Map();
    for (const s of state.survivors) {
      if (s.alive && !s.escaped) intents.set(s.id, survivorBotIntent(state, mansion, s, DT));
    }
    intents.set('ghost', ghostBotIntent(state, mansion, DT));

    const ev = step(state, mansion, intents, DT);
    hideEvents += ev.hideChanged.filter((h) => h.spotId).length;

    if (state.key.taken && !tookKey) {
      tookKey = true;
      keyTimes.push(state.time);
    }
    if (!sawDeath && state.survivors.some((s) => !s.alive)) {
      sawDeath = true;
      firstDeaths.push(state.time);
    }
    for (const c of ev.caught) {
      const v = state.survivors.find((s) => s.id === c.survivorId);
      if (v && v.hasKey) carrierDeaths++;
    }
    if (ev.escaped) keyEscapes++;
    if (state.phase !== 'playing') break;
  }

  if (tookKey) keyFound++;
  escapes += state.survivors.filter((s) => s.escaped).length;
  totalTime += state.time;

  if (state.phase === 'ghost-won') ghostWins++;
  else if (state.phase === 'survivors-won') survivorWins++;
  else unresolved++;

  if (state.result) reasons[state.result.reason] = (reasons[state.result.reason] ?? 0) + 1;
}

const pct = (n) => `${((100 * n) / MATCHES).toFixed(0)}%`;
const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 'n/a');

console.log(`${MATCHES} matches, ${SURVIVORS} survivors\n`);
console.log(`ghost wins      ${ghostWins} (${pct(ghostWins)})`);
console.log(`survivor wins   ${survivorWins} (${pct(survivorWins)})`);
console.log(`unresolved      ${unresolved}`);
console.log(`key found       ${keyFound} (${pct(keyFound)})`);
console.log(`escapes         ${escapes}`);
console.log(`hides           ${hideEvents}`);
console.log(`avg length      ${(totalTime / MATCHES).toFixed(1)}s`);
console.log(`first death at  ${avg(firstDeaths)}s`);
console.log(`key taken at    ${avg(keyTimes)}s  (of ${keyTimes.length} matches)`);
console.log('\nhow they ended:');
for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${reason}`);
}
