import { performance } from 'node:perf_hooks';
import type { Settings } from './results.js';

/** Warmup is split into this many untimed rotations over all cases. */
export const WARMUP_ROUNDS = 3;
/** Synchronous loops read the clock once per this many calls. */
const CLOCK_STRIDE = 8;
const MODULUS = 2_147_483_647;

export interface Step { readonly index: number; readonly durationMs: number; readonly timed: boolean }
export interface Sampled { readonly iterations: number; readonly elapsedMs: number; readonly checksum: number }

function rotation(caseCount: number, round: number): number[] {
  const offset = caseCount ? round % caseCount : 0;
  return Array.from({ length: caseCount }, (_, i) => (i + offset) % caseCount);
}

/**
 * Warm up in the same interleaving the timed batches use, so shared runtime
 * code sees every case before sampling starts; then rotate the order per batch
 * so no case always runs in the same slot.
 */
export function schedule(caseCount: number, settings: Pick<Settings, 'warmupMs' | 'batchMs' | 'batches'>): Step[] {
  const steps: Step[] = [];
  if (settings.warmupMs > 0) {
    for (let round = 0; round < WARMUP_ROUNDS; round++) {
      for (const index of rotation(caseCount, round)) steps.push({ index, durationMs: settings.warmupMs / WARMUP_ROUNDS, timed: false });
    }
  }
  for (let batch = 0; batch < settings.batches; batch++) {
    for (const index of rotation(caseCount, batch)) steps.push({ index, durationMs: settings.batchMs, timed: true });
  }
  return steps;
}

export function sampleSync(run: () => unknown, consume: (value: unknown) => number, durationMs: number): Sampled {
  let iterations = 0;
  let checksum = 0;
  const start = performance.now();
  let elapsedMs = 0;
  do {
    for (let i = 0; i < CLOCK_STRIDE; i++) checksum = (checksum + consume(run())) % MODULUS;
    iterations += CLOCK_STRIDE;
    elapsedMs = performance.now() - start;
  } while (elapsedMs < durationMs);
  return { iterations, elapsedMs, checksum };
}

export async function sampleAsync(run: () => unknown, consume: (value: unknown) => number, durationMs: number): Promise<Sampled> {
  let iterations = 0;
  let checksum = 0;
  const start = performance.now();
  do { checksum = (checksum + consume(await run())) % MODULUS; iterations++; }
  while (performance.now() - start < durationMs);
  return { iterations, elapsedMs: performance.now() - start, checksum };
}
