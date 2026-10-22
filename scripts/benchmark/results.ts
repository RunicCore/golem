import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import path from 'node:path';
import { ALL_PAYLOADS, BENCH_ADAPTERS, BENCH_OPERATIONS, COMPARE_CASES, COST_CASES, GROUPS, PAYLOADS, REPOSITORY_BLOB_URL, type AdapterId, type CaseSpec, type OperationId, type PayloadId } from './cases.js';
import type { BenchmarkResults, OpsPerSec, ResultCase } from './results-schema.js';

export interface BatchSample { readonly iterations: number; readonly elapsedMs: number }
export interface MeasuredCase { readonly payload: PayloadId; readonly operation: OperationId; readonly adapter: AdapterId; readonly payloadBytes: number; readonly samples: readonly BatchSample[] }
/** `batches` is the total per case, split evenly across `rounds`; each round runs every adapter once, in alternating order. */
export interface Settings { readonly warmupMs: number; readonly batchMs: number; readonly batches: number; readonly rounds: number }
export interface BuildInput {
  readonly measured: readonly MeasuredCase[];
  readonly settings: Settings;
  readonly environment: BenchmarkResults['environment'];
  readonly git: BenchmarkResults['git'];
  readonly packages: Readonly<Record<string, string>>;
  readonly measuredAt: string;
  /** The adapters that ran; the default is every adapter. Cases, payloads and adapters of the results cover only these. */
  readonly adapters?: readonly AdapterId[];
  /** The payloads that ran; the default is every payload. Cases and payloads of the results cover only these. */
  readonly payloads?: readonly PayloadId[];
}

export const PACKAGE_NAMES = ['@exprtlabs/golem', '@exprtlabs/golem-model', '@exprtlabs/golem-openapi', 'typescript', 'typia', 'class-transformer', 'class-validator', 'zod', 'ajv'] as const;

export function opsPerSecond(sample: BatchSample): number {
  return sample.iterations * 1000 / sample.elapsedMs;
}

export function summarize(samples: readonly BatchSample[]): OpsPerSec {
  if (samples.length === 0) throw new Error('Cannot summarize: no samples');
  const values = samples.map(sample => {
    const value = opsPerSecond(sample);
    if (!(sample.iterations > 0) || !(sample.elapsedMs > 0) || !(value > 0) || !Number.isFinite(value)) throw new Error(`Cannot summarize: invalid sample ${JSON.stringify(sample)}`);
    return value;
  }).sort((a, b) => a - b);
  const middle = values.length >> 1;
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return { median, min: values[0], max: values[values.length - 1] };
}

export function buildResults(input: BuildInput): BenchmarkResults {
  const byKey = new Map(input.measured.map(m => [`${m.payload}/${m.operation}/${m.adapter}`, m]));
  const ran = new Set<AdapterId>(input.adapters ?? BENCH_ADAPTERS.map(a => a.id));
  const ranPayloads = new Set<PayloadId>(input.payloads ?? ALL_PAYLOADS.map(p => p.id));
  const partial = ran.size < BENCH_ADAPTERS.length || ranPayloads.size < ALL_PAYLOADS.length;
  const resultCase = (c: CaseSpec): ResultCase => {
    const base = { payload: c.payload, operation: c.operation, adapter: c.adapter, support: c.support, ...(c.note ? { note: c.note } : {}) };
    if (c.support === 'none') return base;
    const measured = byKey.get(`${c.payload}/${c.operation}/${c.adapter}`);
    if (!measured) throw new Error(`Benchmark is missing measurement ${c.payload}/${c.operation}/${c.adapter}`);
    return { ...base, opsPerSec: summarize(measured.samples) };
  };
  const timedHere = (c: CaseSpec): boolean => ran.has(c.adapter) && ranPayloads.has(c.payload);
  const cases = COMPARE_CASES.filter(timedHere).map(resultCase);
  const cost = COST_CASES.filter(timedHere).map(resultCase);
  const bytes = (id: PayloadId): number => {
    const found = input.measured.find(m => m.payload === id);
    if (!found) throw new Error(`Benchmark is missing measurement for payload ${id}`);
    return found.payloadBytes;
  };
  return {
    schema: 2,
    measuredAt: input.measuredAt,
    git: input.git,
    environment: input.environment,
    packages: input.packages,
    settings: input.settings,
    groups: GROUPS.map(g => ({ id: g.id, label: g.label, description: g.description })),
    payloads: PAYLOADS.filter(p => !partial || input.measured.some(m => m.payload === p.id)).map(p => ({ id: p.id, label: p.label, bytes: bytes(p.id), description: p.description, sourceUrl: `${REPOSITORY_BLOB_URL}/${p.sourceFile}` })),
    operations: BENCH_OPERATIONS.map(o => ({ id: o.id, label: o.label, description: o.description })),
    adapters: BENCH_ADAPTERS.flatMap(a => a.group !== null && ran.has(a.id) ? [{ id: a.id, group: a.group, label: a.label, library: a.library, checked: a.checked, sourceUrl: `${REPOSITORY_BLOB_URL}/${a.sourceFile}` }] : []),
    cases,
    ...(cost.length > 0 ? { cost: { cases: cost } } : {}),
  };
}

export function gitState(root: string): BenchmarkResults['git'] {
  const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let sha: string;
  try { sha = git(['rev-parse', 'HEAD']); } catch { return { sha: 'uncommitted', dirty: true }; }
  let dirty = true;
  try { dirty = git(['status', '--porcelain']).length > 0; } catch { /* unknown status counts as dirty */ }
  return { sha, dirty };
}

export function packageVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const name of PACKAGE_NAMES) {
    const manifest: unknown = JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string') versions[name] = manifest.version;
    else throw new Error(`Cannot read version of ${name}`);
  }
  return versions;
}

export function environment(): BenchmarkResults['environment'] {
  return { node: process.version, os: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length };
}

/**
 * Produce every file's content and write each to a temporary file before
 * renaming any, so a failed write changes none of them. Temporary files are
 * removed on failure.
 */
export function writeFilesTogether(files: readonly (readonly [file: string, content: () => string])[]): void {
  const texts = files.map(([, content]) => content());
  const temporaries: string[] = [];
  try {
    for (const [index, [file]] of files.entries()) {
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      temporaries.push(temporary);
      writeFileSync(temporary, texts[index]);
    }
    for (const [index, [file]] of files.entries()) renameSync(temporaries[index], file);
  } catch (error) {
    for (const temporary of temporaries) rmSync(temporary, { force: true });
    throw error;
  }
}
