import { describe, expect, it } from 'vitest';
import { PRESENCE } from '@cursed/shared';
import { PresenceReporter, type BodyReport } from './presence-reporter.js';

/**
 * Reporting your own body.
 *
 * The property being protected is that a player who is not moving is still
 * *reported* as not moving. It would be easy, and wrong, to write a change-gated
 * reporter that goes silent when nothing happens: a client that says nothing is
 * indistinguishable from one that has crashed, and "perfectly still" is exactly
 * the state a nervous player would most like to fake.
 */

function makeReporter(hz = 15, heartbeatMs: number = PRESENCE.heartbeatMs) {
  const sent: BodyReport[] = [];
  const reporter = new PresenceReporter({ send: (r) => sent.push(r), hz, heartbeatMs });
  reporter.setEnabled(true);
  return { reporter, sent };
}

describe('reporting a body', () => {
  it('says nothing at all before the player is at a table', () => {
    const sent: BodyReport[] = [];
    const reporter = new PresenceReporter({ send: (r) => sent.push(r) });
    reporter.setGaze({ kind: 'DEALER' });
    for (let t = 0; t < 5_000; t += 50) reporter.update(t);
    expect(sent).toHaveLength(0);
  });

  it('sends the first report as soon as it is switched on', () => {
    const { reporter, sent } = makeReporter();
    reporter.update(0);
    expect(sent).toHaveLength(1);
  });

  it('sends changes, at its own rate and no faster', () => {
    const { reporter, sent } = makeReporter(15);
    reporter.update(0);

    // Ten changes inside a single interval produce one report, not ten.
    for (let i = 1; i <= 10; i++) {
      reporter.setPeek(i / 10);
      reporter.update(i);
    }
    expect(sent).toHaveLength(1);

    reporter.update(100);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.peek).toBe(1);
  });

  it('keeps reporting stillness when nothing is happening', () => {
    const { reporter, sent } = makeReporter(15, 500);
    for (let t = 0; t <= 2_000; t += 10) reporter.update(t);

    // Nothing changed for two seconds, and the table was told so four times
    // rather than being left to wonder whether we were still connected.
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.every((r) => r.peek === 0 && r.gaze.kind === 'AWAY')).toBe(true);
  });

  it('does not repeat itself between heartbeats', () => {
    const { reporter, sent } = makeReporter(60, 10_000);
    for (let t = 0; t <= 1_000; t += 5) reporter.update(t);
    expect(sent).toHaveLength(1);
  });

  it('notices each kind of movement', () => {
    const { reporter, sent } = makeReporter(60, 10_000);
    reporter.update(0);

    reporter.setGaze({ kind: 'SEAT', seatIndex: 3 });
    reporter.update(100);
    reporter.setHandlingChips(true);
    reporter.update(200);
    reporter.setPeek(0.5);
    reporter.update(300);

    expect(sent).toHaveLength(4);
    expect(sent.at(-1)).toEqual({
      gaze: { kind: 'SEAT', seatIndex: 3 },
      peek: 0.5,
      handlingChips: true,
    });
  });

  it('rounds exposure before it goes on the wire', () => {
    const { reporter, sent } = makeReporter(60, 10_000);
    reporter.setPeek(0.41379);
    reporter.update(0);
    expect(sent[0]!.peek * PEEK_STEPS).toBeCloseTo(Math.round(sent[0]!.peek * PEEK_STEPS), 9);

    // A change too small to survive rounding is not worth a packet.
    reporter.setPeek(0.41381);
    reporter.update(1_000);
    expect(sent).toHaveLength(1);
  });
});

const PEEK_STEPS = 16;
