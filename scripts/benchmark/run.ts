import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterSpec, BENCH_ADAPTERS, BENCH_OPERATIONS, PAYLOADS, operationSpec, payloadSpec, timedCases, type AdapterId, type ProjectKind } from './cases.js';
import { prepareProjects, root } from './project.js';
import type { BenchmarkResults } from './results-schema.js';
import { buildResults, environment, gitState, packageVersions, writeFilesTogether, type MeasuredCase, type Settings } from './results.js';
import { parseWorkerOutput, type WorkerJob, type WorkerOutput } from './worker-protocol.js';

export const DEFAULT_SETTINGS: Settings = { warmupMs: 300, batchMs: 200, batches: 6, rounds: 2 };
export interface RunOptions { readonly settings: Settings; readonly outputFile: string; readonly rawFile: string; readonly log?: (line: string) => void }

function runWorker(modulePath: string, fixtureAdapter: string, job: WorkerJob): WorkerOutput {
  const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
  const stdout = execFileSync(process.execPath, [workerPath, modulePath, fixtureAdapter, JSON.stringify(job)],
    { cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  return parseWorkerOutput(stdout);
}

/**
 * Adapter order per round: forward, then reversed. Each adapter runs in its own process, so a single pass
 * would give the first adapter the host's state right after the project compiles; alternating spreads it.
 */
export function adapterRounds(adapters: readonly AdapterId[], rounds: number): AdapterId[][] {
  return Array.from({ length: rounds }, (_, round) => round % 2 === 0 ? [...adapters] : [...adapters].reverse());
}

function measureAdapter(id: AdapterId, projects: Record<ProjectKind, string>, settings: Settings): MeasuredCase[] {
  const adapter = adapterSpec(id);
  const mine = timedCases().filter(c => c.adapter === id);
  const job: WorkerJob = { settings: { ...settings, batches: settings.batches / settings.rounds }, cases: mine.map(c => ({ fixture: payloadSpec(c.payload).fixture, operation: operationSpec(c.operation).fixtureOperation })) };
  const output = runWorker(projects[adapter.project], adapter.fixtureAdapter, job);
  return mine.map(c => {
    const fixture = payloadSpec(c.payload).fixture;
    const operation = operationSpec(c.operation).fixtureOperation;
    const found = output.cases.find(r => r.fixture === fixture && r.operation === operation);
    if (!found) throw new Error(`${id}: worker returned no result for ${c.payload}/${c.operation}`);
    return { payload: c.payload, operation: c.operation, adapter: id, payloadBytes: found.payloadBytes, samples: found.samples };
  });
}

export function runBenchmark(options: RunOptions): BenchmarkResults {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  mkdirSync(path.join(root, '.cache'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/benchmark-work-'));
  try {
    log('Preparing projects (generation and compile)…');
    const projects = prepareProjects(directory);
    const { batches, rounds } = options.settings;
    if (!(rounds >= 1) || !Number.isInteger(batches / rounds)) throw new Error(`settings.batches (${batches}) must split evenly across settings.rounds (${rounds})`);
    const byCase = new Map<string, MeasuredCase>();
    for (const [round, order] of adapterRounds(BENCH_ADAPTERS.map(a => a.id), rounds).entries()) {
      for (const id of order) {
        log(`Measuring ${id} (round ${round + 1} of ${rounds})`);
        for (const result of measureAdapter(id, projects, options.settings)) {
          const key = `${result.payload}/${result.operation}/${result.adapter}`;
          const previous = byCase.get(key);
          byCase.set(key, previous ? { ...previous, samples: [...previous.samples, ...result.samples] } : result);
        }
      }
    }
    const measured = [...byCase.values()];
    // Everything below runs only after every worker succeeded.
    const results = buildResults({
      measured, settings: options.settings, environment: environment(), git: gitState(root),
      packages: packageVersions(root), measuredAt: new Date().toISOString(),
    });
    writeFilesTogether([
      [options.rawFile, () => JSON.stringify({ settings: options.settings, measured }, null, 2) + '\n'],
      [options.outputFile, () => JSON.stringify(results, null, 2) + '\n'],
    ]);
    return results;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function summaryTable(results: BenchmarkResults): string {
  const lines = [`${'payload'.padEnd(9)} ${'operation'.padEnd(10)} ${'adapter'.padEnd(19)} ${'median ops/s'.padStart(14)}`];
  for (const p of PAYLOADS) for (const o of BENCH_OPERATIONS) for (const c of results.cases.filter(x => x.payload === p.id && x.operation === o.id)) {
    const value = c.opsPerSec ? Math.round(c.opsPerSec.median).toLocaleString('en-US') : 'not supported';
    lines.push(`${c.payload.padEnd(9)} ${c.operation.padEnd(10)} ${c.adapter.padEnd(19)} ${value.padStart(14)}`);
  }
  return lines.join('\n');
}

export function main(): void {
  const started = Date.now();
  const outputFile = path.join(root, 'docs/public/benchmarks/results.json');
  const results = runBenchmark({ settings: DEFAULT_SETTINGS, outputFile, rawFile: path.join(root, '.cache/benchmark/raw.json') });
  process.stdout.write(`${summaryTable(results)}\n\nWrote ${path.relative(root, outputFile)} in ${Math.round((Date.now() - started) / 1000)} s\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
