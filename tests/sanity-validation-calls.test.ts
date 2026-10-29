import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec, serdeValidates } from '@exprtlabs/golem/internal/model-runtime';
import type { ObjectCodec, SerdeOptions } from '@exprtlabs/golem/serde';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
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

test('the call rule: no option gives the default, off is always allowed, a level above the cap is unavailable, any other value is a TypeError', () => {
  // protects: R-72 a call may lower the level, never raise it above the project's
  for (const [defaultLevel, cap, expected] of CALL_RULE) {
    for (const call of CALLS) {
      assert.equal(levelOf(CALL_OPTIONS[call], defaultLevel, cap), expected[call], `default ${String(defaultLevel)} cap ${String(cap)} validate ${call}`);
    }
    for (const value of NOT_A_LEVEL) {
      assert.equal(levelOf({ validate: value as never }, defaultLevel, cap), 'TypeError', `default ${String(defaultLevel)} validate ${String(value)}`);
    }
  }
});

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
const HOLDERS = `export type TOuter = IModel<{ child: TLoose }>;
export type TLooseOuter = IModel<{ child: TInherit }, { validation: 'sanity' }>;
`;
const SOURCES: Record<'full' | 'sanity' | 'off', string> = {
  full: header(['Inherit', 'Loose']) + LOOSE + HOLDERS,
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
  await t.test('validateInstance and ModelValidator.validate, with the instance rules', () => checkRegistry('full', loaded));
  await t.test('a model that chooses sanity runs at sanity by default, at full when a call asks, and off when a call turns it off', () => {
    // protects: R-76 a model's own level is only the default of its calls (moved from T-678)
    const { codec, rules } = loaded;
    const loose = codec('TLoose');
    const rows: Record<CallName, { readonly overLimit: Outcome; readonly wrongType: Outcome; readonly ruleRuns: number }> = {
      omitted: { overLimit: 'accepts', wrongType: 'rejects', ruleRuns: 0 },
      true: { overLimit: 'rejects', wrongType: 'rejects', ruleRuns: 1 },
      sanity: { overLimit: 'accepts', wrongType: 'rejects', ruleRuns: 0 },
      false: { overLimit: 'accepts', wrongType: 'accepts', ruleRuns: 0 },
    };
    for (const call of CALLS) {
      const options = CALL_OPTIONS[call];
      for (const [operation, run] of Object.entries(OPERATIONS)) {
        assert.equal(outcomeOf(() => run(loose, OVER_LIMIT, options)), rows[call].overLimit, `${operation} over limit, validate ${call}`);
      }
      assert.equal(outcomeOf(() => loose.parse(JSON.stringify(WRONG_TYPE), options)), rows[call].wrongType, `wrong type, validate ${call}`);
      rules.reset();
      loose.parse(JSON.stringify({ ...OK, note: 'x' }), options);
      assert.equal(rules.calls, rows[call].ruleRuns, `rule runs, validate ${call}`);
    }
    assert.equal(outcomeOf(() => loose.validate(OVER_LIMIT)), 'accepts');
    assert.equal(outcomeOf(() => loose.validate(OVER_LIMIT, { validate: true })), 'rejects');
  });
  await t.test('a nested model is checked at the level of the call that reaches it', () => {
    // protects: R-76 a nested model follows the level of the call, not its own default
    const rows: readonly (readonly [holder: string, Record<'omitted' | 'true' | 'sanity', Outcome>])[] = [
      ['TOuter', { omitted: 'rejects', true: 'rejects', sanity: 'accepts' }],
      ['TLooseOuter', { omitted: 'accepts', true: 'rejects', sanity: 'accepts' }],
    ];
    for (const [holder, expected] of rows) {
      for (const call of ['omitted', 'true', 'sanity'] as const) {
        for (const [operation, run] of Object.entries(OPERATIONS)) {
          assert.equal(outcomeOf(() => run(loaded.codec(holder), { child: OVER_LIMIT }, CALL_OPTIONS[call])), expected[call], `${holder} ${operation} validate ${call}`);
        }
      }
    }
  });
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
