import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepare, root } from './project.js';
import { summarize, type BatchSample } from './results.js';
import { sampleSync, schedule } from './sampling.js';
import { isValidModelValue, isValidModelValueFast, requireObjectCodec, type ValidateOptions } from '@exprtlabs/golem/serde';
import { BASE_TOGGLES, EXACT_PRESENCE_FORMS, GENERATED_TOGGLES, PRESENCE_FORMS, presenceFill, presenceWalk, scratchValidator, type Toggles } from './validator-toggles.js';
import type { Agreement, CompareCase, CompareTask, MobxTwins, Subject, TwinFactories, TwinKind } from './fixtures/typia/compare-case.js';

/**
 * Golem's validators and codecs against typia's `is`, `assert` and `equals`, and against hand-written decode and
 * encode, on one set of models (scripts/benchmark/fixtures/typia/typia-comparison.ts), with their IModel and MobX
 * twins, with failing values, and with scratch validators that switch one cost at a time. Every case runs in this
 * process, interleaved, so host load moves both sides together; read the ratios, not the absolute numbers.
 * Writes nothing under docs/: the committed results.json belongs to `npm run bench`.
 *
 * `npm run bench:typia`              validation, twins, failing values, decode and encode (one window)
 * `npm run bench:typia -- --toggles` the cost toggles on the scratch validators beside the generated fast checks and
 *                                    the codec call chain (one window)
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

const MODELS = ['flat', 'nested', 'union', 'array', 'tuple', 'optional'] as const;
/** The models whose decode and encode are timed; the optional-field model times validation only. */
const CONVERSION_MODELS = MODELS.filter(model => model !== 'optional');
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

/** What each library says about each probe value; a disagreement fails the run before any result is reported. */
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

/** The models whose generated fast check is below the scratch base; the lead rows run on these only. */
const LEAD_MODELS: ReadonlySet<string> = new Set(['flat', 'nested', 'union', 'array']);
/**
 * Each row: its toggles and the models it runs on (all when absent). A lead row adds one form the generated `is_X`
 * writes today to the base; `generated` adds them all.
 */
const TOGGLE_ROWS: readonly (readonly [string, Toggles, ReadonlySet<string>?])[] = [
  ['base', BASE_TOGGLES],
  ['key F2', { ...BASE_TOGGLES, keyTest: 'F2' }],
  ['floor', { ...BASE_TOGGLES, keyTest: 'none', finite: 'off', date: 'off' }, LEAD_MODELS],
  ['finite isFinite', { ...BASE_TOGGLES, finite: 'isFinite' }, LEAD_MODELS],
  ['date isFinite', { ...BASE_TOGGLES, date: 'isFinite' }, LEAD_MODELS],
  ['key read item', { ...BASE_TOGGLES, keyRead: 'item' }, LEAD_MODELS],
  ['required separate', { ...BASE_TOGGLES, required: 'separate' }, LEAD_MODELS],
  ['object helper', { ...BASE_TOGGLES, objectTest: 'helper' }, LEAD_MODELS],
  ['statements', { ...BASE_TOGGLES, body: 'statements' }, LEAD_MODELS],
  ['tag enumerable', { ...BASE_TOGGLES, tag: 'enumerable' }, new Set(['union'])],
  ['generated', GENERATED_TOGGLES, LEAD_MODELS],
];
/** Only the key test depends on how an instance is built, so the twins run these rows. */
const TWIN_TOGGLE_ROWS = new Set(['base', 'key F2', 'generated']);
/** The row that drops contracts: it must give the full validator's answer on the valid value and on a wrong field only. */
const FLOOR_ROW = 'floor';
/**
 * The codec call chain around a fresh scratch base, on the lead models: `hop codec` is today's chain (one arrow per
 * codec from one factory, a validate function per model, the runtime fast route), `hop direct` drops the arrow, and
 * `hop inline` writes the fast route in the model's validate function.
 */
