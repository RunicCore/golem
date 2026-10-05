import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { autorun, observable, runInAction } from 'mobx';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import * as model from '@exprtlabs/golem/model';
import * as validation from '@exprtlabs/golem/validation';
import * as mobxRuntime from '@exprtlabs/golem/mobx';
import * as mobxValidation from '@exprtlabs/golem/mobx-validation';
import * as emitter from '@exprtlabs/golem/emitter';
import { installCodecModel } from './register-codec-model.js';
import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { workspace } from './support/process.js';
import * as manifest from '@exprtlabs/golem/manifest';

const distRoot = dirname(fileURLToPath(import.meta.resolve('@exprtlabs/golem/model')));
const packageRoot = dirname(distRoot);

test('model guards recognize registered constructors and subclasses without treating plain payloads as models', () => {
  class Base { value = 'initial'; }
  class Child extends Base {}
  class Ordinary { value = 'initial'; }
  let conversions = 0;
  model.registerGeneratedModel(Base, {
    fields: ['value'],
    conversion: {
      decode: () => { conversions++; return new Base(); },
      encode: value => { conversions++; return { value: value.value }; },
    },
  });
  for (const constructor of [Base, Child]) assert.equal(model.isGeneratedModelConstructor(constructor), true);
  for (const instance of [new Base(), new Child()]) assert.equal(model.isGeneratedModel(instance), true);
  for (const value of [null, undefined, 'text', 1, [], {}, new Ordinary(), { constructor: Base }, Object.create(null)]) {
    assert.equal(model.isGeneratedModel(value), false);
    assert.equal(model.isGeneratedModelConstructor(value), false);
  }
  assert.equal(model.isGeneratedModelConstructor(Ordinary), false);
  assert.equal(model.isGeneratedModel(Base), false);
  assert.deepEqual(Object.keys(Base.prototype), []);
  assert.deepEqual(Object.keys(new Child()), ['value']);
  assert.equal(JSON.stringify(new Child()), '{"value":"initial"}');
  class MetadataOnly extends Base {}
  model.registerGeneratedModel(MetadataOnly, { fields: ['value'] });
  assert.equal(model.isGeneratedModelConstructor(MetadataOnly), false);
  assert.equal(model.isGeneratedModel(new MetadataOnly()), false);
  assert.equal(conversions, 0);
});

interface PaymentFields {
  id: string;
  amount: number;
  currency: 'VND' | 'USD';
  note?: string;
}

