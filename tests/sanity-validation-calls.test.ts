import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec, serdeValidates } from '@exprtlabs/golem/internal/model-runtime';
import type { ObjectCodec, SerdeOptions } from '@exprtlabs/golem/serde';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { fileFixtureScope } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

type Outcome = 'accepts' | 'rejects' | 'unavailable';
type CallName = 'omitted' | 'true' | 'sanity' | 'false';
type Level = true | 'sanity' | false;

/** What a failed call came to: it failed the check, or its level does not exist. Any other error is not about the level. */
function failure(error: unknown): Outcome {
  if (!(error instanceof LibError)) throw error;
  if (error.kind === LibErrorKind.ValidationUnavailable) return 'unavailable';
  if (error.kind === LibErrorKind.Validation) return 'rejects';
  throw error;
}
/** The answer of a call that returned: `false` from `validate` or issues from `validateInstance` are rejections. */
function answer(result: unknown): Outcome {
  return result === false || (Array.isArray(result) && result.length > 0) ? 'rejects' : 'accepts';
}
function outcomeOf(run: () => unknown): Outcome {
  try {
    return answer(run());
  } catch (error) {
    return failure(error);
  }
}
async function outcomeOfAsync(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return answer(await run());
  } catch (error) {
    return failure(error);
  }
}

const CALL_OPTIONS: Record<CallName, SerdeOptions> = { omitted: {}, true: { validate: true }, sanity: { validate: 'sanity' }, false: { validate: false } };
const CALLS = Object.keys(CALL_OPTIONS) as CallName[];

/** What the call rule gives for (default, cap) and each way of calling: the level, or the error it throws. */
function levelOf(options: SerdeOptions, defaultLevel: Level, cap: Level): Level | Outcome | 'TypeError' {
  try {
    return serdeValidates(options, defaultLevel, cap) as Level;
  } catch (error) {
    return error instanceof TypeError ? 'TypeError' : failure(error);
  }
}

const CALL_RULE: readonly (readonly [defaultLevel: Level, cap: Level, Record<CallName, Level | 'unavailable'>])[] = [
  [true, true, { omitted: true, true: true, sanity: 'sanity', false: false }],
  ['sanity', true, { omitted: 'sanity', true: true, sanity: 'sanity', false: false }],
  ['sanity', 'sanity', { omitted: 'sanity', true: 'unavailable', sanity: 'sanity', false: false }],
  [false, false, { omitted: false, true: 'unavailable', sanity: 'unavailable', false: false }],
];
/** A JavaScript caller can pass any value; none of these may read as "off". */
const NOT_A_LEVEL: readonly unknown[] = [null, 0, '', 'full', 1];

interface CallRuleRow { readonly defaultLevel: Level; readonly cap: Level; readonly validate: unknown; readonly expected: Level | 'unavailable' | 'TypeError' }
const CALL_RULE_ROWS: readonly CallRuleRow[] = CALL_RULE.flatMap(([defaultLevel, cap, expected]) => [
  ...CALLS.map(call => ({ defaultLevel, cap, validate: CALL_OPTIONS[call].validate, expected: expected[call] })),
  ...NOT_A_LEVEL.map(validate => ({ defaultLevel, cap, validate, expected: 'TypeError' as const })),
]);

for (const { defaultLevel, cap, validate, expected } of CALL_RULE_ROWS) {
  test(`the call rule: default ${String(defaultLevel)}, cap ${String(cap)}, validate ${typeof validate === 'string' ? `'${validate}'` : String(validate)} gives ${String(expected)}`, () => {
    // protects: R-72 a call may lower the level, never raise it above the project's
    assert.equal(levelOf(validate === undefined ? {} : { validate: validate as never }, defaultLevel, cap), expected);
  });
}

