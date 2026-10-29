import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { IssueRepresentation, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import type { ModelValidationContext } from '@exprtlabs/golem/model';
import { validateInstance, type Validator } from '@exprtlabs/golem/validation';
import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources } from './model-project.js';

const COUNTER = `export let calls = 0;
export function notBlank(value: string): boolean | string { calls++; return value.trim().length > 0 || 'blank'; }
export function reset(): void { calls = 0; }
export type Hex = string & import('@exprtlabs/golem/tags').Pattern<'^[0-9a-f]+$'>;
export function encodeHex(value: number): Hex { return value.toString(16); }
export function decodeHex(value: Hex): number { return parseInt(value, 16); }
`;

const ORDER = `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { Minimum, TSerde, TValidation } from '@exprtlabs/golem/tags';
import { decodeHex, encodeHex, notBlank } from './counter.js';
import { TOrderBaseModel, TRuleOnlyBaseModel } from './order.model.generated.js';
export type TFields = {
  note: string & TValidation<typeof notBlank>;
  code: number & Minimum<1> & TSerde<typeof encodeHex, typeof decodeHex>;
  when: Date;
  sku: string;
};
export type TOrder = IModel<TFields>;
export class Order extends TOrderBaseModel {}
export type TPlainOrder = IObject<TFields>;
export type TRuleOnly = IModel<{ note: string & TValidation<typeof notBlank>; sku: string }>;
export class RuleOnly extends TRuleOnlyBaseModel {}
`;

const good = { note: 'hi', code: 'ff', when: '2026-01-02T03:04:05.000Z', sku: 'A' };
const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;
const firstIssue = (error: unknown) => (error as LibError).issues[0];

async function project(t: TestContext, profile: { mobx: false; validation: true }) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-single-pass-', name: 'single-pass' });
  writeModelSources(sourceRoot, { 'counter.ts': COUNTER, 'order.model.ts': ORDER });
  writeModelGolemYaml(root, profile);
  await buildModelProject(root);
  const source = generatedModelFiles(root).map(a => a.content).join('\n');
  const counter = await import(pathToFileURL(path.join(root, 'build/counter.js')).href) as { calls: number; reset(): void };
  const models = await import(pathToFileURL(path.join(root, 'build/order.model.js')).href) as { Order: new (v?: object) => object; RuleOnly: new (v?: object) => object };
  return { source, counter, ...models, order: requireObjectCodec(generatedCodecIdFromRoot(root, 'TOrder')), plain: requireObjectCodec(generatedCodecIdFromRoot(root, 'TPlainOrder')), ruleOnly: requireObjectCodec(generatedCodecIdFromRoot(root, 'TRuleOnly')) };
}

test('each rule runs once per conversion; IObject parse enforces model-only rules', async t => {
  const { counter, Order, RuleOnly, order, plain, ruleOnly, source } = await project(t, { mobx: false, validation: true });
  const count = (run: () => unknown): number => { counter.reset(); run(); return counter.calls; };

  // The IObject bug: model-only rules after decoding.
  assert.throws(() => plain.parse(JSON.stringify({ ...good, note: '  ' })), validationError);
  assert.throws(() => plain.parse(JSON.stringify({ ...good, code: '0' })), validationError);

  for (const run of [
    () => plain.parse(JSON.stringify(good)),
    () => plain.fromWireFormat(good),
    () => order.parse(JSON.stringify(good), { construct: Order }),
    () => order.fromWireFormat(good, { construct: Order }),
  ]) assert.equal(count(run), 1);
  const model = order.parse(JSON.stringify(good), { construct: Order });
  assert.equal(count(() => order.stringify(model)), 1);
  assert.equal(count(() => order.toWireFormat(model)), 1);

  // Stringify checks the full model first.
  assert.throws(() => order.stringify({ ...(model as object), when: 'not a date' } as never),
    (e: unknown) => validationError(e) && firstIssue(e)?.representation === IssueRepresentation.Model);
  const bad = order.parse(JSON.stringify(good), { construct: Order }) as object;
  Reflect.set(bad, 'when', 'not a date');
  assert.throws(() => order.stringify(bad as never), (e: unknown) => validationError(e) && firstIssue(e)?.representation === IssueRepresentation.Model);

  // Wire violations are unchanged.
  assert.throws(() => plain.parse(JSON.stringify({ ...good, code: 'ZZ' })),
    (e: unknown) => validationError(e) && firstIssue(e)?.representation === IssueRepresentation.Wire);

  // A rule-only model: one check each way, no wire-only step.
  const rule = { note: 'hi', sku: 'A' };
  assert.equal(count(() => ruleOnly.parse(JSON.stringify(rule), { construct: RuleOnly })), 1);
  const ruleModel = ruleOnly.parse(JSON.stringify(rule), { construct: RuleOnly });
  assert.equal(count(() => ruleOnly.stringify(ruleModel)), 1);
  assert.match(source, /__golemAssertModelOnly_TRuleOnly/);
  assert.doesNotMatch(source, /__golemAssertWireOnly_RuleOnly/);
});

