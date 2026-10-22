import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterSpec, BENCH_ADAPTERS, BENCH_OPERATIONS, ALL_PAYLOADS, CASES, CONTROL_ID, COST_OPERATIONS, PAYLOADS, operationSpec, payloadSpec, timedCases, type AdapterId, type AdapterSpec, type CaseSpec, type PayloadId, type PayloadSpec, type ProjectKind } from './cases.js';
import { prepareProjects, root } from './project.js';
import type { BenchmarkResults } from './results-schema.js';
import { buildResults, environment, gitState, packageVersions, summarize, writeFilesTogether, type MeasuredCase, type Settings } from './results.js';
import { costTable, formatCostTable } from './tables.js';
import { parseWorkerOutput, type WorkerJob, type WorkerOutput } from './worker-protocol.js';

export const DEFAULT_SETTINGS: Settings = { warmupMs: 120, batchMs: 90, batches: 4, rounds: 2 };
/**
 * `adapters` names the adapters to run; it defaults to every adapter in `BENCH_ADAPTERS`.
 * `payloads` names the payloads to run; it defaults to every payload in `ALL_PAYLOADS`.
 */
export interface RunOptions { readonly settings: Settings; readonly outputFile: string; readonly rawFile: string; readonly adapters?: readonly AdapterId[]; readonly payloads?: readonly PayloadId[]; readonly log?: (line: string) => void }

/** A bad command line or option value. The caller fixes it; `main` prints it without a stack trace. */
export class BenchmarkUsageError extends Error {}

/** The adapters to run, in `BENCH_ADAPTERS` order. A name that no adapter has, or an empty list, is a usage error. */
function selectAdapters(requested?: readonly string[]): readonly AdapterSpec[] {
  if (requested === undefined) return BENCH_ADAPTERS;
  const valid = BENCH_ADAPTERS.map(a => a.id).join(', ');
  if (requested.length === 0) throw new BenchmarkUsageError(`No adapter named. Valid adapters: ${valid}`);
  const unknown = requested.filter(name => !BENCH_ADAPTERS.some(a => a.id === name));
  if (unknown.length > 0) throw new BenchmarkUsageError(`Unknown adapter ${unknown.map(name => `"${name}"`).join(', ')}. Valid adapters: ${valid}`);
  return BENCH_ADAPTERS.filter(a => requested.includes(a.id));
}

/** The payloads to run, in `ALL_PAYLOADS` order. A name that no payload has, or an empty list, is a usage error. */
export function selectPayloads(requested?: readonly string[]): readonly PayloadSpec[] {
  if (requested === undefined) return ALL_PAYLOADS;
  const valid = ALL_PAYLOADS.map(p => p.id).join(', ');
  if (requested.length === 0) throw new BenchmarkUsageError(`No payload named. Valid payloads: ${valid}`);
  const unknown = requested.filter(name => !ALL_PAYLOADS.some(p => p.id === name));
  if (unknown.length > 0) throw new BenchmarkUsageError(`Unknown payload ${unknown.map(name => `"${name}"`).join(', ')}. Valid payloads: ${valid}`);
  return ALL_PAYLOADS.filter(p => requested.includes(p.id));
}

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

/** The timed cases of one adapter on the selected payloads. */
function casesOf(id: AdapterId, payloads: ReadonlySet<PayloadId>): readonly CaseSpec[] {
  return timedCases().filter(c => c.adapter === id && payloads.has(c.payload));
}

function adapterJob(id: AdapterId, mode: WorkerJob['mode'], settings: Settings, payloads: ReadonlySet<PayloadId>): WorkerJob {
  const mine = casesOf(id, payloads);
  return { mode, settings: { ...settings, batches: settings.batches / settings.rounds }, cases: mine.map(c => ({ fixture: payloadSpec(c.payload).fixture, operation: operationSpec(c.operation).fixtureOperation })) };
}

/** Each library's own checks, invalid inputs included, in a process that times nothing. */
function verifyAdapter(id: AdapterId, projects: Record<ProjectKind, string>, settings: Settings, payloads: ReadonlySet<PayloadId>): void {
  const adapter = adapterSpec(id);
  runWorker(projects[adapter.project], adapter.fixtureAdapter, adapterJob(id, 'verify', settings, payloads));
}