const RULES = `export let calls = 0;
export function notBlank(value: string): boolean | string { calls++; return value.trim().length > 0 || 'blank'; }
export function reset(): void { calls = 0; }
`;
const header = (classes: readonly string[]): string => `import type { IModel } from '@exprtlabs/golem/model';
import type { MaxLength, TValidation } from '@exprtlabs/golem/tags';
import { notBlank } from './rules.js';
import { ${classes.map(name => `T${name}BaseModel`).join(', ')} } from './models.model.generated.js';
type Fields = { name: string & MaxLength<3>; qty: number; note?: string & TValidation<typeof notBlank> };
export type TInherit = IModel<Fields>;
export class Inherit extends TInheritBaseModel {}
`;
/** A model that chooses the sanity level; a project that is off cannot hold it. */
const LOOSE = `export type TLoose = IModel<Fields, { validation: 'sanity' }>;
export class Loose extends TLooseBaseModel {}
`;
/** A holder at the full level of a sanity model, and a holder at the sanity level of a model that follows its project. */
/** A model at false: it has no validators, and no call can check it. */
const OFF_MODEL = `export type TOff = IModel<Fields, { validation: false }>;
export class Off extends TOffBaseModel {}
`;
const HOLDERS = `export type TOuter = IModel<{ child: TLoose }>;
export type TLooseOuter = IModel<{ child: TInherit }, { validation: 'sanity' }>;
`;
const SOURCES: Record<'full' | 'sanity' | 'off', string> = {
  full: header(['Inherit', 'Loose', 'Off']) + LOOSE + OFF_MODEL + HOLDERS,
  sanity: header(['Inherit', 'Loose']) + LOOSE,
  off: header(['Inherit']),
};

const OK = { name: 'abc', qty: 1 };
const OVER_LIMIT = { name: 'abcd', qty: 1 };
const WRONG_TYPE = { name: 5, qty: 1 };
const SHAPE_ERRORS: Record<string, unknown> = { 'a wrong type': WRONG_TYPE, 'a missing key': { qty: 1 }, 'an extra key': { ...OK, other: 1 } };

async function load(t: TestContext, validation: Level, models: string) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sanity-calls-', name: 'sanity-calls' });
  writeModelSources(sourceRoot, { 'rules.ts': RULES, 'models.model.ts': models });
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  const rules = await import(pathToFileURL(path.join(root, 'build/rules.js')).href) as { calls: number; reset(): void };
  const classes = await import(pathToFileURL(path.join(root, 'build/models.model.js')).href) as Record<string, new (values: object) => object>;
  const codec = (name: string): ObjectCodec => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return { codec, rules, classes };
}
type Loaded = Awaited<ReturnType<typeof load>>;

/** The call each way of converting or checking a value makes, with the options of the call. */
const OPERATIONS: Record<string, (codec: ObjectCodec, value: unknown, options: SerdeOptions) => unknown> = {
  parse: (codec, value, options) => codec.parse(JSON.stringify(value), options),
  fromWireFormat: (codec, value, options) => codec.fromWireFormat(value, options),
  stringify: (codec, value, options) => codec.stringify(value as never, options),
  toWireFormat: (codec, value, options) => codec.toWireFormat(value as never, options),
};

type OverLimit = Record<CallName, Outcome>;
/** What each project level does with a value over a limit, by the `validate` option of the call. */
const OVER_LIMIT_BY_PROJECT: Record<'full' | 'sanity' | 'off', OverLimit> = {
  full: { omitted: 'rejects', true: 'rejects', sanity: 'accepts', false: 'accepts' },
  sanity: { omitted: 'accepts', true: 'unavailable', sanity: 'accepts', false: 'accepts' },
  off: { omitted: 'accepts', true: 'unavailable', sanity: 'unavailable', false: 'accepts' },
};
/** The same for the `validate` and `assert` of the codec, which take no `false`; a project that is off generates none. */
const CHECK_BY_PROJECT: Record<'full' | 'sanity' | 'off', Partial<OverLimit>> = {
  full: { omitted: 'rejects', true: 'rejects', sanity: 'accepts' },
  sanity: { omitted: 'accepts', true: 'unavailable', sanity: 'accepts' },
  off: { omitted: 'unavailable', true: 'unavailable', sanity: 'unavailable' },
};