const HOP_ROWS = ['hop codec', 'hop direct', 'hop inline'] as const;
type Check = (value: unknown, options?: ValidateOptions) => boolean;
/** One arrow site for every codec, as `createObjectCodec` makes them. */
const codecArrow = (validate: Check): Check => (value, options) => validate(value, options);
/** A validate function of its own per model, as each generated model module has one. */
function modelValidate(form: 'runtime' | 'inline', isValid: (value: unknown) => boolean, validator: Function, codecId: string): Check {
  const body = form === 'runtime'
    ? 'return fast(value, options, isValid, validator, id);'
    : 'if (options?.validationContext === undefined && isValid(value)) return true; return slow(value, options, validator, id);';
  const make = new Function('fast', 'slow', 'isValid', 'validator', 'id', `return function validate(value, options) { ${body} };`) as
    (fast: typeof isValidModelValueFast, slow: typeof isValidModelValue, isValid: (value: unknown) => boolean, validator: Function, id: string) => Check;
  return make(isValidModelValueFast, isValidModelValue, isValid, validator, codecId);
}

/** The generated functions of one project's validator module, by export name. */
type ValidatorExports = Readonly<Record<string, unknown>>;

/** The generated `is_X` or `validate_X` of a codec id: the export of that name, with or without the hash suffix. */
function generatedFunction(exports: ValidatorExports, prefix: 'is' | 'validate', codecId: string): Function {
  const pattern = new RegExp(`^${prefix}_${codecId}(_[0-9a-f]{8})?$`);
  const names = Object.keys(exports).filter(name => pattern.test(name));
  if (names.length !== 1) throw new Error(`The validator module has ${names.length} exports for ${prefix}_${codecId}: ${names.join(', ')}`);
  const found = exports[names[0]];
  if (typeof found !== 'function') throw new Error(`${names[0]} is not a function`);
  return found;
}

/** How many subjects' valid values the generated fast check accepts: each of those takes the fast route in the codec. */
const fastRoute = { accepted: 0, subjects: 0, probes: 0 };

/**
 * The timed cases, and the contract checks of their functions. The checks call the same functions with edge values of
 * other shapes (a missing key, an unknown key, a NaN), so they run after the timed window: run before it, they leave the
 * property reads of every checked function megamorphic, and the timed valid value reads about a third slower.
 */
interface ToggleRun { readonly cases: CompareCase[]; readonly checks: (() => void)[] }

