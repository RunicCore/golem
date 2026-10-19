import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepare, root } from './project.js';
import { summarize, type BatchSample } from './results.js';
import { sampleSync, schedule } from './sampling.js';
import { BASE_TOGGLES, scratchValidator, type Toggles } from './validator-toggles.js';
import type { Agreement, CompareCase, CompareTask, MobxTwins, Subject, TwinFactories, TwinKind } from './fixtures/typia/compare-case.js';

/**
 * Golem's validators and codecs against typia's `is`, `assert` and `equals`, and against hand-written decode and
 * encode, on one set of models (scripts/benchmark/fixtures/typia/typia-comparison.ts), with their IModel and MobX
 * twins, with failing values, and with scratch validators that switch one cost at a time. Every case runs in this
 * process, interleaved, so host load moves both sides together; read the ratios, not the absolute numbers.
 * Writes nothing under docs/: the committed results.json belongs to `npm run bench`.
 *
 * `npm run bench:typia`              validation, twins, failing values, decode and encode (one window)
 * `npm run bench:typia -- --toggles` the cost toggles on the scratch validators (one window)
 * `npm run bench:typia -- --verify`  the checks only, no timing
 */
const SETTINGS = { warmupMs: 45, batchMs: 24, batches: 5 };
const TYPIA_FIXTURES = path.join(root, 'scripts/benchmark/fixtures/typia');
const MOBX_FIXTURES = path.join(root, 'scripts/benchmark/fixtures/typia-mobx');

interface CompareModule {
  verifyCompareModels(): void;
  createSubjects(twins: MobxTwins): readonly Subject[];
  agreements(subjects: readonly Subject[]): Agreement[];
  createCompareCases(twins: MobxTwins): readonly CompareCase[];
  consume(value: unknown): number;
}

const MODELS = ['flat', 'nested', 'union', 'array', 'tuple'] as const;
const TWINS: readonly TwinKind[] = ['plain', 'imodel', 'mobx'];
const fixed = (value: number): string => Math.round(value).toLocaleString('en-US');
const ratio = (a: number, b: number): string => (a / b).toFixed(2);
const load = (): string => loadavg().map(value => value.toFixed(2)).join(' ');

function measure(consume: (value: unknown) => number, cases: readonly CompareCase[]): Map<CompareCase, BatchSample[]> {
  const samples = new Map(cases.map(c => [c, [] as BatchSample[]]));
  for (const step of schedule(cases.length, SETTINGS)) {
    const item = cases[step.index];
    const result = sampleSync(item.run, consume, step.durationMs);
    if (step.timed) samples.get(item)?.push({ iterations: result.iterations, elapsedMs: result.elapsedMs });
  }
  return samples;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return rows.map(row => row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join('  ')).join('\n');
}

function medians(cases: readonly CompareCase[], samples: Map<CompareCase, BatchSample[]>): (model: string, twin: TwinKind, task: CompareTask, side: string) => number {
  return (model, twin, task, side) => {
    const found = cases.find(c => c.model === model && c.twin === twin && c.task === task && c.side === side);
    const taken = found && samples.get(found);
    if (!taken) throw new Error(`No samples for ${model}/${twin}/${task}/${side}`);
    return summarize(taken).median;
  };
}

/** What each library says about each probe value; a disagreement stops the run before any timing. */
function reportAgreement(rows: readonly Agreement[]): void {
  const mark = (value: boolean): string => value ? 'T' : 'F';
  const cell = (row: Agreement | undefined): string => row ? `${mark(row.golem)}${mark(row.typiaIs)}${mark(row.typiaEquals)}` : '?';
  const lines: string[][] = [['model', 'twin', 'valid', 'early', 'late', 'extra']];
  for (const model of MODELS) for (const twin of TWINS) {
    const find = (probe: Agreement['probe']) => rows.find(r => r.model === model && r.twin === twin && r.probe === probe);
    lines.push([model, twin, cell(find('valid')), cell(find('early')), cell(find('late')), cell(find('extra'))]);
  }
  process.stdout.write(`Agreement: golem validate, typia is, typia equals (T accepts, F rejects). Expected: TTT, FFF, FFF, FTF\n${table(lines)}\n`);
  for (const twin of ['imodel', 'mobx'] as const) {
    const accepted = rows.filter(r => r.twin === twin && r.probe === 'valid').every(r => r.typiaEquals);
    process.stdout.write(`typia equals accepts a ${twin} class instance of plain fields: ${accepted ? 'yes' : 'no'}\n`);
  }
  const wrong = rows.filter(r => !r.agrees);
  process.stdout.write(`${rows.length - wrong.length} of ${rows.length} probes as expected\n\n`);
  if (wrong.length > 0) throw new Error(`Validators disagree: ${wrong.map(r => `${r.model}/${r.twin}/${r.probe}`).join(', ')}`);
}