const MONEY_FIXTURE = 'models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-';

test('a rule on an SDK model runs once per parse and IObject enforces it', async t => {
  const profile = { mobx: false, validation: true } as const;
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-single-pass-sdk-', name: 'single-pass-sdk' });
  writeModelSources(root, { 'money.yaml': readFixture(`${MONEY_FIXTURE}/money.yaml`) });
  writeGeneratedArtifacts((await generateOpenApi({ input: path.join(root, 'money.yaml'), output: path.join(sourceRoot, 'sdk'), name: 'Payments', profile })).artifacts);
  writeModelSources(sourceRoot, { 'rules.ts': readFixture(`${MONEY_FIXTURE}/rules.ts`), 'checkout.model.ts': readFixture(`${MONEY_FIXTURE}/checkout.model.ts`) });
  writeModelGolemYaml(root, profile);
  await buildModelProject(root);
  const rules = await import(pathToFileURL(path.join(root, 'build/rules.js')).href) as { extraMoneyCalls: number };
  await import(pathToFileURL(path.join(root, 'build/checkout.model.js')).href);
  const wire = {
    money: { amount: 12, currency: 'USD' }, note: 'ok', code: 'ff', when: '2026-01-01T00:00:00.000Z', items: [{ sku: 'ABC' }],
    primary: { sku: 'ABC', quantity: 1, price: 2 }, flags: { rush: 'yes' }, channel: { kind: 'hold', until: '2026-01-03T00:00:00.000Z' },
    span: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'], hold: null, bag: { lane: 'A' },
  };
  const plain = requireObjectCodec(generatedCodecIdFromRoot(root, 'TJsonCheckout'));
  const before = rules.extraMoneyCalls;
  plain.parse(JSON.stringify(wire));
  assert.equal(rules.extraMoneyCalls - before, 1, 'extraMoney runs once per parse');
  assert.throws(() => plain.parse(JSON.stringify({ ...wire, money: { amount: 12, currency: 'XXX' } })), validationError);
});

/** The toggle models every project declares. A model never raises the level of its project, so only a project that validates declares the models in `VALIDATING_ONLY_MODELS`. */
const TOGGLE_MODELS = `type Fields = { note: string & TValidation<typeof notBlank>; when: Date };
export type TInherit = IModel<Fields>;
export class Inherit extends TInheritBaseModel {}
export type TOff = IModel<Fields, { validation: false }>;
export class Off extends TOffBaseModel {}
export type TChild = IObject<{ secret: string }, { validation: false }>;
export type TParent = IModel<{ child: TChild; note: string & TValidation<typeof notBlank>; when: Date }>;
export class Parent extends TParentBaseModel {}
`;
const VALIDATING_ONLY_MODELS = `export type TOn = IModel<Fields, { validation: true }>;
export class On extends TOnBaseModel {}
export type TVChild = IModel<{ note: string & TValidation<typeof notBlank>; when: Date }, { validation: true }>;
export class VChild extends TVChildBaseModel {}
export type TUParent = IModel<{ child: VChild; when: Date }, { validation: false }>;
export class UParent extends TUParentBaseModel {}
`;
const toggleSource = (generatedNames: string, models: string): string => `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { notBlank } from './counter.js';
import { ${generatedNames} } from './toggles.model.generated.js';
${models}`;
const TOGGLES_VALIDATING = toggleSource('TInheritBaseModel, TOffBaseModel, TParentBaseModel, TOnBaseModel, TVChildBaseModel, TUParentBaseModel', TOGGLE_MODELS + VALIDATING_ONLY_MODELS);
const TOGGLES_OFF = toggleSource('TInheritBaseModel, TOffBaseModel, TParentBaseModel', TOGGLE_MODELS);