function measureAdapter(id: AdapterId, projects: Record<ProjectKind, string>, settings: Settings, payloads: ReadonlySet<PayloadId>): MeasuredCase[] {
  const adapter = adapterSpec(id);
  const mine = casesOf(id, payloads);
  const output = runWorker(projects[adapter.project], adapter.fixtureAdapter, adapterJob(id, 'measure', settings, payloads));
  return mine.map(c => {
    const fixture = payloadSpec(c.payload).fixture;
    const operation = operationSpec(c.operation).fixtureOperation;
    const found = output.cases.find(r => r.fixture === fixture && r.operation === operation);
    if (!found) throw new Error(`${id}: worker returned no result for ${c.payload}/${c.operation}`);
    return { payload: c.payload, operation: c.operation, adapter: id, payloadBytes: found.payloadBytes, samples: found.samples };
  });
}

/** `results` is what the results file holds; `measured` is every timing of the run, the cost-table timings included. */
export interface BenchmarkRun { readonly results: BenchmarkResults; readonly measured: readonly MeasuredCase[] }

export function runBenchmark(options: RunOptions): BenchmarkRun {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // Checked before the projects compile, so a bad name fails at once.
  const selected = selectAdapters(options.adapters);
  const payloadIds = selectPayloads(options.payloads).map(p => p.id);
  const payloads: ReadonlySet<PayloadId> = new Set(payloadIds);
  // The control runs in every run, so every run has a noise band: on the selected payloads of the compare table, or on all of them when none is selected.
  const compareSelected = PAYLOADS.filter(p => payloads.has(p.id)).map(p => p.id);
  const controlPayloads: ReadonlySet<PayloadId> = new Set(compareSelected.length > 0 ? compareSelected : PAYLOADS.map(p => p.id));
  const payloadsOf = (id: AdapterId): ReadonlySet<PayloadId> => id === CONTROL_ID ? controlPayloads : payloads;
  // An adapter with no timed case on the selected payloads, such as Typia on the checkout, has nothing to run.
  const requested = selected.filter(a => casesOf(a.id, payloadsOf(a.id)).length > 0);
  if (requested.length === 0) throw new BenchmarkUsageError(`No timed case for adapter ${selected.map(a => `"${a.id}"`).join(', ')} on payload ${payloadIds.map(id => `"${id}"`).join(', ')}`);
  const adapters = requested.some(a => a.id === CONTROL_ID) ? requested : [...requested, adapterSpec(CONTROL_ID)];
  const loadStart = loadavg();
  mkdirSync(path.join(root, '.cache'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/benchmark-work-'));
  try {
    log('Preparing projects (generation and compile)…');
    const projects = prepareProjects(directory);
    const { batches, rounds } = options.settings;
    if (!(rounds >= 1) || !Number.isInteger(batches / rounds)) throw new Error(`settings.batches (${batches}) must split evenly across settings.rounds (${rounds})`);
    for (const adapter of adapters) {
      log(`Verifying ${adapter.id}`);
      verifyAdapter(adapter.id, projects, options.settings, payloadsOf(adapter.id));
    }
    const byCase = new Map<string, MeasuredCase>();
    for (const [round, order] of adapterRounds(adapters.map(a => a.id), rounds).entries()) {
      for (const id of order) {
        log(`Measuring ${id} (round ${round + 1} of ${rounds})`);
        for (const result of measureAdapter(id, projects, options.settings, payloadsOf(id))) {
          const key = `${result.payload}/${result.operation}/${result.adapter}`;
          const previous = byCase.get(key);
          byCase.set(key, previous ? { ...previous, samples: [...previous.samples, ...result.samples] } : result);
        }
      }
    }
    const measured = [...byCase.values()];
    const loadEnd = loadavg();
    // Everything below runs only after every worker succeeded.
    const results = buildResults({
      measured, settings: options.settings, environment: environment(), git: gitState(root),
      packages: packageVersions(root), measuredAt: new Date().toISOString(), adapters: selected.map(a => a.id), payloads: payloadIds, loadAverage: { start: loadStart, end: loadEnd },
    });
    writeFilesTogether([
      [options.rawFile, () => JSON.stringify({ settings: options.settings, measured }, null, 2) + '\n'],
      [options.outputFile, () => JSON.stringify(results, null, 2) + '\n'],
    ]);
    return { results, measured };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One line for each case of the selected adapters and payloads, in table order; the cost-table timings are in it. */
function summaryTable(measured: readonly MeasuredCase[], adapters: readonly AdapterId[] | undefined, payloads: readonly PayloadId[] | undefined): string {
  const lines = [`${'payload'.padEnd(9)} ${'operation'.padEnd(10)} ${'adapter'.padEnd(19)} ${'median ops/s'.padStart(14)}`];
  for (const p of ALL_PAYLOADS.filter(x => payloads?.includes(x.id) ?? true)) for (const o of [...BENCH_OPERATIONS, ...COST_OPERATIONS]) {
    for (const c of CASES.filter(x => x.payload === p.id && x.operation === o.id && (adapters?.includes(x.adapter) ?? true))) {
      const found = measured.find(m => m.payload === c.payload && m.operation === c.operation && m.adapter === c.adapter);
      // An adapter with no timed case on the selected payloads is not in `measured`; only an unsupported case shows "not supported".
      if (!found && c.support === 'full') continue;
      const value = found ? Math.round(summarize(found.samples).median).toLocaleString('en-US') : 'not supported';
      lines.push(`${c.payload.padEnd(9)} ${c.operation.padEnd(10)} ${c.adapter.padEnd(19)} ${value.padStart(14)}`);
    }
  }
  return lines.join('\n');
}

/** The cost table with its heading, or nothing when the run timed no cost row. */
function costSection(results: BenchmarkResults): string {
  const rows = costTable(results);
  return rows.length === 0 ? '' : `What validation costs (median ops/s; on/off divides the build with validation on by the build with validation off):\n${formatCostTable(rows)}\n\n`;
}

/** The noise of the run in one line: the host load and the control's spread. */
function noiseLine(results: BenchmarkResults): string {
  const { noise } = results;
  if (!noise) return 'Noise: no control timing in this run';
  const load = (values: readonly number[]): string => values.map(v => v.toFixed(2)).join(' ');
  return `Noise: host load average (1, 5, 15 min) ${load(noise.loadAverage.start)} at the start, ${load(noise.loadAverage.end)} at the end; control spread ${(noise.controlSpread * 100).toFixed(1)}%`;
}

const USAGE = 'Usage: npm run bench -- [--adapters <id>,<id>] [--payloads <id>,<id>]';

/**
 * Reads `--adapters a,b` and `--payloads a,b`, each also as `--name=a,b`. Any other argument, or a name that no adapter
 * or payload has, is a usage error. A run with a filter writes under `.cache`, not to the published results.
 */
export function parseRunArguments(args: readonly string[]): { readonly adapters?: readonly AdapterId[]; readonly payloads?: readonly PayloadId[] } {
  const lists = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [flag] = arg.split('=', 1);
    if (flag !== '--adapters' && flag !== '--payloads') throw new BenchmarkUsageError(`Unknown argument "${arg}". ${USAGE}`);
    lists.set(flag, arg === flag ? args[++i] ?? '' : arg.slice(flag.length + 1));
  }
  const names = (flag: string): string[] | undefined => lists.get(flag)?.split(',').filter(name => name !== '');
  const adapters = names('--adapters');
  const payloads = names('--payloads');
  return {
    ...(adapters ? { adapters: selectAdapters(adapters).map(a => a.id) } : {}),
    ...(payloads ? { payloads: selectPayloads(payloads).map(p => p.id) } : {}),
  };
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  const started = Date.now();
  let selection: ReturnType<typeof parseRunArguments>;
  try {
    selection = parseRunArguments(args);
  } catch (error) {
    if (!(error instanceof BenchmarkUsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  // A run of some adapters or payloads must not replace the published results of all of them.
  const filtered = selection.adapters !== undefined || selection.payloads !== undefined;
  const outputFile = path.join(root, filtered ? '.cache/benchmark/results.json' : 'docs/public/benchmarks/results.json');
  try {
    const { results, measured } = runBenchmark({ settings: DEFAULT_SETTINGS, outputFile, rawFile: path.join(root, '.cache/benchmark/raw.json'), ...selection });
    process.stdout.write(`${summaryTable(measured, selection.adapters, selection.payloads)}\n\n${costSection(results)}${noiseLine(results)}\n\nWrote ${path.relative(root, outputFile)} in ${Math.round((Date.now() - started) / 1000)} s\n`);
  } catch (error) {
    if (!(error instanceof BenchmarkUsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
