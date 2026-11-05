import { STRESS_EVENTS, heartRateFor, tellsFor, type StressEvent } from '@cursed/shared';
import {
  applyStressEvent,
  createStress,
  forgetStress,
  resolveTuning,
  settleStress,
  stressOf,
  type StandingPressure,
  type StressTuning,
} from './stress.js';

/**
 * Recording what went into everybody's heart, and playing it back.
 *
 * Tuning the stress model by feel is hopeless: a weight that seems right in
 * one hand is wrong over an evening, and an evening is ninety minutes that
 * cannot be rerun. So a match records the model's **inputs** — every named
 * event with its intensity, and every change in the standing pressures — and
 * that recording can be replayed through any `StressTuning` to answer "what
 * would that same evening have felt like with a longer half-life?" in
 * milliseconds rather than another playtest.
 *
 * ## What a recording is allowed to contain
 *
 * Only what the model itself is allowed to read, which by the rule at the top
 * of `shared/src/stress.ts` is only what is already public: chip-derived
 * intensities, stacks in big blinds, the room's dread, whether the Dealer was
 * looking, whether a seat was still in the hand. No card, no hand, no player
 * name, no room code. Every entry is a short tuple of numbers and one event
 * name, so there is physically nowhere for a card to be — and
 * `stress-telemetry.test.ts` holds the format to exactly that, the same way
 * the presence protocol is held to an allowlist.
 *
 * That also means a recording can be kept, shared and diffed without anybody
 * worrying about what is in it, which is what makes it useful as data.
 */

export const TELEMETRY_VERSION = 1;

/**
 * One thing that happened, as compact as JSON allows.
 *
 * `t` is milliseconds since the recording began. Seats are seat indices.
 *
 *   - `E` an event: seat, its name, its intensity 0..1
 *   - `P` a seat's standing pressure changed: stack in big blinds (`null` for
 *     no blinds yet), the room's dread, watched 0/1, in the hand 0/1
 *   - `S` a sample of what the live model said, for checking a replay against
 *   - `F` a seat left the lobby and was forgotten
 */
export type StressLogEntry =
  | ['E', number, number, StressEvent, number]
  | ['P', number, number, number | null, number, 0 | 1, 0 | 1]
  | ['S', number, number, number]
  | ['F', number, number];

export interface StressLog {
  version: typeof TELEMETRY_VERSION;
  /** The tuning the live match ran on. */
  tuning: StressTuning;
  /** How often `S` entries were taken, in milliseconds. */
  sampleEveryMs: number;
  entries: StressLogEntry[];
}

/** What the match tells whoever is listening to its stress model. */
export interface StressObserver {
  event(now: number, seatIndex: number, event: StressEvent, intensity: number): void;
  /** After every settle, with the pressures used and a way to read the result. */
  settled(now: number, pressures: readonly StandingPressure[], read: (seatIndex: number) => number): void;
  forgot(now: number, seatIndex: number): void;
}

export interface StressRecorderOptions {
  tuning: StressTuning;
  /** Defaults to once a second, which is plenty for a heart over an evening. */
  sampleEveryMs?: number;
}

/**
 * Writes a `StressLog` as the match plays.
 *
 * Pressures are recorded only when they change, so a ninety-minute match is a
 * few thousand entries rather than one per seat per tick. That is lossless for
 * the model: the floor only moves when its inputs do, and decay is lazy, so
 * replaying a settle at every tick or only at every change lands on the same
 * numbers.
 */
export class StressRecorder implements StressObserver {
  readonly #log: StressLog;
  #startedAt: number | null = null;
  #nextSample = 0;
  #lastPressure = new Map<number, string>();