/** Every operation of the codec on a value over a limit, at each call. */
function checkLevels(project: 'full' | 'sanity' | 'off', { codec }: Loaded): void {
  const inherit = codec('TInherit');
  for (const [operation, run] of Object.entries(OPERATIONS)) {
    for (const call of CALLS) {
      assert.equal(outcomeOf(() => run(inherit, OVER_LIMIT, CALL_OPTIONS[call])), OVER_LIMIT_BY_PROJECT[project][call], `${operation} validate ${call}`);
    }
  }
  for (const call of ['omitted', 'true', 'sanity'] as const) {
    const options = CALL_OPTIONS[call] as { validate?: true | 'sanity' };
    assert.equal(outcomeOf(() => inherit.validate(OVER_LIMIT, options)), CHECK_BY_PROJECT[project][call], `validate ${call}`);
    assert.equal(outcomeOf(() => inherit.assert(OVER_LIMIT, options)), CHECK_BY_PROJECT[project][call], `assert ${call}`);
  }
}

/** A call at the sanity level accepts a value over a limit and rejects a wrong type, a missing key and an extra key, and runs no validation function. */
function checkSanityShape(call: CallName, { codec, rules }: Loaded): void {
  const inherit = codec('TInherit');
  const options = CALL_OPTIONS[call];
  assert.equal(outcomeOf(() => inherit.parse(JSON.stringify(OVER_LIMIT), options)), 'accepts', 'a value over a limit');
  for (const [label, value] of Object.entries(SHAPE_ERRORS)) {
    assert.equal(outcomeOf(() => inherit.parse(JSON.stringify(value), options)), 'rejects', label);
  }
  rules.reset();
  inherit.parse(JSON.stringify({ ...OK, note: ' ' }), options);
  assert.equal(rules.calls, 0, 'a validation function does not run at sanity');
}

/** `validateInstance` and `ModelValidator.validate` of an instance over a limit, and of a valid instance with a failing instance rule. */
const REGISTRY_BY_PROJECT: Record<'full' | 'sanity', { readonly overLimit: Partial<OverLimit>; readonly instanceRule: Partial<OverLimit> }> = {
  full: { overLimit: { omitted: 'rejects', true: 'rejects', sanity: 'accepts' }, instanceRule: { omitted: 'rejects', true: 'rejects', sanity: 'accepts' } },
  sanity: { overLimit: { omitted: 'accepts', true: 'unavailable', sanity: 'accepts' }, instanceRule: { omitted: 'accepts', true: 'unavailable', sanity: 'accepts' } },
};

async function checkRegistry(project: 'full' | 'sanity', { classes }: Loaded): Promise<void> {
  const instances: Record<'over a limit' | 'instance rule', () => object> = {
    'over a limit': () => new classes.Inherit(OVER_LIMIT),
    'instance rule': () => {
      const instance = new classes.Inherit(OK);
      getValidator(instance).extend({ qty: () => 'the application says no' });
      return instance;
    },
  };
  const expected = { 'over a limit': REGISTRY_BY_PROJECT[project].overLimit, 'instance rule': REGISTRY_BY_PROJECT[project].instanceRule };
  for (const [what, make] of Object.entries(instances) as [keyof typeof instances, () => object][]) {
    for (const call of ['omitted', 'true', 'sanity'] as const) {
      const options = CALL_OPTIONS[call] as { validate?: true | 'sanity' };
      assert.equal(await outcomeOfAsync(() => validateInstance(make(), options)), expected[what][call], `validateInstance ${what}, validate ${call}`);
      assert.equal(await outcomeOfAsync(() => getValidator(make()).validate(options)), expected[what][call], `ModelValidator.validate ${what}, validate ${call}`);
    }
  }
}

