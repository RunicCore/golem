import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_ID, GOLEM_ADAPTERS, type AdapterId, type PayloadId } from './cases.js';
import { prepareProjects, root } from './project.js';
import { environment, gitState, summarize, writeFilesTogether, type BatchSample, type MeasuredCase, type Settings } from './results.js';
import { adapterRounds, BenchmarkUsageError, measureAdapter, parseRunArguments, planRun, verifyAdapter } from './run.js';
import { formatReleaseRows, formatReleaseVerdict, releaseBand, releaseVerdict, type ReleasePair, type ReleaseTiming } from './tables.js';

const USAGE = 'Usage: npm run bench:release -- --base <git ref> [--adapters <id>,<id>] [--payloads <id>,<id>]';
const releaseDirectory = path.join(root, '.cache/benchmark/release');
const BUILT_MARK = '.release-built';
/**
 * More rounds than `npm run bench`, one batch in each: a worker process can land on a slow core for its whole run, and that
 * shifts the median of its batches. Four processes on each side keep one such process from setting the ratio, and base and
 * head swap places in every second round. The full check fits the five minutes of T-243 only at this many batches.
 */
export const RELEASE_SETTINGS: Settings = { warmupMs: 120, batchMs: 90, batches: 4, rounds: 4 };
type Side = 'base' | 'head';

export interface ReleaseArguments { readonly base: string; readonly adapters?: readonly AdapterId[]; readonly payloads?: readonly PayloadId[] }

/** Reads `--base <ref>` (required), also as `--base=<ref>`, and the `--adapters` and `--payloads` filters of `npm run bench`. */
export function parseReleaseArguments(args: readonly string[]): ReleaseArguments {
  let base: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base') base = args[++i];
    else if (arg.startsWith('--base=')) base = arg.slice('--base='.length);
    else rest.push(arg);
  }
  if (!base) throw new BenchmarkUsageError(`No base ref. ${USAGE}`);
  const { adapters, payloads } = parseRunArguments(rest);
  const foreign = adapters?.filter(id => !GOLEM_ADAPTERS.includes(id)) ?? [];
  if (foreign.length > 0) throw new BenchmarkUsageError(`The release check times golem only; ${foreign.map(id => `"${id}"`).join(', ')} is not golem. Golem adapters: ${GOLEM_ADAPTERS.join(', ')}`);
  return { base, ...(adapters ? { adapters } : {}), ...(payloads ? { payloads } : {}) };
}

function run(command: string, args: readonly string[], cwd: string, what: string, timeout: number): void {
  try {
    execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim().split('\n').slice(-12).join('\n') : String(error);
    throw new BenchmarkUsageError(`${what} failed:\n${detail}`);
  }
}

/**
 * Exports the base ref with `git archive` into `.cache/benchmark/release/<sha>` and builds its golem packages there.
 * The export is kept: a commit never changes, so a later check of the same sha skips the copy and the build. A folder
 * without its built mark is a failed build and is exported again. Nothing is written outside `.cache`.
 */
function exportBase(ref: string, log: (line: string) => void): { readonly sha: string; readonly directory: string } {
  let sha: string;
  try {
    sha = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new BenchmarkUsageError(`Unknown base ref "${ref}". ${USAGE}`);
  }
  const directory = path.join(releaseDirectory, sha);
  if (existsSync(path.join(directory, BUILT_MARK))) { log(`Reusing the built base ${sha.slice(0, 7)}`); return { sha, directory }; }
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  log(`Exporting base ${sha.slice(0, 7)}`);
  const archive = `${directory}.tar`;
  try {
    run('git', ['archive', '--format=tar', '--output', archive, sha], root, `Exporting base ${ref}`, 120_000);
    run('tar', ['-xf', archive, '-C', directory], root, `Unpacking base ${ref}`, 120_000);
  } finally {
    rmSync(archive, { force: true });
  }
  // Its links to its own packages are relative, so a copy of this checkout's node_modules points at the base's packages. `-c` clones on APFS.
  log('Copying node_modules');
  try { run('cp', ['-Rc', path.join(root, 'node_modules'), path.join(directory, 'node_modules')], root, 'Cloning node_modules', 300_000); }
  catch { rmSync(path.join(directory, 'node_modules'), { recursive: true, force: true }); run('cp', ['-R', path.join(root, 'node_modules'), path.join(directory, 'node_modules')], root, 'Copying node_modules', 300_000); }
  log(`Building base ${sha.slice(0, 7)}`);
  run('npm', ['run', 'build'], directory, `Building base ${ref}`, 300_000);
  writeFileSync(path.join(directory, BUILT_MARK), `${sha}\n`);
  return { sha, directory };
}

export interface ReleaseOptions extends ReleaseArguments { readonly outputFile: string; readonly log?: (line: string) => void }