type ToggleCall = 'omitted' | 'true' | 'false';
/** What one parse or stringify call of a model runs, by whether the model validates and by the `validate` option of the call. */
/** `runs`: the call returns and the rule ran `count` times; `unavailable`: the call throws validation unavailable. */
interface CallOutcome { readonly kind: 'runs' | 'unavailable'; readonly count: number }
const runs = (count: number): CallOutcome => ({ kind: 'runs', count });
const RULE_RUNS: Record<'validates' | 'off', Record<ToggleCall, CallOutcome>> = {
  validates: { omitted: runs(1), true: runs(1), false: runs(0) },
  off: { omitted: runs(0), true: { kind: 'unavailable', count: 0 }, false: runs(0) },
};
/** The `validate` option each way of making the call passes. */
const CALL_OPTIONS: Record<ToggleCall, { readonly validate?: boolean }> = { omitted: {}, true: { validate: true }, false: { validate: false } };
/** The toggle models a project declares: the effective level of each, and what its `codec.validate` does. */
const VALIDATING_ROWS = [['TInherit', 'validates', 'none'], ['TOn', 'validates', 'rejects'], ['TOff', 'off', 'unavailable']] as const;
const OFF_PROJECT_ROWS = [['TInherit', 'off', 'none'], ['TOff', 'off', 'unavailable']] as const;
const CALLS: readonly ToggleCall[] = ['omitted', 'true', 'false'];

async function loadToggles(t: TestContext, source: string, validation: boolean) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-single-pass-toggles-', name: 'single-pass-toggles' });
  writeModelSources(sourceRoot, { 'counter.ts': COUNTER, 'toggles.model.ts': source });
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  const counter = await import(pathToFileURL(path.join(root, 'build/counter.js')).href) as { calls: number; reset(): void };
  const models = await import(pathToFileURL(path.join(root, 'build/toggles.model.js')).href) as Record<string, new (v?: object) => object>;
  return { root, counter, models };
}

const TOGGLE_VALUE = { note: 'hi', when: '2026-01-02T03:04:05.000Z' };
const unavailable = (e: unknown): boolean => e instanceof LibError && e.kind === LibErrorKind.ValidationUnavailable;

for (const [projectValidates, source, rows] of [[true, TOGGLES_VALIDATING, VALIDATING_ROWS], [false, TOGGLES_OFF, OFF_PROJECT_ROWS]] as const) {
  test(`validation toggles behave as the spec states (profile validation ${projectValidates})`, async t => {
    const { root, counter, models } = await loadToggles(t, source, projectValidates);
    let cells = 0;
    for (const [name, effective, validateCheck] of rows) {
      const codec = requireObjectCodec(generatedCodecIdFromRoot(root, name));
      const construct = models[name.slice(1)];
      const model = codec.parse(JSON.stringify(TOGGLE_VALUE), { validate: false, construct });
      const validateChecks = {
        none: () => undefined,
        unavailable: () => assert.throws(() => codec.validate(model), unavailable, `${name} codec.validate`),
        rejects: () => assert.equal(codec.validate({ note: 'hi', when: 'not a date' } as never), false, `${name} codec.validate rejects a bad value`),
      };
      validateChecks[validateCheck]();
      for (const call of CALLS) {
        const options = { ...CALL_OPTIONS[call], construct };
        const expected = RULE_RUNS[effective][call];
        for (const [operation, run] of [
          ['parse', () => codec.parse(JSON.stringify(TOGGLE_VALUE), options)],
          ['stringify', () => codec.stringify(model as never, CALL_OPTIONS[call])],
        ] as const) {
          counter.reset();
          const label = `${name} ${operation} validate=${call}`;
          const outcomes = {
            unavailable: () => assert.throws(run, unavailable, label),
            runs: () => { run(); assert.equal(counter.calls, expected.count, label); },
          };
          outcomes[expected.kind]();
          cells++;
        }
      }
    }
    assert.equal(cells, rows.length * CALLS.length * 2);
  });
}