test('a project at full: the level of each call, the default and each request; a sanity call; the registry path', async (t: TestContext) => {
  // protects: R-72 a call may lower the level, never raise it above the project's (T-664)
  const loaded = await load(t, true, SOURCES.full);
  await t.test('every operation at each call', () => checkLevels('full', loaded));
  await t.test('a sanity call checks the shape only', () => checkSanityShape('sanity', loaded));
  // protects: R-72 a caller bug is a TypeError, not a Validation error that could not finish
  for (const validate of ['full', 1, null, false]) {
    await t.test(`validateInstance and ModelValidator.validate throw a TypeError for validate ${String(validate)}`, async () => {
      await assert.rejects(validateInstance(new loaded.classes.Inherit(OK), { validate: validate as never }), TypeError);
      await assert.rejects(getValidator(new loaded.classes.Inherit(OK)).validate({ validate: validate as never }), TypeError);
    });
  }
  await t.test('validateInstance and ModelValidator.validate, with the instance rules', () => checkRegistry('full', loaded));
  const LOOSE_ROWS: Record<CallName, { readonly overLimit: Outcome; readonly wrongType: Outcome; readonly ruleRuns: number }> = {
    omitted: { overLimit: 'accepts', wrongType: 'rejects', ruleRuns: 0 },
    true: { overLimit: 'rejects', wrongType: 'rejects', ruleRuns: 1 },
    sanity: { overLimit: 'accepts', wrongType: 'rejects', ruleRuns: 0 },
    false: { overLimit: 'accepts', wrongType: 'accepts', ruleRuns: 0 },
  };
  // protects: R-76 a model's own level is only the default of its calls (moved from T-678)
  for (const call of CALLS) {
    for (const operation of Object.keys(OPERATIONS)) {
      await t.test(`a model that chooses sanity: ${operation} over a limit, validate ${call}`, () => {
        assert.equal(outcomeOf(() => OPERATIONS[operation](loaded.codec('TLoose'), OVER_LIMIT, CALL_OPTIONS[call])), LOOSE_ROWS[call].overLimit);
      });
    }
    await t.test(`a model that chooses sanity: a wrong type, validate ${call}`, () => {
      assert.equal(outcomeOf(() => loaded.codec('TLoose').parse(JSON.stringify(WRONG_TYPE), CALL_OPTIONS[call])), LOOSE_ROWS[call].wrongType);
    });
    await t.test(`a model that chooses sanity: the validation function runs ${LOOSE_ROWS[call].ruleRuns} times, validate ${call}`, () => {
      loaded.rules.reset();
      loaded.codec('TLoose').parse(JSON.stringify({ ...OK, note: 'x' }), CALL_OPTIONS[call]);
      assert.equal(loaded.rules.calls, LOOSE_ROWS[call].ruleRuns);
    });
  }
  await t.test('validate of a model that chooses sanity accepts a value over a limit by default and rejects it at full', () => {
    assert.equal(outcomeOf(() => loaded.codec('TLoose').validate(OVER_LIMIT)), 'accepts');
    assert.equal(outcomeOf(() => loaded.codec('TLoose').validate(OVER_LIMIT, { validate: true })), 'rejects');
  });
  // protects: R-76 a nested model follows the level of the call, not its own default
  const NESTED: readonly (readonly [holder: string, call: 'omitted' | 'true' | 'sanity', Outcome])[] = [
    ['TOuter', 'omitted', 'rejects'], ['TOuter', 'true', 'rejects'], ['TOuter', 'sanity', 'accepts'],
    ['TLooseOuter', 'omitted', 'accepts'], ['TLooseOuter', 'true', 'rejects'], ['TLooseOuter', 'sanity', 'accepts'],
  ];
  for (const [holder, call, expected] of NESTED) {
    for (const operation of Object.keys(OPERATIONS)) {
      await t.test(`a nested model: ${holder} ${operation}, validate ${call}`, () => {
        assert.equal(outcomeOf(() => OPERATIONS[operation](loaded.codec(holder), { child: OVER_LIMIT }, CALL_OPTIONS[call])), expected);
      });
    }
  }
  // protects: R-77 a model at false gets no validators, and a call that checks it throws ValidationUnavailable
  const OFF_ROWS: Record<CallName, Outcome> = { omitted: 'accepts', true: 'unavailable', sanity: 'unavailable', false: 'accepts' };
  for (const call of CALLS) {
    for (const operation of Object.keys(OPERATIONS)) {
      await t.test(`a model at false: ${operation}, validate ${call}`, () => {
        assert.equal(outcomeOf(() => OPERATIONS[operation](loaded.codec('TOff'), OVER_LIMIT, CALL_OPTIONS[call])), OFF_ROWS[call]);
      });
    }
  }
});

