import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec, serdeValidates } from '@exprtlabs/golem/internal/model-runtime';
import type { ObjectCodec, SerdeOptions } from '@exprtlabs/golem/serde';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

type Outcome = 'accepts' | 'rejects' | 'unavailable';
type CallName = 'omitted' | 'true' | 'sanity' | 'false';
type ProjectLevel = true | 'sanity' | false;

/** What a call came to: it returned (a `false` answer of `validate` is a rejection), it failed the check, or its level does not exist. */
function outcomeOf(run: () => unknown): Outcome {
  try {
    return run() === false ? 'rejects' : 'accepts';
  } catch (error) {
    if (!(error instanceof LibError)) throw error;
    if (error.kind === LibErrorKind.ValidationUnavailable) return 'unavailable';
    if (error.kind === LibErrorKind.Validation) return 'rejects';
    throw error;
  }
}

const CALL_OPTIONS: Record<CallName, SerdeOptions> = { omitted: {}, true: { validate: true }, sanity: { validate: 'sanity' }, false: { validate: false } };

test('the call rule: no option gives the default, off is always allowed, a level above the cap is unavailable', () => {
  // protects: R-72 a call may lower the level, never raise it above the project's
  const rows: readonly (readonly [defaultLevel: ProjectLevel, cap: ProjectLevel, Record<CallName, ProjectLevel | 'unavailable'>])[] = [
    [true, true, { omitted: true, true: true, sanity: 'sanity', false: false }],
    ['sanity', true, { omitted: 'sanity', true: true, sanity: 'sanity', false: false }],
    ['sanity', 'sanity', { omitted: 'sanity', true: 'unavailable', sanity: 'sanity', false: false }],
    [false, false, { omitted: false, true: 'unavailable', sanity: 'unavailable', false: false }],
  ];
  for (const [defaultLevel, cap, expected] of rows) {
    for (const call of Object.keys(CALL_OPTIONS) as CallName[]) {
      const level = (): ProjectLevel => serdeValidates(CALL_OPTIONS[call], defaultLevel, cap);
      const label = `default ${String(defaultLevel)} cap ${String(cap)} validate ${call}`;
      if (expected[call] === 'unavailable') assert.throws(level, error => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable, label);
      else assert.equal(level(), expected[call], label);
    }
  }
});

const RULES = `export let calls = 0;
export function notBlank(value: string): boolean | string { calls++; return value.trim().length > 0 || 'blank'; }
export function reset(): void { calls = 0; }
`;
const MODELS = `import type { IModel } from '@exprtlabs/golem/model';
import type { MaxLength, TValidation } from '@exprtlabs/golem/tags';
import { notBlank } from './rules.js';
type Fields = { name: string & MaxLength<3>; qty: number; note?: string & TValidation<typeof notBlank> };
export type TInherit = IModel<Fields>;
`;
/** A model that chooses the sanity level, with a holder at the full level and a holder at the sanity level; only a project above sanity holds them. */
const SANITY_MODELS = `export type TLoose = IModel<Fields, { validation: 'sanity' }>;
`;
const HOLDERS = `export type TOuter = IModel<{ child: TLoose }>;
export type TLooseOuter = IModel<{ child: TInherit }, { validation: 'sanity' }>;
`;

const OK = { name: 'abc', qty: 1 };
const OVER_LIMIT = { name: 'abcd', qty: 1 };
const SHAPE_ERRORS: Record<string, unknown> = { 'a wrong type': { name: 5, qty: 1 }, 'a missing key': { qty: 1 }, 'an extra key': { ...OK, other: 1 } };

async function load(t: TestContext, validation: ProjectLevel, models: string) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sanity-calls-', name: 'sanity-calls' });
  writeModelSources(sourceRoot, { 'rules.ts': RULES, 'models.model.ts': models });
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  const rules = await import(pathToFileURL(path.join(root, 'build/rules.js')).href) as { calls: number; reset(): void };
  await import(pathToFileURL(path.join(root, 'build/models.model.generated.js')).href);
  const codec = (name: string): ObjectCodec => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return { codec, rules };
}

/** The call each way of converting or checking a value makes, with the options of the call. */
const OPERATIONS: Record<string, (codec: ObjectCodec, value: unknown, options: SerdeOptions) => unknown> = {
  parse: (codec, value, options) => codec.parse(JSON.stringify(value), options),
  fromWireFormat: (codec, value, options) => codec.fromWireFormat(value, options),
  stringify: (codec, value, options) => codec.stringify(value as never, options),
  toWireFormat: (codec, value, options) => codec.toWireFormat(value as never, options),
};

/** What each project level does with a value over a limit, by the `validate` option of the call. */
const OVER_LIMIT_BY_PROJECT: readonly (readonly [ProjectLevel, Record<CallName, Outcome>])[] = [
  [true, { omitted: 'rejects', true: 'rejects', sanity: 'accepts', false: 'accepts' }],
  ['sanity', { omitted: 'accepts', true: 'unavailable', sanity: 'accepts', false: 'accepts' }],
  [false, { omitted: 'accepts', true: 'unavailable', sanity: 'unavailable', false: 'accepts' }],
];
/** What `validate` of the codec does with the same value; a project that is off generates no `validate`. */
const VALIDATE_BY_PROJECT: readonly (readonly [ProjectLevel, Partial<Record<CallName, Outcome>>])[] = [
  [true, { omitted: 'rejects', true: 'rejects', sanity: 'accepts' }],
  ['sanity', { omitted: 'accepts', true: 'unavailable', sanity: 'accepts' }],
  [false, { omitted: 'unavailable', true: 'unavailable', sanity: 'unavailable' }],
];