const TOGGLE_ROWS: readonly (readonly [string, Toggles])[] = [
  ['base', BASE_TOGGLES],
  ['key F2', { ...BASE_TOGGLES, keyTest: 'F2' }],
  ['key count', { ...BASE_TOGGLES, keyTest: 'count' }],
  ['key none', { ...BASE_TOGGLES, keyTest: 'none' }],
  ['finite isFinite', { ...BASE_TOGGLES, finite: 'isFinite' }],
  ['finite off', { ...BASE_TOGGLES, finite: 'off' }],
  ['date off', { ...BASE_TOGGLES, date: 'off' }],
  ['hops 4', { ...BASE_TOGGLES, hops: 4 }],
  ['floor', { keyTest: 'none', finite: 'off', date: 'off', hops: 0 }],
];
/** Only the key test and the floor depend on how an instance is built, so the twins run these rows. */
const TWIN_TOGGLE_ROWS = new Set(['base', 'key F2', 'key count', 'key none', 'floor']);
/** The rows whose result must equal typia `equals` on an unknown property: the sound key tests. */
const EXACT_ROWS = new Set(['base', 'key F2', 'finite isFinite', 'finite off', 'date off', 'hops 4']);

function toggleCases(subjects: readonly Subject[]): CompareCase[] {
  const cases: CompareCase[] = [];
  for (const subject of subjects) {
    const { model, twin } = subject;
    const entry = (side: string, run: () => unknown): void => { cases.push({ model, twin, task: 'toggle', side, run }); };
    entry('typia equals', () => subject.equals(subject.valid));
    entry('typia is', () => subject.is(subject.valid));
    for (const [side, toggles] of TOGGLE_ROWS) {
      if (twin !== 'plain' && !TWIN_TOGGLE_ROWS.has(side)) continue;
      const scratch = scratchValidator(model, toggles);
      for (const [probe, value, expected] of [['valid', subject.valid, true], ['early', subject.early, false], ['late', subject.late, false]] as const) {
        if (scratch(value) !== expected) throw new Error(`Scratch validator '${side}' on ${model}/${twin}: ${probe} is not ${expected}`);
      }
      if (EXACT_ROWS.has(side) && scratch(subject.extra) !== false) throw new Error(`Scratch validator '${side}' on ${model}/${twin} accepts an unknown property`);
      entry(side, () => scratch(subject.valid));
    }
  }
  return cases;
}

function reportToggles(cases: readonly CompareCase[], samples: Map<CompareCase, BatchSample[]>): void {
  const median = medians(cases, samples);
  const sides = TOGGLE_ROWS.map(([side]) => side);
  const against: string[][] = [['model', 'twin', 'equals ops/s', 'is/equals', ...sides]];
  const gain: string[][] = [['model', 'twin', ...sides.slice(1)]];
  for (const model of MODELS) for (const twin of TWINS) {
    const equals = median(model, twin, 'toggle', 'typia equals');
    const has = (side: string): boolean => cases.some(c => c.model === model && c.twin === twin && c.side === side);
    const value = (side: string): number => median(model, twin, 'toggle', side);
    against.push([model, twin, fixed(equals), ratio(value('typia is'), equals), ...sides.map(side => has(side) ? ratio(value(side), equals) : '-')]);
    gain.push([model, twin, ...sides.slice(1).map(side => has(side) ? ratio(value(side), value('base')) : '-')]);
  }
  process.stdout.write(`Scratch validators, ratio to typia equals (median of ${SETTINGS.batches} batches of ${SETTINGS.batchMs} ms)\n${table(against)}\n\n`);
  process.stdout.write(`Each toggle against the base row (above 1 is faster)\n${table(gain)}\n\n`);
}