test('a project at sanity: the level of each call, the default and each request; the default checks the shape only; the registry path', async (t: TestContext) => {
  // protects: R-72 a call may lower the level, never raise it above the project's (T-664)
  const loaded = await load(t, 'sanity', SOURCES.sanity);
  await t.test('every operation at each call', () => checkLevels('sanity', loaded));
  await t.test('a call with no option checks the shape only', () => checkSanityShape('omitted', loaded));
  await t.test('validateInstance and ModelValidator.validate, with the instance rules', () => checkRegistry('sanity', loaded));
});

test('a project at off: every request above off is unavailable and off is allowed', async (t: TestContext) => {
  // protects: R-72 a call may lower the level, never raise it above the project's (T-664)
  checkLevels('off', await load(t, false, SOURCES.off));
});

const temporalScope = fileFixtureScope();
const TEMPORAL_WIRE = { at: '2025-01-02T03:04:05Z', zoned: '2025-01-02T03:04:05+01:00[Europe/Paris]', day: '2025-01-02', local: '2025-01-02T03:04:05', time: '03:04:05', span: 'P1D', when: '2025-01-02T03:04:05Z' };
/** A project with one model of every converted type, at a level; the model name differs by level, so each project registers its own codec. */
const loadTemporal = (level: 'sanity' | 'off') => temporalProjects[level] ??= (async () => {
  const name = level === 'sanity' ? 'TSanityEvent' : 'TOffEvent';
  const { root, sourceRoot } = createModelProject(temporalScope, {
    prefix: 'golem-converted-', name: 'converted', linkWorkspaceNodeModules: true,
    compilerOptions: { lib: ['ES2023', 'DOM', 'esnext.temporal'] },
  });
  writeModelSources(sourceRoot, {
    'event.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TemporalDuration, TemporalInstant, TemporalPlainDate, TemporalPlainDateTime, TemporalPlainTime, TemporalZonedDateTime } from '@exprtlabs/golem/temporal';
export type ${name} = IModel<{ at: TemporalInstant; zoned: TemporalZonedDateTime; day: TemporalPlainDate; local: TemporalPlainDateTime; time: TemporalPlainTime; span: TemporalDuration; when: Date }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: level === 'sanity' ? 'sanity' : false });
  await buildModelProject(root);
  await import(pathToFileURL(path.join(root, 'build/event.model.generated.js')).href);
  return requireObjectCodec(generatedCodecIdFromRoot(root, name));
})();
const temporalProjects: Partial<Record<'sanity' | 'off', Promise<ObjectCodec>>> = {};

// Each text is one that a parser reads and the wire form rejects, and the kind of error it gives at the sanity level: a
// format that sanity keeps (`date-time`) answers a Validation issue, and every other rule is the converter's.
const LENIENT_TEXT: readonly (readonly [field: string, text: string, sanityKind: LibErrorKind])[] = [
  ['at', '20250102T030405Z', LibErrorKind.Validation], ['at', '2025-01-02T03:04:05Z[UTC]', LibErrorKind.Validation],
  ['zoned', '2025-01-02T03:04:05[Europe/Paris]', LibErrorKind.Deserialization],
  ['day', '5', LibErrorKind.Deserialization], ['day', '20250102', LibErrorKind.Deserialization], ['day', '2025-01-02T10:00:00', LibErrorKind.Deserialization],
  ['local', '20250102T030405', LibErrorKind.Deserialization], ['local', '2025-01-02', LibErrorKind.Deserialization],
  ['time', '03:04:05+01:00', LibErrorKind.Deserialization],
  ['span', 'p1d', LibErrorKind.Deserialization],
  ['when', '5', LibErrorKind.Validation], ['when', '2025-01-02', LibErrorKind.Validation],
];
const LENIENT_ROWS = LENIENT_TEXT.flatMap(([field, text, sanityKind]) => [
  { level: 'sanity' as const, field, text, kind: sanityKind },
  { level: 'off' as const, field, text, kind: LibErrorKind.Deserialization },
]);
for (const { level, field, text, kind } of LENIENT_ROWS) {
  test(`a parse at ${level} rejects ${text} for ${field} as bad input of kind ${kind}, and does not coerce it`, async () => {
    // protects: F-39 golem rejects bad input and never coerces it, at every level of validation
    const codec = await loadTemporal(level);
    assert.throws(() => codec.parse(JSON.stringify({ ...TEMPORAL_WIRE, [field]: text })), { kind, causedByInput: true });
  });
}
for (const level of ['sanity', 'off'] as const) {
  test(`a parse at ${level} reads the canonical text of every converted type`, async () => {
    // protects: F-39 the strict form still reads what the wire form allows
    const codec = await loadTemporal(level);
    const model = codec.parse(JSON.stringify(TEMPORAL_WIRE)) as Record<string, unknown>;
    assert.deepEqual(Object.fromEntries(Object.entries(model).map(([field, value]) => [field, value instanceof Date ? value.toISOString() : String(value)])), {
      ...TEMPORAL_WIRE, when: '2025-01-02T03:04:05.000Z',
    });
  });
}

