import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFile } from '../placements/agents/deps.js';
import { activeRejections, parseRejections, withRejection, type Rejection } from './rejection.js';
import { cacheDir } from '../paths.js';

// Models an agent refused at launch, kept in the cache folder: it is observed state, safe to delete.
const FILE = 'rejected-models.json';

export function readRejections(readFile: (p: string) => string | undefined = readTextFile, dir: string = cacheDir()): Rejection[] {
  return parseRejections(readFile(join(dir, FILE)));
}

export function writeRejections(list: readonly Rejection[], dir: string = cacheDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), `${JSON.stringify({ rejections: list }, null, 2)}\n`);
}

/** Saves `r`, replacing an older entry for the same agent and model and dropping expired ones. */
export function recordRejection(r: Rejection, ttlHours: number, dir: string = cacheDir()): void {
  writeRejections(activeRejections(withRejection(readRejections(readTextFile, dir), r), r.at, ttlHours), dir);
}