function reportBench(cases: readonly CompareCase[], samples: Map<CompareCase, BatchSample[]>): void {
  const median = medians(cases, samples);
  const rows: string[][] = [['model', 'golem validate', 'golem assert', 'typia is', 'typia assert', 'typia equals', 'validate/is', 'assert/assert', 'validate/equals']];
  for (const model of MODELS) {
    const [gv, ga, ti, ta, te] = ['golem validate', 'golem assert', 'typia is', 'typia assert', 'typia equals'].map(side => median(model, 'plain', 'validate', side));
    rows.push([model, fixed(gv), fixed(ga), fixed(ti), fixed(ta), fixed(te), ratio(gv, ti), ratio(ga, ta), ratio(gv, te)]);
  }
  const twins: string[][] = [['model', 'twin', 'golem validate', 'typia is', 'typia equals', 'validate/is', 'validate/equals']];
  const failing: string[][] = [['model', 'twin', 'early golem', 'early equals', 'early ratio', 'early/valid', 'late golem', 'late equals', 'late ratio', 'late/valid']];
  for (const model of MODELS) for (const twin of TWINS) {
    const [gv, ti, te] = ['golem validate', 'typia is', 'typia equals'].map(side => median(model, twin, 'validate', side));
    twins.push([model, twin, fixed(gv), fixed(ti), fixed(te), ratio(gv, ti), ratio(gv, te)]);
    const [ge, ee, gl, el] = [['fail-early', 'golem validate'], ['fail-early', 'typia equals'], ['fail-late', 'golem validate'], ['fail-late', 'typia equals']]
      .map(([task, side]) => median(model, twin, task as CompareTask, side));
    failing.push([model, twin, fixed(ge), fixed(ee), ratio(ge, ee), ratio(ge, gv), fixed(gl), fixed(el), ratio(gl, el), ratio(gl, gv)]);
  }
  const conversion: string[][] = [['model', 'task', 'golem', 'golem validate off', 'hand-written', 'golem/hand', 'off/hand']];
  for (const model of MODELS) for (const [task, name] of [['decode', 'fromWireFormat'], ['encode', 'toWireFormat']] as const) {
    const [g, off, hand] = [`golem ${name}`, `golem ${name}, validate off`, 'hand-written'].map(side => median(model, 'plain', task, side));
    conversion.push([model, task, fixed(g), fixed(off), fixed(hand), ratio(g, hand), ratio(off, hand)]);
  }
  const header = `median of ${SETTINGS.batches} batches of ${SETTINGS.batchMs} ms`;
  process.stdout.write(`Validation of the plain IObject value, ops/s (${header})\n${table(rows)}\n\n`);
  process.stdout.write(`Validation of the twins (IModel class instance, MobX class instance), ops/s\n${table(twins)}\n\n`);
  process.stdout.write(`Failing values through codec.validate: one wrong field met early (first) or late (last); ratio to typia equals on the same value; early/valid and late/valid are golem's failing ops/s over its valid ops/s\n${table(failing)}\n\n`);
  process.stdout.write(`Decode and encode, ops/s\n${table(conversion)}\n\n`);
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--toggles') ? 'toggles' : process.argv.includes('--verify') ? 'verify' : 'bench';
  mkdirSync(path.join(root, '.cache'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/benchmark-work-'));
  try {
    process.stderr.write('Preparing the projects (generation and compile)…\n');
    const built = prepare(directory, 'validating', [TYPIA_FIXTURES]);
    const builtMobx = prepare(path.join(directory, 'mobx'), 'validating', [MOBX_FIXTURES], true);
    const module: CompareModule = await import(pathToFileURL(path.join(path.dirname(built), 'typia-comparison.js')).href);
    const mobx: { mobxTwins: TwinFactories } = await import(pathToFileURL(path.join(path.dirname(builtMobx), 'typia-mobx.model.js')).href);
    const twins: MobxTwins = { mobx: mobx.mobxTwins };
    module.verifyCompareModels();
    const subjects = module.createSubjects(twins);
    reportAgreement(module.agreements(subjects));
    if (mode === 'verify') return;
    const cases = mode === 'toggles' ? toggleCases(subjects) : module.createCompareCases(twins);
    const loadBefore = load();
    const started = performance.now();
    const samples = measure(module.consume, cases);
    const windowSeconds = (performance.now() - started) / 1000;
    if (mode === 'toggles') reportToggles(cases, samples); else reportBench(cases, samples);
    process.stdout.write(`Measured window ${windowSeconds.toFixed(1)} s for ${cases.length} cases; load average before ${loadBefore}, after ${load()}\n`);
    const raw = path.join(root, `.cache/benchmark/typia-validation${mode === 'toggles' ? '-toggles' : ''}.json`);
    mkdirSync(path.dirname(raw), { recursive: true });
    writeFileSync(raw, JSON.stringify({ settings: SETTINGS, windowSeconds, cases: cases.map(c => ({ model: c.model, twin: c.twin, task: c.task, side: c.side, samples: samples.get(c) })) }, null, 2));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