function toggleCases(subjects: readonly Subject[], validators: Readonly<Record<TwinKind, ValidatorExports>>): ToggleRun {
  const cases: CompareCase[] = [];
  const checks: (() => void)[] = [];
  for (const subject of subjects) {
    const { model, twin } = subject;
    const entry = (side: string, run: () => unknown): void => { cases.push({ model, twin, task: 'toggle', side, run }); };
    const codec = requireObjectCodec<object>(subject.codecId);
    const isValid = generatedFunction(validators[twin], 'is', subject.codecId);
    const validator = generatedFunction(validators[twin], 'validate', subject.codecId);
    // The full validator decides what each probe must give; the codec, the fast check and the exact scratch rows agree with it.
    const probes = [['valid', subject.valid], ['early', subject.early], ['late', subject.late], ['extra', subject.extra], ...subject.probes] as const;
    const expected = new Map<string, boolean>();
    checks.push(() => {
      for (const [name, value] of probes) expected.set(name, validator(value, true).length === 0);
      if (expected.get('valid') !== true || expected.get('extra') !== false) throw new Error(`The validator of ${model}/${twin} does not accept the valid value or rejects no unknown property`);
      for (const [name, value] of probes) {
        const full = expected.get(name);
        if (codec.validate(value) !== full || isValid(value) !== full) throw new Error(`On ${model}/${twin} '${name}': the codec or the fast check differs from the validator (${full})`);
      }
      fastRoute.subjects++;
      if (isValid(subject.valid) === true) fastRoute.accepted++;
      fastRoute.probes += probes.length;
    });
    entry('typia equals', () => subject.equals(subject.valid));
    entry('typia is', () => subject.is(subject.valid));
    entry('golem is_X', () => isValid(subject.valid));
    entry('golem validate', () => codec.validate(subject.valid));
    for (const [side, toggles, models] of TOGGLE_ROWS) {
      if ((twin !== 'plain' && !TWIN_TOGGLE_ROWS.has(side)) || (models !== undefined && !models.has(model))) continue;
      const scratch = scratchValidator(model, toggles);
      checks.push(() => {
        for (const [probe, value] of probes) {
          const required = side !== FLOOR_ROW || ['valid', 'early', 'late'].includes(probe);
          if (required && scratch(value) !== expected.get(probe)) throw new Error(`Scratch validator '${side}' on ${model}/${twin}: '${probe}' is not ${expected.get(probe)}`);
        }
      });
      entry(side, () => scratch(subject.valid));
    }
    if (twin === 'plain' && LEAD_MODELS.has(model)) {
      const hops: Readonly<Record<(typeof HOP_ROWS)[number], Check>> = {
        'hop codec': codecArrow(modelValidate('runtime', scratchValidator(model, BASE_TOGGLES), validator, subject.codecId)),
        'hop direct': modelValidate('runtime', scratchValidator(model, BASE_TOGGLES), validator, subject.codecId),
        'hop inline': codecArrow(modelValidate('inline', scratchValidator(model, BASE_TOGGLES), validator, subject.codecId)),
      };
      for (const side of HOP_ROWS) {
        const run = hops[side];
        checks.push(() => {
          for (const [probe, value] of probes) if (run(value) !== expected.get(probe)) throw new Error(`'${side}' on ${model}: '${probe}' is not ${expected.get(probe)}`);
        });
        entry(side, () => run(subject.valid));
      }
    }
    if (model === 'flat') presenceCases(subject, entry, checks);
  }
  return { cases, checks };
}

/**
 * The presence forms on the flat model: the slow validator's walk on every twin, the decode fill on the plain value.
 * Each exact form must give the result of `enumerable` (golem today) on the probes, on a non-enumerable field, on an
 * undefined-valued field and on an inherited field.
 */
function presenceCases(subject: Subject, entry: (side: string, run: () => unknown) => void, checks: (() => void)[]): void {
  const valid = subject.valid;
  if (typeof valid !== 'object' || valid === null) throw new Error('The flat valid value is not an object');
  const plain: Record<string, unknown> = { ...valid };
  const probes: readonly unknown[] = [
    valid, subject.early, subject.late, subject.extra,
    Object.defineProperty({ ...plain }, 'email', { value: plain.email, enumerable: false }),
    { ...plain, age: undefined },
    Object.assign(Object.create({ name: plain.name }), Object.fromEntries(Object.entries(plain).filter(([key]) => key !== 'name'))),
  ];
  const fillProbes = probes.filter((probe): probe is object => typeof probe === 'object' && probe !== null);
  const reference = { walk: presenceWalk('enumerable'), fill: presenceFill('enumerable') };
  for (const form of PRESENCE_FORMS) {
    const walk = presenceWalk(form);
    const fill = presenceFill(form);
    if (EXACT_PRESENCE_FORMS.has(form)) {
      checks.push(() => {
        for (const probe of probes) if (walk(probe) !== reference.walk(probe)) throw new Error(`Presence walk '${form}' differs from 'enumerable' on ${subject.twin}`);
        for (const probe of fillProbes) {
          if (JSON.stringify(Object.entries(fill(probe))) !== JSON.stringify(Object.entries(reference.fill(probe)))) throw new Error(`Presence fill '${form}' differs from 'enumerable'`);
        }
      });
    }
    entry(`walk ${form}`, () => walk(valid));
    if (subject.twin === 'plain') entry(`fill ${form}`, () => fill(valid));
  }
}