test('toggled models in a validating project: an opaque child, an unvalidated parent and a validated child', async t => {
  const { root, counter, models } = await loadToggles(t, TOGGLES_VALIDATING, true);
  const value = TOGGLE_VALUE;
  // An opaque child inside a validated parent: parent rules run once, child contents unchecked.
  counter.reset();
  requireObjectCodec(generatedCodecIdFromRoot(root, 'TParent')).parse(JSON.stringify({ child: { secret: 7 }, ...value }), { construct: models.Parent });
  assert.equal(counter.calls, 1);
  const parentCodec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TParent'));
  const blank = new models.Parent({ child: { secret: 'x' }, note: '  ', when: new Date(value.when) });
  assert.equal(parentCodec.validate(blank), false, 'a blank parent note is rejected');
  assert.ok((await validateInstance(blank)).some(issue => issue.path[0] === 'note'));
  // A validated child inside an unvalidated parent: the codec you call decides.
  counter.reset();
  requireObjectCodec(generatedCodecIdFromRoot(root, 'TUParent')).parse(JSON.stringify({ child: value, when: value.when }), { construct: models.UParent });
  assert.equal(counter.calls, 0, 'converting the unvalidated parent runs no checks');
  requireObjectCodec(generatedCodecIdFromRoot(root, 'TVChild')).parse(JSON.stringify(value), { construct: models.VChild });
  assert.equal(counter.calls, 1, 'converting the validated child directly validates it');
});

test('rules inside constraints the wire drops (Contains, Not) still run once on parse', async t => {
  const profile = { mobx: false, validation: true } as const;
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-single-pass-constraints-', name: 'single-pass-constraints' });
  writeModelSources(sourceRoot, {
    'predicates.ts': readFixture('models/constraint-callback-composition/constraint-callback-composition-predicates/predicates.ts'),
    'a.model.ts': readFixture('models/constraint-callback-composition/nested-value-callbacks/a.model.ts'),
  });
  writeModelGolemYaml(root, profile);
  await buildModelProject(root);
  const predicates = await import(pathToFileURL(path.join(root, 'build/predicates.js')).href) as { positiveCalls: number; reset(): void };
  const { A } = await import(pathToFileURL(path.join(root, 'build/a.model.js')).href) as { A: new (v?: object) => object };
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TA'));
  for (const options of [{ construct: A }, {}]) {
    assert.throws(() => codec.parse(JSON.stringify({ values: [-1] }), options), validationError, 'no positive element for Contains');
    assert.throws(() => codec.parse(JSON.stringify({ blocked: 5 }), options), validationError, 'Not<positive> rejects a positive number');
    predicates.reset();
    codec.parse(JSON.stringify({ values: [3] }), options);
    assert.equal(predicates.positiveCalls, 1, 'the Contains rule runs once per parse');
  }
});

test('a context of the generated validators validates parse and stringify, nested residual references included', async t => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-single-pass-context-', name: 'single-pass-context' });
  writeModelSources(sourceRoot, { 'visit.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TStopBaseModel, TTripBaseModel } from './visit.model.generated.js';
export type TStop = IModel<{ at: Date; name: string }>;
export class Stop extends TStopBaseModel {}
export type TTrip = IModel<{ at: Date; stop: Stop }>;
export class Trip extends TTripBaseModel {}
` });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const { Trip } = await import(pathToFileURL(path.join(root, 'build/visit.model.js')).href) as { Trip: new (v?: object) => object };
  const validatorsFile = generatedModelFiles(root).find(item => item.path.endsWith('/models.validators.generated.ts'));
  assert.ok(validatorsFile);
  const validators = await import(pathToFileURL(path.join(root, 'build', path.relative(sourceRoot, validatorsFile.path).replace(/\.ts$/, '.js'))).href) as Readonly<Record<string, Validator>>;
  const requested: string[] = [];
  const context: ModelValidationContext = { resolve: (reference) => { requested.push(reference); return validators[`validate_${reference.replace(/[^A-Za-z0-9_$]/g, '_')}`]; } };
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TTrip'));
  const good = { at: '2026-01-02T03:04:05.000Z', stop: { at: '2026-01-03T00:00:00.000Z', name: 'A' } };
  const trip = codec.parse(JSON.stringify(good), { construct: Trip, validationContext: context });
  assert.equal(codec.stringify(trip as never, { validationContext: context }), JSON.stringify(good));
  assert.ok(requested.some(reference => reference.startsWith('TTrip') && reference.endsWith('#model-only')), 'parse checks the decoded value through the context');
  assert.throws(() => codec.parse(JSON.stringify({ ...good, stop: { ...good.stop, at: 'nope' } }), { construct: Trip, validationContext: context }), validationError);
  const bad = codec.parse(JSON.stringify(good), { construct: Trip }) as { stop: object };
  Reflect.set(bad.stop, 'at', 'not a date');
  assert.throws(() => codec.stringify(bad as never, { validationContext: context }), validationError);
});
