import { OPERATIONS, type Operation } from './fixture-contract.js';
import type { BatchSample, Settings } from './results.js';

interface WorkerCase { readonly fixture: string; readonly operation: Operation }
/**
 * `verify` runs each fixture's own checks, invalid inputs included, and times nothing. `measure` checks only valid
 * results, then times: a validator that has rejected input runs slower afterwards, so every library is timed
 * in a process whose timed functions have seen valid input only. `invalid` times the fixtures' invalid operations (rejected input)
 * in a process of its own, for the same reason.
 */
type WorkerMode = 'verify' | 'measure' | 'invalid';
export interface WorkerJob { readonly mode: WorkerMode; readonly settings: Settings; readonly cases: readonly WorkerCase[] }
export interface WorkerCaseResult extends WorkerCase { readonly payloadBytes: number; readonly samples: readonly BatchSample[] }
export interface WorkerOutput { readonly fixtureAdapter: string; readonly checksum: number; readonly cases: readonly WorkerCaseResult[] }

// The job and the output cross a process boundary as JSON; check their shape before use.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isSettings = (value: unknown): value is Settings => isObject(value) && isCount(value.warmupMs) && isCount(value.batchMs) && isCount(value.batches);
const isCase = (value: unknown): value is WorkerCase => isObject(value) && typeof value.fixture === 'string'
  && (OPERATIONS as readonly unknown[]).includes(value.operation);
const isSample = (value: unknown): value is BatchSample => isObject(value) && isCount(value.iterations) && isCount(value.elapsedMs);

function parse<T>(text: string, what: string, guard: (value: unknown) => value is T): T {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Malformed ${what}: not JSON`); }
  if (!guard(value)) throw new Error(`Malformed ${what}: ${text.slice(0, 200)}`);
  return value;
}

export function parseWorkerJob(text: string): WorkerJob {
  return parse(text, 'worker job', (value): value is WorkerJob => isObject(value) && (value.mode === 'verify' || value.mode === 'measure' || value.mode === 'invalid') && isSettings(value.settings)
    && Array.isArray(value.cases) && value.cases.every(isCase));
}

export function parseWorkerOutput(text: string): WorkerOutput {
  return parse(text, 'worker output', (value): value is WorkerOutput => isObject(value) && typeof value.fixtureAdapter === 'string'
    && typeof value.checksum === 'number' && Number.isFinite(value.checksum) && Array.isArray(value.cases)
    && value.cases.every(c => isCase(c) && isObject(c) && isCount(c.payloadBytes) && Array.isArray(c.samples) && c.samples.every(isSample)));
}