function reportToggles(cases: readonly CompareCase[], samples: Map<CompareCase, BatchSample[]>): void {
  const median = medians(cases, samples);
  const sides = [...TOGGLE_ROWS.map(([side]) => side), ...HOP_ROWS];
  const against: string[][] = [['model', 'twin', 'equals ops/s', 'is/equals', 'is_X/equals', 'validate/equals', ...sides]];
  const gain: string[][] = [['model', 'twin', 'is_X/base', 'validate/is_X', ...sides.slice(1)]];
  for (const model of MODELS) for (const twin of TWINS) {
    const equals = median(model, twin, 'toggle', 'typia equals');
    const has = (side: string): boolean => cases.some(c => c.model === model && c.twin === twin && c.side === side);
    const value = (side: string): number => median(model, twin, 'toggle', side);
    against.push([model, twin, fixed(equals), ratio(value('typia is'), equals), ratio(value('golem is_X'), equals), ratio(value('golem validate'), equals), ...sides.map(side => has(side) ? ratio(value(side), equals) : '-')]);
    gain.push([model, twin, ratio(value('golem is_X'), value('base')), ratio(value('golem validate'), value('golem is_X')), ...sides.slice(1).map(side => has(side) ? ratio(value(side), value('base')) : '-')]);
  }
  process.stdout.write(`Generated fast check (is_X, called directly), the codec chain (codec.validate) and the scratch validators, ratio to typia equals (median of ${SETTINGS.batches} batches of ${SETTINGS.batchMs} ms)\n${table(against)}\n\n`);
  process.stdout.write(`is_X against the scratch base, the codec chain against is_X, and each toggle against the base row (above 1 is faster)\n${table(gain)}\n\n`);
  const presence: string[][] = [['shape', 'twin', ...PRESENCE_FORMS.map(form => `${form} ops/s`), ...PRESENCE_FORMS.slice(1).map(form => `${form}/enumerable`)]];
  for (const [shape, twins] of [['walk', TWINS], ['fill', ['plain']]] as const) for (const twin of twins) {
    const value = (form: string): number => median('flat', twin, 'toggle', `${shape} ${form}`);
    presence.push([shape, twin, ...PRESENCE_FORMS.map(form => fixed(value(form))), ...PRESENCE_FORMS.slice(1).map(form => ratio(value(form), value('enumerable')))]);
  }
  process.stdout.write(`Presence forms on the flat model: the slow validator's required and properties walk, and a seven-field decode fill\n${table(presence)}\n\n`);
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
  for (const model of CONVERSION_MODELS) for (const [task, name] of [['decode', 'fromWireFormat'], ['encode', 'toWireFormat']] as const) {
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
    const subjects = module.createSubjects(twins);
    const validators = async (project: string): Promise<ValidatorExports> => import(pathToFileURL(path.join(path.dirname(project), 'generated/models/models.validators.generated.js')).href);
    const plainValidators = await validators(built);
    const toggles = toggleCases(subjects, { plain: plainValidators, imodel: plainValidators, mobx: await validators(builtMobx) });
    // The checks run every probe on golem, typia and the scratch rows; they follow the timed window (see ToggleRun), so
    // no timed function, golem's or typia's, has seen a failing value before it is timed.
    const runChecks = (): void => {
      module.verifyCompareModels();
      reportAgreement(module.agreements(subjects));
      for (const check of toggles.checks) check();
      process.stdout.write(`The fast check accepts the valid value of ${fastRoute.accepted} of ${fastRoute.subjects} subjects (plain, IModel, MobX), so the codec answers those without the full validator; ${fastRoute.probes} probes agree with the full validator\n\n`);
    };
    if (mode === 'verify') { runChecks(); return; }
    const cases = mode === 'toggles' ? toggles.cases : module.createCompareCases(twins);
    const loadBefore = load();
    const started = performance.now();
    const samples = measure(module.consume, cases);
    const windowSeconds = (performance.now() - started) / 1000;
    runChecks();
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
