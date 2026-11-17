import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StressLog } from '../match/stress-telemetry.js';

/**
 * Where finished matches' stress recordings go.
 *
 * An interface so the room manager can be tested without a disk, and so a
 * recording could go somewhere other than a directory later without the match
 * knowing.
 */
export interface StressLogSink {
  save(log: StressLog): Promise<void>;
}

/**
 * One JSON file per match, in a directory.
 *
 * Named by time and a few random bytes — never by room code, which is how a
 * stranger gets into a lobby, and never by anybody's name. The file holds only
 * what `stress-telemetry.ts` allows, which is nothing that identifies a person
 * or a card.
 */
export class DirectorySink implements StressLogSink {
  constructor(readonly directory: string) {}

  async save(log: StressLog): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${randomBytes(3).toString('hex')}.stress.json`;
    await writeFile(join(this.directory, name), JSON.stringify(log));
  }
}
