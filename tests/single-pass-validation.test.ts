import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { IssueRepresentation, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { generate } from '#model/generator';
import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { compileModelProject, createModelProject, writeModelSources } from './model-project.js';

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
import { OrderBase, RuleOnlyBase } from './order.model.generated.js';
export type TFields = {
  note: string & TValidation<typeof notBlank>;
  code: number & Minimum<1> & TSerde<typeof encodeHex, typeof decodeHex>;
  when: Date;
  sku: string;
};
export type TOrder = IModel<TFields>;
export class Order extends OrderBase {}
export type TPlainOrder = IObject<TFields>;
export type TRuleOnly = IModel<{ note: string & TValidation<typeof notBlank>; sku: string }>;
export class RuleOnly extends RuleOnlyBase {}
`;

const good = { note: 'hi', code: 'ff', when: '2026-01-02T03:04:05.000Z', sku: 'A' };
const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;
const firstIssue = (error: unknown) => (error as LibError).issues[0];

async function project(t: TestContext, profile: { mobx: false; validation: true; ajvStandalone?: boolean }) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'runic-single-pass-', name: 'single-pass', allowJs: profile.ajvStandalone === true });
  writeModelSources(sourceRoot, { 'counter.ts': COUNTER, 'order.model.ts': ORDER });
  const result = generate({ root, profile });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  const source = result.artifacts.map(a => a.content).join('\n');
  const counter = await import(pathToFileURL(path.join(root, 'build/counter.js')).href) as { calls: number; reset(): void };
  const models = await import(pathToFileURL(path.join(root, 'build/order.model.js')).href) as { Order: new (v?: object) => object; RuleOnly: new (v?: object) => object };
  return { source, counter, ...models, order: requireObjectCodec('Order'), plain: requireObjectCodec('PlainOrder'), ruleOnly: requireObjectCodec('RuleOnly') };
}

for (const [label, profile] of [['runtime Ajv', { mobx: false, validation: true }], ['standalone', { mobx: false, validation: true, ajvStandalone: true }]] as const) {
  test(`each rule runs once per conversion; IObject parse enforces model-only rules (${label})`, async t => {
    const { counter, Order, RuleOnly, order, plain, ruleOnly, source } = await project(t, profile);
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
    assert.match(source, /__runicAssertModelOnly_RuleOnly/);
    assert.doesNotMatch(source, /__runicAssertWireOnly_RuleOnly/);
  });
}

const MONEY_FIXTURE = 'models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-';

test('a rule on an SDK model runs once per parse and IObject enforces it (standalone)', async t => {
  const profile = { mobx: false, validation: true, ajvStandalone: true } as const;
  const { root, sourceRoot } = createModelProject(t, { prefix: 'runic-single-pass-sdk-', name: 'single-pass-sdk', allowJs: true });
  writeModelSources(root, { 'money.yaml': readFixture(`${MONEY_FIXTURE}/money.yaml`) });
  writeGeneratedArtifacts((await generateOpenApi({ input: path.join(root, 'money.yaml'), output: path.join(sourceRoot, 'sdk'), name: 'Payments', profile })).artifacts);
  writeModelSources(sourceRoot, { 'rules.ts': readFixture(`${MONEY_FIXTURE}/rules.ts`), 'checkout.model.ts': readFixture(`${MONEY_FIXTURE}/checkout.model.ts`) });
  writeGeneratedArtifacts(generate({ root, profile, manifestInputs: [path.join(sourceRoot, 'sdk/model-manifest.json')] }).artifacts);
  await compileModelProject(root);
  const rules = await import(pathToFileURL(path.join(root, 'build/rules.js')).href) as { extraMoneyCalls: number };
  await import(pathToFileURL(path.join(root, 'build/checkout.model.js')).href);
  const wire = {
    money: { amount: 12, currency: 'USD' }, note: 'ok', code: 'ff', when: '2026-01-01T00:00:00.000Z', items: [{ sku: 'ABC' }],
    primary: { sku: 'ABC', quantity: 1, price: 2 }, flags: { rush: 'yes' }, channel: { kind: 'hold', until: '2026-01-03T00:00:00.000Z' },
    span: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'], hold: null, bag: { lane: 'A' },
  };
  const plain = requireObjectCodec('JsonCheckout');
  const before = rules.extraMoneyCalls;
  plain.parse(JSON.stringify(wire));
  assert.equal(rules.extraMoneyCalls - before, 1, 'extraMoney runs once per parse');
  assert.throws(() => plain.parse(JSON.stringify({ ...wire, money: { amount: 12, currency: 'XXX' } })), validationError);
});

const TOGGLES = `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { notBlank } from './counter.js';
import { InheritBase, OnBase, OffBase, ParentBase, VChildBase, UParentBase } from './toggles.model.generated.js';
type Fields = { note: string & TValidation<typeof notBlank>; when: Date };
export type TInherit = IModel<Fields>;
export class Inherit extends InheritBase {}
export type TOn = IModel<Fields, { validation: true }>;
export class On extends OnBase {}
export type TOff = IModel<Fields, { validation: false }>;
export class Off extends OffBase {}
export type TChild = IObject<{ secret: string }, { validation: false }>;
export type TParent = IModel<{ child: TChild; note: string & TValidation<typeof notBlank>; when: Date }>;
export class Parent extends ParentBase {}
export type TVChild = IModel<{ note: string & TValidation<typeof notBlank>; when: Date }, { validation: true }>;
export class VChild extends VChildBase {}
export type TUParent = IModel<{ child: VChild; when: Date }, { validation: false }>;
export class UParent extends UParentBase {}
`;

for (const profileValidation of [true, false]) {
  test(`validation toggles behave as the spec states (profile validation ${profileValidation})`, async t => {
    const { root, sourceRoot } = createModelProject(t, { prefix: 'runic-single-pass-toggles-', name: 'single-pass-toggles' });
    writeModelSources(sourceRoot, { 'counter.ts': COUNTER, 'toggles.model.ts': TOGGLES });
    const result = generate({ root, profile: { mobx: false, validation: profileValidation } });
    writeGeneratedArtifacts(result.artifacts);
    await compileModelProject(root);
    const counter = await import(pathToFileURL(path.join(root, 'build/counter.js')).href) as { calls: number; reset(): void };
    const models = await import(pathToFileURL(path.join(root, 'build/toggles.model.js')).href) as Record<string, new (v?: object) => object>;
    const value = { note: 'hi', when: '2026-01-02T03:04:05.000Z' };
    const unavailable = (e: unknown): boolean => e instanceof LibError && e.kind === LibErrorKind.ValidationUnavailable;
    let cells = 0;
    for (const [name, declaration] of [['Inherit', 'inherit'], ['On', 'on'], ['Off', 'off']] as const) {
      const codec = requireObjectCodec(name);
      const construct = models[name];
      const effective = declaration === 'on' || (declaration === 'inherit' && profileValidation);
      const model = codec.parse(JSON.stringify(value), { validate: false, construct });
      if (declaration === 'off') assert.throws(() => codec.validate(model), unavailable, `${name} codec.validate`);
      if (declaration === 'on') assert.equal(codec.validate({ note: 'hi', when: 'not a date' } as never), false, `${name} codec.validate rejects a bad value`);
      for (const call of ['omitted', 'true', 'false'] as const) {
        const options = call === 'omitted' ? { construct } : { validate: call === 'true', construct };
        const expected = call === 'false' ? 0 : !effective ? (call === 'true' ? 'unavailable' : 0) : 1;
        for (const [operation, run] of [
          ['parse', () => codec.parse(JSON.stringify(value), options)],
          ['stringify', () => codec.stringify(model as never, call === 'omitted' ? undefined : { validate: call === 'true' })],
        ] as const) {
          counter.reset();
          const label = `${name} ${operation} validate=${call}`;
          if (expected === 'unavailable') assert.throws(run, unavailable, label);
          else { run(); assert.equal(counter.calls, expected, label); }
          cells++;
        }
      }
    }
    assert.equal(cells, 18);

    if (profileValidation) {
      // An opaque child inside a validated parent: parent rules run once, child contents unchecked.
      counter.reset();
      requireObjectCodec('Parent').parse(JSON.stringify({ child: { secret: 7 }, ...value }), { construct: models.Parent });
      assert.equal(counter.calls, 1);
      const parentCodec = requireObjectCodec('Parent');
      const blank = new models.Parent({ child: { secret: 'x' }, note: '  ', when: new Date(value.when) });
      assert.equal(parentCodec.validate(blank), false, 'a blank parent note is rejected');
      assert.ok((await validateInstance(blank)).some(issue => issue.path[0] === 'note'));
      const source = result.artifacts.map(a => a.content).join('\n');
      const parentModelOnly = source.split('\n').find(line => line.includes('const __resolvedModelOnlySchema_Parent')) ?? '';
      assert.ok(parentModelOnly.length > 0 && !parentModelOnly.includes('Child'), 'the parent residual does not reference the opaque child');
    } else {
      // A validated child inside an unvalidated parent: the codec you call decides.
      counter.reset();
      requireObjectCodec('UParent').parse(JSON.stringify({ child: value, when: value.when }), { construct: models.UParent });
      assert.equal(counter.calls, 0, 'converting the unvalidated parent runs no checks');
      requireObjectCodec('VChild').parse(JSON.stringify(value), { construct: models.VChild });
      assert.equal(counter.calls, 1, 'converting the validated child directly validates it');
    }
  });
}

for (const [label, profile] of [['runtime Ajv', { mobx: false, validation: true }], ['standalone', { mobx: false, validation: true, ajvStandalone: true }]] as const) {
  test(`rules inside constraints the wire drops (Contains, Not) still run once on parse (${label})`, async t => {
    const { root, sourceRoot } = createModelProject(t, { prefix: 'runic-single-pass-constraints-', name: 'single-pass-constraints', allowJs: true });
    writeModelSources(sourceRoot, {
      'predicates.ts': readFixture('models/constraint-callback-composition/constraint-callback-composition-predicates/predicates.ts'),
      'a.model.ts': readFixture('models/constraint-callback-composition/nested-value-callbacks/a.model.ts'),
    });
    writeGeneratedArtifacts(generate({ root, profile }).artifacts);
    await compileModelProject(root);
    const predicates = await import(pathToFileURL(path.join(root, 'build/predicates.js')).href) as { positiveCalls: number; reset(): void };
    const { A } = await import(pathToFileURL(path.join(root, 'build/a.model.js')).href) as { A: new (v?: object) => object };
    const codec = requireObjectCodec('A');
    for (const options of [{ construct: A }, {}]) {
      assert.throws(() => codec.parse(JSON.stringify({ values: [-1] }), options), validationError, 'no positive element for Contains');
      assert.throws(() => codec.parse(JSON.stringify({ blocked: 5 }), options), validationError, 'Not<positive> rejects a positive number');
      predicates.reset();
      codec.parse(JSON.stringify({ values: [3] }), options);
      assert.equal(predicates.positiveCalls, 1, 'the Contains rule runs once per parse');
    }
  });
}

test('an engine filled by registerCodecSchemas validates parse and stringify through a context, nested residual refs included', async t => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'runic-single-pass-engine-', name: 'single-pass-engine' });
  writeModelSources(sourceRoot, { 'visit.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { StopBase, TripBase } from './visit.model.generated.js';
export type TStop = IModel<{ at: Date; name: string }>;
export class Stop extends StopBase {}
export type TTrip = IModel<{ at: Date; stop: Stop }>;
export class Trip extends TripBase {}
` });
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Trip } = await import(pathToFileURL(path.join(root, 'build/visit.model.js')).href) as { Trip: new (v?: object) => object };
  const { createOpenApiSyncAjvEngine } = await import('@exprtlabs/golem/ajv');
  const { registerCodecSchemas } = await import('@exprtlabs/golem/serde');
  const engine = createOpenApiSyncAjvEngine({ allErrors: false, validationBindings: {} });
  const registered: string[] = [];
  registerCodecSchemas((schema, id) => { registered.push(id); engine.addSchema(schema, id); }, 'Trip');
  assert.ok(registered.some(id => id.startsWith('Stop') && id.endsWith('#model-only')), 'the nested codec residual schema is registered');
  const context = { engine };
  const codec = requireObjectCodec('Trip');
  const good = { at: '2026-01-02T03:04:05.000Z', stop: { at: '2026-01-03T00:00:00.000Z', name: 'A' } };
  const trip = codec.parse(JSON.stringify(good), { construct: Trip, validationContext: context });
  assert.equal(codec.stringify(trip as never, { validationContext: context }), JSON.stringify(good));
  assert.throws(() => codec.parse(JSON.stringify({ ...good, stop: { ...good.stop, at: 'nope' } }), { construct: Trip, validationContext: context }), validationError);
  const bad = codec.parse(JSON.stringify(good), { construct: Trip }) as { stop: object };
  Reflect.set(bad.stop, 'at', 'not a date');
  assert.throws(() => codec.stringify(bad as never, { validationContext: context }), validationError);
});