test('dependency-free runtime entrypoints do not import optional integrations', () => {
  const modelSource = fs.readFileSync(join(distRoot, 'model.js'), 'utf8');
  const validationSources = ['validation.js', 'schema-registry-validation.js']
    .map(name => fs.readFileSync(join(distRoot, name), 'utf8'));
  assert.doesNotMatch(modelSource, /from ['"].*(?:mobx|ajv)/i);
  assert.doesNotMatch(modelSource, /node:/);
  for (const source of validationSources) {
    assert.doesNotMatch(source, /from ['"].*(?:mobx|ajv)/i);
    assert.doesNotMatch(source, /node:/);
  }
});

test('structural validation preserves descriptors, custom rules, messages, and caching', async () => {
  class PaymentModel {
    public id?: unknown;
    public amount?: unknown;
    public currency?: unknown;
    public note?: unknown;

    public constructor(values: Partial<PaymentFields> = {}) {
      Object.assign(this, values);
    }

    public toJSON(): PaymentFields {
      return {
        id: this.id as string,
        amount: this.amount as number,
        currency: this.currency as 'VND' | 'USD',
        note: this.note as string | undefined,
      };
    }
  }

  await installCodecModel({
    constructor: PaymentModel,
    name: 'Payment',
    fields: ['id', 'amount', 'currency', 'note'],
    conversion: {
      decode: (value) => Object.assign(new PaymentModel(), value as object),
      encode: (instance) => instance.toJSON(),
    },
    definitions: {
      Payment: {
        kind: 'object',
        required: ['id', 'amount', 'currency'],
        additionalProperties: true,
        properties: {
          id: { kind: 'string' },
          amount: { kind: 'number' },
          currency: {
            kind: 'union',
            variants: [
              { kind: 'literal', value: 'VND' },
              { kind: 'literal', value: 'USD' },
            ],
          },
          note: {
            kind: 'union',
            variants: [
              { kind: 'undefined' },
              { kind: 'string' },
            ],
          },
        },
      },
    },
  });

  const invalid = Object.assign(new PaymentModel(), { id: 1, amount: '100', currency: 'EUR' });
  const validator = validation.getValidator<PaymentFields, PaymentModel>(invalid);
  assert.strictEqual(
    validator,
    validation.getValidator<PaymentFields, PaymentModel>(invalid),
  );
  validator
    .extend({
      amount: (value: unknown) => (typeof value === 'number' && value > 0) || 'Amount must be positive',
    })
    .messages({
      'amount.type': 'Amount has the wrong wire type',
    });

  assert.equal(await validator.validate({ failFast: false }), false);
  const paths = validator.issues.map((issue) => issue.path.join('.'));
  assert.ok(paths.includes('id'));
  assert.ok(paths.includes('amount'));
  assert.ok(paths.includes('currency'));
  assert.ok(validator.issues.some((issue) => issue.source === 'custom' && issue.path[0] === 'amount'));
  assert.equal(typeof validator.error('amount'), 'string');

  validator.clear();
  validator.setErrors({ currency: 'Currency is blocked' });
  assert.equal(validator.error('currency'), 'Currency is blocked');
  assert.deepEqual(
    validator.issues.map(({ source, code, path }) => ({ source, code, path })),
    [{ source: 'external', code: 'external', path: ['currency'] }],
  );
  validator.clear();
  assert.equal(validator.valid, true);

  class MetadataOnlyModel {}
  model.registerGeneratedModel(MetadataOnlyModel, { fields: [] });
  const metadataOnly = validation.getValidator(MetadataOnlyModel.prototype);
  // Without a profile, a model with nothing to check is not validatable.
  await assert.rejects(() => metadataOnly.validate(), (error: unknown) =>
    error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable);
  await assert.rejects(() => validation.validateInstance(MetadataOnlyModel.prototype), (error: unknown) =>
    error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable);
  class RuleOnlyModel { public name = ''; }
  model.registerGeneratedModel(RuleOnlyModel, { fields: ['name'] });
  const ruleOnly = new RuleOnlyModel();
  const ruleValidator = validation.getValidator<{ name: string }, RuleOnlyModel>(ruleOnly)
    .extend({ name: (value: unknown) => value !== '' || 'Name is required' });
  assert.equal(await ruleValidator.validate(), false);
  assert.deepEqual(ruleValidator.errorsFor('name'), ['Name is required']);
});

test('structural validation delegates nested generated-model validation', async () => {
  class MoneyModel {
    public currency?: string;
    public toJSON(): { currency?: string } {
      return { currency: this.currency };
    }
  }
  await installCodecModel({
    constructor: MoneyModel,
    name: 'Money',
    fields: ['currency'],
    conversion: {
      decode: (value) => Object.assign(new MoneyModel(), value as object),
      encode: (instance) => instance.toJSON(),
    },
    definitions: {
      Money: {
        kind: 'object',
        required: ['currency'],
        additionalProperties: false,
        properties: {
          currency: { kind: 'string', constraints: [{ kind: 'pattern', value: '^[A-Z]{3}$' }] },
        },
      },
    },
  });

  class AggregateModel {
    public money?: MoneyModel;
    public constructor(values: { money?: MoneyModel } = {}) {
      Object.assign(this, values);
    }
  }
  await installCodecModel({
    constructor: AggregateModel,
    name: 'Aggregate',
    fields: ['money'],
    nestedCodecIds: ['Money'],
    conversion: {
      decode: (value) => Object.assign(new AggregateModel(), value as object),
      encode: (instance) => ({ money: instance.money }),
    },
    definitions: {
      Aggregate: {
        kind: 'object',
        required: ['money'],
        additionalProperties: false,
        properties: {
          money: { kind: 'generated-model', id: 'Money' },
        },
      },
    },
  });

  const money = new MoneyModel();
  money.currency = 'usd';
  const invalid = new AggregateModel({ money });
  const validator = validation.getValidator(invalid);
  assert.equal(await validator.validate(), false);
  assert.ok(validator.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(['money', 'currency'])));
});

test('MobX runtime preserves observation and shares validator identity', async () => {
  interface PaymentFieldsMobx {
    amount: number;
    currency: string;
  }

  class PaymentModel {
    public amount?: number;
    public currency?: string;

    public constructor(values: Partial<PaymentFieldsMobx> = {}) {
      Object.assign(this, values);
    }

  }
  await installCodecModel({
    constructor: PaymentModel,
    name: 'MobxPayment',
    fields: ['amount', 'currency'],
    definitions: {
      MobxPayment: {
        kind: 'object',
        required: ['amount', 'currency'],
        additionalProperties: false,
        properties: {
          amount: { kind: 'number', constraints: [{ kind: 'minimum', value: 1 }] },
          currency: { kind: 'string', constraints: [{ kind: 'pattern', value: '^[A-Z]{3}$' }] },
        },
      },
    },
  });

  const payment = new PaymentModel({ amount: 0, currency: 'USD' });
  mobxRuntime.asGenObservable(payment, { amount: observable.ref });
  const observed: (number | undefined)[] = [];
  const dispose = autorun(() => observed.push(payment.amount));
  const validator = mobxValidation.getValidator<PaymentFieldsMobx, PaymentModel>(payment);
  assert.strictEqual(validator, validation.getValidator(payment));
  validator.messages({ 'amount.tooSmall': 'Amount must be positive' });
  assert.equal(await validator.validate(), false);
  assert.deepEqual(validator.errorsFor('amount'), ['Amount must be positive']);
  runInAction(() => {
    payment.amount = 5;
  });
  assert.equal(await validator.validate(), true);
  assert.deepEqual(observed, [0, 5]);
  assert.throws(
    () => mobxRuntime.asGenObservable(payment),
    /asGenObservable\(\) may only be called once/,
  );
  dispose();
});

test('shared emitter emits exact generated-model conversion expressions', () => {
  const resolveModel = (id: string) => ({
    className: id === 'money' ? 'MoneyModel' : 'OtherModel',
    decode: (expression: string) => `decodeGeneratedModel(MoneyModel, ${expression})`,
    fromInit: (expression: string) => `new MoneyModel(${expression})`,
    encode: (expression: string) => `encodeGeneratedModel(${expression})`,
  });
  assert.equal(
    emitter.emitModelFromJSON(
      { kind: 'array', item: { kind: 'generated-model', id: 'money' } },
      'value',
      resolveModel,
    ),
    'Array.isArray(value) ? (value as readonly unknown[]).map((item, index) => convertModelField(\'deserialize\', index, (fieldValue: unknown) => (fieldValue == null || fieldValue instanceof MoneyModel ? fieldValue : decodeGeneratedModel(MoneyModel, fieldValue)), item)) : value',
  );
  assert.equal(
    emitter.emitModelToJSON({ kind: 'generated-model', id: 'money' }, 'value', resolveModel),
    'value instanceof MoneyModel ? encodeGeneratedModel(value) : value',
  );
});

test('model manifests validate profile and keep identity independent of profile', () => {
  const base = {
    profile: { mobx: false, validation: true, ajvStandalone: false, allowAny: false },
    models: [{
      id: 'fixture:payment',
      allowAny: false,
      type: { module: './types.ts', export: 'Payment' },
      generated: { module: './models.ts', export: 'PaymentModel' },
    }],
  };
  const profileVariant = {
    ...base,
    profile: { mobx: true, validation: false, ajvStandalone: false, allowAny: true },
  };
  assert.strictEqual(manifest.validateModelManifest(base), base);
  assert.equal(manifest.sourceDigest(base), manifest.sourceDigest(profileVariant));
  assert.deepEqual(manifest.modelManifestProfile(base), {
    mobx: false,
    validation: true,
    ajvStandalone: false,
    allowAny: false,
    unknownFormats: 'warn',
  });
  assert.throws(
    () => manifest.validateModelManifest({ ...base, profile: { mobx: true } }),
    /profile must include mobx, validation, ajvStandalone and allowAny booleans/,
  );
  assert.equal(manifest.modelManifestProfile({ ...base, profile: { ...base.profile, unknownFormats: 'error' } }).unknownFormats, 'error');
  assert.throws(
    () => manifest.validateModelManifest({ ...base, profile: { ...base.profile, unknownFormats: 'strict' } }),
    /unknownFormats must be "warn" or "error"/,
  );
  assert.throws(
    () => manifest.validateModelManifest({ ...base, manifestVersion: 2 }),
    /Outdated model manifest/,
  );
  const closure = [{ codecId: 'Payment_a1b2c3d4', modelSchema: { type: 'object' }, wireSchema: false, aliases: ['Payment'] }];
  assert.deepEqual(manifest.validateModelManifest({ ...base, validationSchemaClosure: closure }).validationSchemaClosure, closure);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const invalid of [null, {}, [{ codecId: '', modelSchema: true }], [{ codecId: 'Payment', modelSchema: [] }],
    [{ codecId: 'Payment', modelSchema: { validate: () => true } }], [{ codecId: 'Payment', modelSchema: cycle }],
    [{ codecId: 'Payment', modelSchema: { value: new Date() } }], [{ codecId: 'Payment', modelSchema: true, aliases: [42] }]]) {
    assert.throws(() => manifest.validateModelManifest({ ...base, validationSchemaClosure: invalid }), /validationSchemaClosure/);
  }
});

test('pure runtime entrypoints load in an application without optional integrations', (t: TestContext) => {
  const root = createFixtureProject(t, 'golem-runtime-entrypoints-');

  linkProjectPackages(root, { '@exprtlabs/golem': join(workspace, 'packages/golem') });
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  copyFixtureFile(root, 'pipeline/runtime-entrypoints/verify.mjs', 'verify.mjs');
  const result = spawnSync(process.execPath, ['verify.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_PATH: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