/** Times this checkout and the base in one session and returns the console text and the verdict. */
export function runReleaseCheck(options: ReleaseOptions): { readonly text: string; readonly stop: boolean } {
  const started = Date.now();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { adapters, payloadsOf, payloadIds } = planRun(options.adapters ?? GOLEM_ADAPTERS, options.payloads);
  const base = exportBase(options.base, log);
  const loadStart = loadavg();
  mkdirSync(path.join(root, '.cache'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/release-work-'));
  try {
    // Both sides run this checkout's fixtures and harness; only the golem packages they generate with and run against differ.
    log('Preparing projects of this checkout and of the base (generation and compile)…');
    const sides: Record<Side, ReturnType<typeof prepareProjects>> = {
      head: prepareProjects(path.join(directory, 'head')),
      base: buildBase(directory, base, options.base),
    };
    const { batches, rounds } = RELEASE_SETTINGS;
    if (!Number.isInteger(batches / rounds)) throw new Error(`settings.batches (${batches}) must split evenly across settings.rounds (${rounds})`);
    for (const adapter of adapters) {
      for (const side of ['base', 'head'] as const) {
        log(`Verifying ${adapter.id} (${side})`);
        verifyAdapter(adapter.id, sides[side], RELEASE_SETTINGS, payloadsOf(adapter.id));
      }
    }
    // The rounds split into two halves; a case is judged in each half and fails only when it fails in both.
    const halfOf = (round: number): number => round < rounds / 2 ? 0 : 1;
    const samples = new Map<string, BatchSample[]>();
    const keep = (half: number, side: Side, results: readonly MeasuredCase[]): void => {
      for (const result of results) {
        const key = `${half}|${side}|${result.payload}/${result.operation}/${result.adapter}${result.invalid ? '/invalid' : ''}`;
        samples.set(key, [...(samples.get(key) ?? []), ...result.samples]);
      }
    };
    for (const [round, order] of adapterRounds(adapters.map(a => a.id), rounds).entries()) {
      for (const id of order) {
        // The control sits in the same rotation on both sides. Base and head swap places each round.
        const turn = round % 2 === 0 ? ['base' as const, 'head' as const] : ['head' as const, 'base' as const];
        for (const invalid of [false, true]) {
          for (const side of turn) {
            const results = measureAdapter(id, sides[side], RELEASE_SETTINGS, payloadsOf(id), invalid);
            if (results.length > 0) log(`Measured ${id} (${side}${invalid ? ', invalid input' : ''}, round ${round + 1} of ${rounds})`);
            keep(halfOf(round), side, results);
          }
        }
      }
    }
    const loadEnd = loadavg();
    // The median of one side's batches in the given halves.
    const median = (side: Side, caseKey: string, halves: readonly number[]): number =>
      summarize(halves.flatMap(h => samples.get(`${h}|${side}|${caseKey}`) ?? [])).median;
    const pair = (caseKey: string, halves: readonly number[]): ReleasePair => ({ base: median('base', caseKey, halves), head: median('head', caseKey, halves) });
    const caseKeys = (control: boolean, invalid: boolean): string[] => [...new Set([...samples.keys()].map(k => k.slice(k.indexOf('|', 2) + 1)))]
      .filter(k => (k.split('/')[2] === CONTROL_ID) === control && k.endsWith('/invalid') === invalid);
    // The control is the same code on both sides: its head/base ratios, in the halves the cases are judged in, measure the noise of the method.
    const { band, p90 } = releaseBand(caseKeys(true, false).flatMap(k => [0, 1].map(h => { const { base, head } = pair(k, [h]); return head / base; })));
    const timings = (invalid: boolean): ReleaseTiming[] => caseKeys(false, invalid).map(k => ({ key: k.replace(/\/invalid$/, ''), ...pair(k, [0, 1]), halves: [pair(k, [0]), pair(k, [1])] }));
    const valid = releaseVerdict(timings(false), band);
    const invalidRows = timings(true).length > 0 ? releaseVerdict(timings(true), band).rows : [];
    const seconds = Math.round((Date.now() - started) / 1000);
    const git = gitState(root);
    writeFilesTogether([[options.outputFile, () => JSON.stringify({
      schema: 1, measuredAt: new Date().toISOString(), seconds, base: { ref: options.base, sha: base.sha }, head: git, environment: environment(), settings: RELEASE_SETTINGS,
      adapters: adapters.filter(a => a.id !== CONTROL_ID).map(a => a.id), payloads: payloadIds,
      noise: { loadAverage: { start: loadStart, end: loadEnd }, band, bandP90: p90 }, verdict: valid.verdict,
      failing: valid.failing.map(r => r.key), means: valid.means, cases: valid.rows, invalid: invalidRows,
    }, null, 2) + '\n']]);
    const load = (values: readonly number[]): string => values.map(v => v.toFixed(2)).join(' ');
    const text = [
      `Valid path, this checkout over base ${base.sha.slice(0, 7)} (SLOWER: below ${(1 - band).toFixed(3)} in both halves):`,
      formatReleaseRows(valid.rows, true),
      ...(invalidRows.length > 0 ? ['', 'Invalid path (shown, no verdict):', formatReleaseRows(invalidRows, false)] : []),
      '',
      `Noise: host load average (1, 5, 15 min) ${load(loadStart)} at the start, ${load(loadEnd)} at the end; release band ${(band * 100).toFixed(1)}% (largest control ratio away from 1; 90th percentile ${(p90 * 100).toFixed(1)}%)`,
      '',
      formatReleaseVerdict(valid),
      `Wrote ${path.relative(root, options.outputFile)} in ${seconds} s`,
    ].join('\n');
    return { text, stop: valid.verdict === 'stop' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function buildBase(directory: string, base: { readonly directory: string }, ref: string): ReturnType<typeof prepareProjects> {
  try {
    return prepareProjects(path.join(directory, 'base'), base.directory);
  } catch (error) {
    const detail = error instanceof Error ? ('stdout' in error && String(error.stdout).trim() ? String(error.stdout) : error.message).trim().split('\n').slice(0, 12).join('\n') : String(error);
    throw new BenchmarkUsageError(`Base ${ref} cannot build this checkout's bench fixtures, so the two cannot be timed on the same cases:\n${detail}`);
  }
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  try {
    const { text, stop } = runReleaseCheck({ ...parseReleaseArguments(args), outputFile: path.join(root, '.cache/benchmark/release.json') });
    process.stdout.write(`${text}\n`);
    // A stop verdict is the answer of the check, not a fault: exit 1 so a script can tell it from a pass (0) and from a bad call (2).
    process.exitCode = stop ? 1 : 0;
  } catch (error) {
    if (!(error instanceof BenchmarkUsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