for (const [project, expected] of OVER_LIMIT_BY_PROJECT) {
  test(`a project at ${String(project)}: the level of each call, the default and each request`, async (t: TestContext) => {
    // protects: R-72 a call may lower the level, never raise it above the project's (T-664)
    const { codec } = await load(t, project, MODELS);
    const inherit = codec('TInherit');
    for (const [operation, run] of Object.entries(OPERATIONS)) {
      for (const call of Object.keys(CALL_OPTIONS) as CallName[]) {
        assert.equal(outcomeOf(() => run(inherit, OVER_LIMIT, CALL_OPTIONS[call])), expected[call], `${operation} validate ${call}`);
      }
    }
    const validateExpected = VALIDATE_BY_PROJECT.find(([level]) => level === project)?.[1] ?? {};
    for (const call of ['omitted', 'true', 'sanity'] as const) {
      const options = CALL_OPTIONS[call] as { validate?: true | 'sanity' };
      assert.equal(outcomeOf(() => inherit.validate(OVER_LIMIT, options)), validateExpected[call], `validate ${call}`);
      assert.equal(outcomeOf(() => inherit.assert(OVER_LIMIT, options)), validateExpected[call], `assert ${call}`);
    }
  });
}

for (const [project, call] of [[true, 'sanity'], ['sanity', 'omitted']] as const) {
  test(`a sanity call (project ${String(project)}, validate ${call}) accepts a value over a limit and rejects a wrong type, a missing key and an extra key`, async (t: TestContext) => {
    // protects: R-71 the sanity level checks the shape and skips value limits and validation functions
    const { codec, rules } = await load(t, project, MODELS);
    const inherit = codec('TInherit');
    const options = CALL_OPTIONS[call];
    assert.equal(outcomeOf(() => inherit.parse(JSON.stringify(OVER_LIMIT), options)), 'accepts', 'a value over a limit');
    for (const [label, value] of Object.entries(SHAPE_ERRORS)) {
      assert.equal(outcomeOf(() => inherit.parse(JSON.stringify(value), options)), 'rejects', label);
    }
    rules.reset();
    inherit.parse(JSON.stringify({ ...OK, note: ' ' }), options);
    assert.equal(rules.calls, 0, 'a validation function does not run at sanity');
  });
}

test('a model that chooses sanity in a full project runs at sanity by default, at full when a call asks, and off when a call turns it off', async (t: TestContext) => {
  // protects: R-76 a model's own level is only the default of its calls (moved from T-678)
  const { codec, rules } = await load(t, true, MODELS + SANITY_MODELS);
  const loose = codec('TLoose');
  const rows: Record<CallName, { readonly overLimit: Outcome; readonly wrongType: Outcome; readonly ruleRuns: number }> = {
    omitted: { overLimit: 'accepts', wrongType: 'rejects', ruleRuns: 0 },
    true: { overLimit: 'rejects', wrongType: 'rejects', ruleRuns: 1 },
    sanity: { overLimit: 'accepts', wrongType: 'rejects', ruleRuns: 0 },
    false: { overLimit: 'accepts', wrongType: 'accepts', ruleRuns: 0 },
  };
  for (const call of Object.keys(rows) as CallName[]) {
    const options = CALL_OPTIONS[call];
    assert.equal(outcomeOf(() => loose.parse(JSON.stringify(OVER_LIMIT), options)), rows[call].overLimit, `over limit, validate ${call}`);
    assert.equal(outcomeOf(() => loose.parse(JSON.stringify(SHAPE_ERRORS['a wrong type']), options)), rows[call].wrongType, `wrong type, validate ${call}`);
    rules.reset();
    loose.parse(JSON.stringify({ ...OK, note: 'x' }), options);
    assert.equal(rules.calls, rows[call].ruleRuns, `rule runs, validate ${call}`);
  }
  assert.equal(outcomeOf(() => loose.validate(OVER_LIMIT)), 'accepts');
  assert.equal(outcomeOf(() => loose.validate(OVER_LIMIT, { validate: true })), 'rejects');
});

test('a nested model is checked at the level of the call that reaches it', async (t: TestContext) => {
  // protects: R-76 a nested model follows the level of the call, not its own default
  const { codec } = await load(t, true, MODELS + SANITY_MODELS + HOLDERS);
  const rows: readonly (readonly [holder: string, Record<'omitted' | 'true' | 'sanity', Outcome>])[] = [
    ['TOuter', { omitted: 'rejects', true: 'rejects', sanity: 'accepts' }],
    ['TLooseOuter', { omitted: 'accepts', true: 'rejects', sanity: 'accepts' }],
  ];
  for (const [holder, expected] of rows) {
    for (const call of ['omitted', 'true', 'sanity'] as const) {
      const options = CALL_OPTIONS[call];
      assert.equal(outcomeOf(() => codec(holder).parse(JSON.stringify({ child: OVER_LIMIT }), options)), expected[call], `${holder} validate ${call}`);
    }
  }
});
