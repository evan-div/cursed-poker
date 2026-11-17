#!/usr/bin/env -S npx tsx
/**
 * What the stress model actually does, over whole evenings.
 *
 *   npm run stress                          # four simulated six-handed evenings
 *   npm run stress -- --players 4 --seeds 8
 *   npm run stress -- --log recordings/*.stress.json
 *   npm run stress -- --tune '{"halfLifeMs": 14000}'
 *   npm run stress -- --tune tuning.json --save .telemetry/sim
 *
 * Every evening, simulated or recorded from a real match, is a log of what went
 * *into* the model (see `stress-telemetry.ts`). It is replayed under the shipped
 * tuning and, with `--tune`, under a candidate one, and the two are printed side
 * by side: how much of the evening people spent calm, shaking, soaked, pinned at
 * the top; how often their tells changed; which events did the work, and which
 * never happened at all.
 *
 * Simulated evenings are bots, and bots are not people — they never re-check
 * their cards and never stare at anybody. They are good for the shape of an
 * evening and for regressions. Real recordings, from a server started with
 * `STRESS_TELEMETRY_DIR`, are what to tune against.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { playEvening } from '../server/src/match/simulate.js';
import { DEFAULT_TUNING, type StressTuning } from '../server/src/match/stress.js';
import {
  StressRecorder,
  formatSummary,
  mergeSummaries,
  replayStress,
  summariseStress,
  type StressLog,
} from '../server/src/match/stress-telemetry.js';

const { values } = parseArgs({
  options: {
    players: { type: 'string', default: '6' },
    seeds: { type: 'string', default: '4' },
    seed: { type: 'string', default: '20260909' },
    log: { type: 'string', multiple: true },
    tune: { type: 'string' },
    save: { type: 'string' },
  },
  allowPositionals: true,
});

async function loadTuning(source: string | undefined): Promise<Partial<StressTuning> | null> {
  if (!source) return null;
  const text = source.trim().startsWith('{') ? source : await readFile(source, 'utf8');
  return JSON.parse(text) as Partial<StressTuning>;
}

async function evenings(): Promise<{ label: string; log: StressLog }[]> {
  if (values.log?.length) {
    return Promise.all(
      values.log.map(async (path) => ({ label: path, log: JSON.parse(await readFile(path, 'utf8')) as StressLog })),
    );
  }

  const players = Number(values.players);
  const count = Number(values.seeds);
  const first = Number(values.seed);
  const out: { label: string; log: StressLog }[] = [];
  for (let i = 0; i < count; i++) {
    const seed = first + i * 7_919;
    const recorder = new StressRecorder({ tuning: DEFAULT_TUNING });
    const evening = playEvening({ players, seed, telemetry: recorder });
    out.push({
      label: `seed ${seed}: ${players}-handed, ${evening.minutes.toFixed(0)} min, ${evening.hands} hands`,
      log: recorder.log,
    });
  }
  return out;
}

const tuning = await loadTuning(values.tune);
const all = await evenings();

if (values.save) {
  await mkdir(values.save, { recursive: true });
  for (const [i, { log }] of all.entries()) {
    await writeFile(join(values.save, `evening-${i}.stress.json`), JSON.stringify(log));
  }
}

const baseline = all.map(({ log }) => summariseStress(replayStress(log)));
const tuned = tuning ? all.map(({ log }) => summariseStress(replayStress(log, { ...log.tuning, ...tuning }))) : null;

for (const [i, { label }] of all.entries()) {
  console.log(`\n${label}`);
  console.log(formatSummary(baseline[i]!, tuned?.[i]));
}

console.log(`\n=== all ${all.length} evenings${tuning ? `, tuned with ${JSON.stringify(tuning)}` : ''} ===`);
console.log(formatSummary(mergeSummaries(baseline), tuned ? mergeSummaries(tuned) : undefined));

const fidelity = Math.max(...baseline.map((s) => s.fidelity));
console.log(`\nreplay matches the live match to within ${fidelity.toExponential(1)}`);