  constructor(options: StressRecorderOptions) {
    this.#log = {
      version: TELEMETRY_VERSION,
      tuning: options.tuning,
      sampleEveryMs: options.sampleEveryMs ?? 1_000,
      entries: [],
    };
  }

  get log(): StressLog {
    return this.#log;
  }

  /** True once anything at all has been recorded. */
  get started(): boolean {
    return this.#log.entries.length > 0;
  }

  event(now: number, seatIndex: number, event: StressEvent, intensity: number): void {
    this.#log.entries.push(['E', this.#t(now), seatIndex, event, intensity]);
  }

  settled(now: number, pressures: readonly StandingPressure[], read: (seatIndex: number) => number): void {
    const t = this.#t(now);
    for (const p of pressures) {
      const stack = Number.isFinite(p.stackBlinds) ? p.stackBlinds : null;
      const entry: StressLogEntry = ['P', t, p.seatIndex, stack, p.dread, p.watched ? 1 : 0, p.inHand ? 1 : 0];
      const key = entry.slice(2).join('|');
      if (this.#lastPressure.get(p.seatIndex) === key) continue;
      this.#lastPressure.set(p.seatIndex, key);
      this.#log.entries.push(entry);
    }

    if (t < this.#nextSample) return;
    this.#nextSample = t + this.#log.sampleEveryMs;
    for (const p of pressures) this.#log.entries.push(['S', t, p.seatIndex, read(p.seatIndex)]);
  }

  forgot(now: number, seatIndex: number): void {
    this.#lastPressure.delete(seatIndex);
    this.#log.entries.push(['F', this.#t(now), seatIndex]);
  }

  #t(now: number): number {
    if (this.#startedAt === null) this.#startedAt = now;
    return now - this.#startedAt;
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplaySample {
  t: number;
  seatIndex: number;
  /** What the live match said at this moment. */
  recorded: number;
  /** What this replay's tuning says. Equal to `recorded` under the same tuning. */
  replayed: number;
}

export interface ReplayResult {
  tuning: StressTuning;
  samples: ReplaySample[];
  /** Every event, with the spike it was worth under this tuning. */
  events: { t: number; seatIndex: number; event: StressEvent; worth: number }[];
  durationMs: number;
}

/**
 * Runs a recording back through the model, under any tuning.
 *
 * The same code the live match runs — `applyStressEvent`, `settleStress`,
 * `stressOf` — fed the same inputs in the same order. Under the recording's own
 * tuning the result matches what the players felt; under another, it is what
 * they would have felt instead.
 */
export function replayStress(log: StressLog, tuning: Partial<StressTuning> = log.tuning): ReplayResult {
  const resolved = resolveTuning(tuning);
  const stress = createStress(resolved);
  const samples: ReplaySample[] = [];
  const events: ReplayResult['events'] = [];
  let last = 0;

  for (const entry of log.entries) {
    last = Math.max(last, entry[1]);
    switch (entry[0]) {
      case 'E': {
        const [, t, seatIndex, event, intensity] = entry;
        applyStressEvent(stress, seatIndex, event, t, intensity);
        events.push({ t, seatIndex, event, worth: resolved.weights[event].spike * intensity });
        break;
      }
      case 'P': {
        const [, t, seatIndex, stack, dread, watched, inHand] = entry;
        settleStress(
          stress,
          [
            {
              seatIndex,
              stackBlinds: stack ?? Number.POSITIVE_INFINITY,
              dread,
              watched: watched === 1,
              inHand: inHand === 1,
            },
          ],
          t,
        );
        break;
      }
      case 'S': {
        const [, t, seatIndex, recorded] = entry;
        samples.push({ t, seatIndex, recorded, replayed: stressOf(stress, seatIndex, t) });
        break;
      }
      case 'F':
        forgetStress(stress, entry[2]);
        break;
    }
  }

  return { tuning: resolved, samples, events, durationMs: last };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface StressSummary {
  minutes: number;
  /** Seat-seconds sampled, across everybody. */
  samples: number;
  stress: { mean: number; p50: number; p90: number; max: number };
  heartRate: { p50: number; p90: number; max: number };
  /** Share of sampled time spent in each condition, across all seats. */
  share: {
    calm: number;
    breathingShows: number;
    trembling: number;
    damp: number;
    soaked: number;
    pinned: number;
  };
  /** How often a seat's broadcast tells changed, per seat-minute. */
  tellChangesPerMinute: number;
  /**
   * The evening in quarters: mean stress, and the share of time hands were
   * shaking, in each. The shape that matters most and averages hide — an
   * evening is supposed to get worse.
   */
  arc: { mean: number; trembling: number }[];
  /** Per event: how often, and how much stress it added in total. */
  events: Record<StressEvent, { count: number; worth: number }>;
  /** Events the model has a weight for that never happened. */
  neverFired: StressEvent[];
  /** The largest gap between replay and recording, if they share a tuning. */
  fidelity: number;
}

/** Thresholds the summary reports against. */
export const SUMMARY = {
  /** Below this, a seat counts as calm. */
  calm: 0.1,
  /** At or above this, a seat counts as pinned at the top of the scale. */
  pinned: 0.9,
} as const;

export function summariseStress(result: ReplayResult): StressSummary {
  const values = result.samples.map((s) => s.replayed).sort((a, b) => a - b);
  const n = Math.max(values.length, 1);
  const quantile = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  const share = (test: (stress: number) => boolean) => values.filter(test).length / n;

  // Tell changes, per seat, between consecutive samples.
  let changes = 0;
  const previous = new Map<number, string>();
  for (const sample of result.samples) {
    const tells = tellsFor(sample.replayed);
    const key = `${tells.tremor}|${tells.breathing}|${tells.sweat}`;
    const before = previous.get(sample.seatIndex);
    if (before !== undefined && before !== key) changes++;
    previous.set(sample.seatIndex, key);
  }

  const events = Object.fromEntries(STRESS_EVENTS.map((e) => [e, { count: 0, worth: 0 }])) as StressSummary['events'];
  for (const e of result.events) {
    events[e.event].count++;
    events[e.event].worth += e.worth;
  }

  const quarters = [0, 1, 2, 3].map(() => ({ sum: 0, shaking: 0, n: 0 }));
  for (const sample of result.samples) {
    const q = quarters[Math.min(3, Math.floor((sample.t / Math.max(result.durationMs, 1)) * 4))]!;
    q.sum += sample.replayed;
    if (tellsFor(sample.replayed).tremor > 0) q.shaking++;
    q.n++;
  }
  const arc = quarters.map((q) => ({ mean: q.n ? q.sum / q.n : 0, trembling: q.n ? q.shaking / q.n : 0 }));

  const sampleMinutes = (values.length * (result.samples.length > 1 ? sampleSpacing(result) : 1_000)) / 60_000;

  return {
    minutes: result.durationMs / 60_000,
    samples: values.length,
    stress: {
      mean: values.reduce((a, b) => a + b, 0) / n,
      p50: quantile(0.5),
      p90: quantile(0.9),
      max: values[values.length - 1] ?? 0,
    },
    heartRate: {
      p50: heartRateFor(quantile(0.5)),
      p90: heartRateFor(quantile(0.9)),
      max: heartRateFor(values[values.length - 1] ?? 0),
    },
    share: {
      calm: share((s) => s < SUMMARY.calm),
      breathingShows: share((s) => tellsFor(s).breathing > 0),
      trembling: share((s) => tellsFor(s).tremor > 0),
      damp: share((s) => tellsFor(s).sweat === 'DAMP'),
      soaked: share((s) => tellsFor(s).sweat === 'SOAKED'),
      pinned: share((s) => s >= SUMMARY.pinned),
    },
    tellChangesPerMinute: sampleMinutes > 0 ? changes / sampleMinutes : 0,
    arc,
    events,
    neverFired: STRESS_EVENTS.filter((e) => events[e].count === 0),
    fidelity: result.samples.reduce((worst, s) => Math.max(worst, Math.abs(s.recorded - s.replayed)), 0),
  };
}

/** The usual gap between one seat's samples, in milliseconds. */
function sampleSpacing(result: ReplayResult): number {
  const times = [...new Set(result.samples.map((s) => s.t))].sort((a, b) => a - b);
  if (times.length < 2) return 1_000;
  return (times[times.length - 1]! - times[0]!) / (times.length - 1);
}

/** Merges several evenings' summaries, weighting each by how much it sampled. */
export function mergeSummaries(summaries: StressSummary[]): StressSummary {
  const total = summaries.reduce((a, s) => a + s.samples, 0) || 1;
  const weighted = (pick: (s: StressSummary) => number) =>
    summaries.reduce((a, s) => a + pick(s) * s.samples, 0) / total;
  const most = (pick: (s: StressSummary) => number) => Math.max(0, ...summaries.map(pick));

  const events = Object.fromEntries(
    STRESS_EVENTS.map((e) => [
      e,
      {
        count: summaries.reduce((a, s) => a + s.events[e].count, 0),
        worth: summaries.reduce((a, s) => a + s.events[e].worth, 0),
      },
    ]),
  ) as StressSummary['events'];

  return {
    minutes: summaries.reduce((a, s) => a + s.minutes, 0),
    samples: total,
    stress: {
      mean: weighted((s) => s.stress.mean),
      p50: weighted((s) => s.stress.p50),
      p90: weighted((s) => s.stress.p90),
      max: most((s) => s.stress.max),
    },
    heartRate: {
      p50: Math.round(weighted((s) => s.heartRate.p50)),
      p90: Math.round(weighted((s) => s.heartRate.p90)),
      max: most((s) => s.heartRate.max),
    },
    share: {
      calm: weighted((s) => s.share.calm),
      breathingShows: weighted((s) => s.share.breathingShows),
      trembling: weighted((s) => s.share.trembling),
      damp: weighted((s) => s.share.damp),
      soaked: weighted((s) => s.share.soaked),
      pinned: weighted((s) => s.share.pinned),
    },
    tellChangesPerMinute: weighted((s) => s.tellChangesPerMinute),
    arc: [0, 1, 2, 3].map((q) => ({
      mean: weighted((s) => s.arc[q]!.mean),
      trembling: weighted((s) => s.arc[q]!.trembling),
    })),
    events,
    neverFired: STRESS_EVENTS.filter((e) => events[e].count === 0),
    fidelity: most((s) => s.fidelity),
  };
}

/**
 * A summary as a person reads it, optionally beside another.
 *
 * Plain text, because it is read in a terminal, pasted into a commit message,
 * and diffed between tunings.
 */
export function formatSummary(summary: StressSummary, against?: StressSummary): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const num = (v: number) => v.toFixed(3);
  const row = (label: string, a: string, b?: string) =>
    `  ${label.padEnd(26)}${a.padStart(10)}${b === undefined ? '' : b.padStart(12)}`;
  const both = (label: string, pick: (s: StressSummary) => number, format: (v: number) => string) =>
    row(label, format(pick(summary)), against ? format(pick(against)) : undefined);

  const lines = [
    against ? row('', 'baseline', 'tuned') : '',
    both('minutes of play', (s) => s.minutes, (v) => v.toFixed(0)),
    both('stress, mean', (s) => s.stress.mean, num),
    both('stress, median', (s) => s.stress.p50, num),
    both('stress, 90th percentile', (s) => s.stress.p90, num),
    both('stress, highest', (s) => s.stress.max, num),
    both('heart rate, median', (s) => s.heartRate.p50, (v) => `${v} bpm`),
    both('heart rate, 90th pct', (s) => s.heartRate.p90, (v) => `${v} bpm`),
    '',
    both('calm', (s) => s.share.calm, pct),
    both('breathing shows', (s) => s.share.breathingShows, pct),
    both('hands shaking', (s) => s.share.trembling, pct),
    both('damp', (s) => s.share.damp, pct),
    both('soaked', (s) => s.share.soaked, pct),
    both('pinned near the top', (s) => s.share.pinned, pct),
    both('tell changes / seat-min', (s) => s.tellChangesPerMinute, (v) => v.toFixed(2)),
    '',
    ...['first', 'second', 'third', 'last'].flatMap((name, q) => [
      both(`${name} quarter, mean`, (s) => s.arc[q]!.mean, num),
      both(`${name} quarter, shaking`, (s) => s.arc[q]!.trembling, pct),
    ]),
    '',
    '  events                       count   stress added',
    ...STRESS_EVENTS.map((e) => {
      const a = summary.events[e];
      const b = against?.events[e];
      return (
        `    ${e.padEnd(20)}${String(a.count).padStart(9)}${a.worth.toFixed(1).padStart(15)}` +
        (b ? `${b.worth.toFixed(1).padStart(12)}` : '')
      );
    }),
    '',
    summary.neverFired.length > 0
      ? `  never happened: ${summary.neverFired.join(', ')}`
      : '  every event happened at least once',
  ];
  return lines.filter((line, i) => !(i === 0 && line === '')).join('\n');
}