// Golem writes only what it reads: a value whose text falls outside the wire form is a Serialization error, not output that its own parse refuses.
/** The model of the canonical values, with one field replaced. */
const modelWith = (field: string, value: unknown): object => ({
  at: Temporal.Instant.from(TEMPORAL_WIRE.at), zoned: Temporal.ZonedDateTime.from(TEMPORAL_WIRE.zoned), day: Temporal.PlainDate.from(TEMPORAL_WIRE.day),
  local: Temporal.PlainDateTime.from(TEMPORAL_WIRE.local), time: Temporal.PlainTime.from(TEMPORAL_WIRE.time), span: Temporal.Duration.from(TEMPORAL_WIRE.span),
  when: new Date(TEMPORAL_WIRE.when), [field]: value,
});
const OUTSIDE_THE_FORM: readonly (readonly [field: string, value: () => unknown])[] = [
  ['at', () => Temporal.Instant.fromEpochMilliseconds(8.64e15)],
  ['day', () => Temporal.PlainDate.from('2025-01-02').withCalendar('gregory')],
  ['zoned', () => Temporal.ZonedDateTime.from('2025-01-02T03:04:05+01:00[Europe/Paris]').withCalendar('gregory')],
  ['local', () => Temporal.PlainDateTime.from('2025-01-02T03:04:05').withCalendar('gregory')],
];
const INSIDE_THE_FORM: readonly (readonly [field: string, text: string, value: () => unknown])[] = [
  ['at', '2025-01-02T03:04:05.123456789Z', () => Temporal.Instant.from('2025-01-02T03:04:05.123456789Z')],
  ['zoned', '2025-01-02T03:04:05+01:00[Europe/Paris]', () => Temporal.ZonedDateTime.from('2025-01-02T03:04:05+01:00[Europe/Paris]')],
  ['time', '03:04:05.5', () => Temporal.PlainTime.from('03:04:05.5')],
  ['span', 'PT0.5S', () => Temporal.Duration.from('PT0.5S')],
];
for (const level of ['sanity', 'off'] as const) {
  for (const [field, value] of OUTSIDE_THE_FORM) {
    test(`a stringify at ${level} of ${field} outside the wire form throws a Serialization error`, async () => {
      // protects: F-39 golem writes only the wire form that it reads
      const codec = await loadTemporal(level);
      assert.throws(() => codec.stringify(modelWith(field, value()) as never), { kind: LibErrorKind.Serialization, causedByInput: false });
    });
  }
  for (const [field, text, value] of INSIDE_THE_FORM) {
    test(`a stringify at ${level} of ${field} ${text} is read back by parse`, async () => {
      // protects: F-39 golem writes only the wire form that it reads
      const codec = await loadTemporal(level);
      const written = JSON.parse(codec.stringify(modelWith(field, value()) as never)) as Record<string, unknown>;
      assert.equal(written[field], text);
      assert.equal(String((codec.parse(JSON.stringify(written)) as Record<string, unknown>)[field]), text);
    });
  }
}
