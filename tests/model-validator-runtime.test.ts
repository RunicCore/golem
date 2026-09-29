import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { autorun } from 'mobx';

import type * as ModelModule from '@exprtlabs/codegen/model';
import type * as ValidationModule from '@exprtlabs/codegen/validation';
import type * as AjvModule from '@exprtlabs/codegen/ajv';
import type * as MobxModule from '@exprtlabs/codegen/mobx';
import type * as MobxValidationModule from '@exprtlabs/codegen/mobx-validation';
import { installCodecModel } from './register-codec-model.js';
import type { GeneratedModelValidatorEnhancer, ModelTypeDescriptor } from '@exprtlabs/codegen/model';

const distRoot = dirname(fileURLToPath(import.meta.resolve('@exprtlabs/codegen/model')));

async function runtime(name: 'model'): Promise<typeof ModelModule>;
async function runtime(name: 'validation'): Promise<typeof ValidationModule>;
async function runtime(name: 'ajv'): Promise<typeof AjvModule>;
async function runtime(name: 'mobx'): Promise<typeof MobxModule>;
async function runtime(name: 'mobx-validation'): Promise<typeof MobxValidationModule>;
async function runtime(name: string): Promise<unknown>;
async function runtime(name: string): Promise<unknown> {
  const modulePath = pathToFileURL(join(distRoot, `${name}.js`)).href;
  return import(modulePath);
}

function validatedModel(
  constructor: abstract new (...arguments_: never[]) => { toJSON?: () => unknown },
  name: string,
  definitions: Readonly<Record<string, ModelTypeDescriptor>>,
  fields: readonly string[],
  enhanceValidator?: GeneratedModelValidatorEnhancer,
): void {
  installCodecModel({
    constructor: constructor as never,
    name,
    fields,
    definitions,
    conversion: {
      decode: (value) => Object.assign(new (constructor as new () => object)(), value as object),
      encode: (model) => {
        const record = model as { toJSON?: () => unknown };
        return typeof record.toJSON === 'function' ? record.toJSON() : model;
      },
    },
    ...(enhanceValidator ? { enhanceValidator } : {}),
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Rest Tuples and Escaped JSON Pointer Property Paths
// ---------------------------------------------------------------------------

test('tuple validation supports rest elements with prefix only', async () => {
  const [{ registerGeneratedModel }, validation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
  ]);

  interface PrefixTupleFields {
    data: [string, ...number[]];
  }

  class PrefixTupleModel {
    public data?: unknown;
    public constructor(data?: unknown) {
      this.data = data;
    }
    public toJSON(): PrefixTupleFields {
      return { data: this.data as [string, ...number[]] };
    }
  }

  validatedModel(PrefixTupleModel, 'PrefixTuple', {
        PrefixTuple: {
          kind: 'object',
          required: ['data'],
          additionalProperties: false,
          properties: {
            data: {
              kind: 'tuple',
              items: [{ kind: 'string' }],
              rest: {
                index: 1,
                item: { kind: 'number' },
              },
            },
          },
        },
      }, ['data']);

  // Positive cases: 1 item (prefix only), 2 items (prefix + 1 rest), 4 items (prefix + 3 rest)
  for (const validData of [
    ['hello'],
    ['hello', 42],
    ['hello', 1, 2, 3, 4],
  ]) {
    const model = new PrefixTupleModel(validData);
    const validator = validation.getValidator(model);
    assert.equal(await validator.validate(), true, `Expected valid for ${JSON.stringify(validData)}`);
    assert.equal(validator.issues.length, 0);
  }

  // Negative case: empty array (less than min length 1)
  {
    const model = new PrefixTupleModel([]);
    const validator = validation.getValidator(model);
    assert.equal(await validator.validate(), false);
    assert.equal(validator.issues.some((i) => i.path[0] === 'data'), true);
  }

  // Negative case: prefix has wrong type
  {
    const model = new PrefixTupleModel([123, 456]);
    const validator = validation.getValidator(model);
    assert.equal(await validator.validate(), false);
    assert.deepEqual(
      validator.issues.map((i) => ({ code: i.code, path: i.path })),
      [{ code: 'type', path: ['data', 0] }],
    );
  }

  // Negative case: rest element has wrong type
  {
    const model = new PrefixTupleModel(['hello', 1, 'bad', 3]);
    const validator = validation.getValidator(model);
    assert.equal(await validator.validate(), false);
    assert.deepEqual(
      validator.issues.map((i) => ({ code: i.code, path: i.path })),
      [{ code: 'type', path: ['data', 2] }],
    );
  }
});

test('tuple validation supports rest elements with prefix and suffix', async () => {
  const [{ registerGeneratedModel }, validation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
  ]);

  interface PrefixSuffixTupleFields {
    data: [string, ...number[], boolean];
  }

  class PrefixSuffixTupleModel {
    public data?: unknown;
    public constructor(data?: unknown) {
      this.data = data;
    }
    public toJSON(): PrefixSuffixTupleFields {
      return { data: this.data as [string, ...number[], boolean] };
    }
  }

  validatedModel(PrefixSuffixTupleModel, 'PrefixSuffixTuple', {
        PrefixSuffixTuple: {
          kind: 'object',
          required: ['data'],
          additionalProperties: false,
          properties: {
            data: {
              kind: 'tuple',
              items: [{ kind: 'string' }, { kind: 'boolean' }],
              rest: {
                index: 1,
                item: { kind: 'number' },
              },
            },
          },
        },
      }, ['data']);

  // Positive cases:
  // length 2 (prefix + suffix, 0 rest items)
  // length 3 (prefix + 1 rest item + suffix)
  // length 5 (prefix + 3 rest items + suffix)
  for (const validData of [
    ['prefix', true],
    ['prefix', 100, false],
    ['prefix', 1, 2, 3, true],
  ]) {
    const model = new PrefixSuffixTupleModel(validData);
    const validator = validation.getValidator(model);
    assert.equal(await validator.validate(), true, `Expected valid for ${JSON.stringify(validData)}`);
  }
});

test('tuple validation supports rest elements with suffix only and optionalFrom', async () => {
  const [{ registerGeneratedModel }, validation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
  ]);

  interface SuffixTupleFields {
    data: [...number[], string];
  }

  class SuffixTupleModel {
    public data?: unknown;
    public constructor(data?: unknown) {
      this.data = data;
    }
    public toJSON(): SuffixTupleFields {
      return { data: this.data as [...number[], string] };
    }
  }

  validatedModel(SuffixTupleModel, 'SuffixTuple', {
        SuffixTuple: {
          kind: 'object',
          required: ['data'],
          additionalProperties: false,
          properties: {
            data: {
              kind: 'tuple',
              items: [{ kind: 'string' }],
              rest: {
                index: 0,
                item: { kind: 'number' },
              },
            },
          },
        },
      }, ['data']);

  // Positive: 1 item ('end'), 3 items (1, 2, 'end')
  assert.equal(await validation.getValidator(new SuffixTupleModel(['end'])).validate(), true);
  assert.equal(await validation.getValidator(new SuffixTupleModel([1, 2, 'end'])).validate(), true);
});

test('JSON Pointer escapes ~ and / in property paths; errorsFor finds actual field', async () => {
  const [{ registerGeneratedModel }, validation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
  ]);

  interface EscapedFields {
    'a/b': string;
    'c~d': number;
    'e/f~g': boolean;
  }

  class EscapedModel {
    public 'a/b'?: unknown;
    public 'c~d'?: unknown;
    public 'e/f~g'?: unknown;

    public constructor(values: Record<string, unknown> = {}) {
      Object.assign(this, values);
    }

    public toJSON(): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      if (this['a/b'] !== undefined) result['a/b'] = this['a/b'];
      if (this['c~d'] !== undefined) result['c~d'] = this['c~d'];
      if (this['e/f~g'] !== undefined) result['e/f~g'] = this['e/f~g'];
      return result;
    }
  }

  validatedModel(EscapedModel, 'Escaped', {
        Escaped: {
          kind: 'object',
          required: ['a/b', 'c~d', 'e/f~g'],
          additionalProperties: false,
          properties: {
            'a/b': { kind: 'string' },
            'c~d': { kind: 'number' },
            'e/f~g': { kind: 'boolean' },
          },
        },
      }, ['a/b', 'c~d', 'e/f~g']);

  // Invalid types on all three escaped fields
  const invalid = new EscapedModel({
    'a/b': 123,
    'c~d': 'not-a-number',
    'e/f~g': 'not-a-boolean',
  });

  const validator = validation.getValidator<EscapedFields, EscapedModel>(invalid);
  validator.messages({
    'a/b.type': 'Field a/b must be a valid string',
    'c~d.type': 'Field c~d must be a valid number',
  });

  assert.equal(await validator.validate({ failFast: false }), false);

  // Issues paths must preserve the exact field names (not split into 'a.b')
  const paths = validator.issues.map((i) => i.path);
  assert.ok(paths.some((path) => path.length === 1 && path[0] === 'a/b'), `Expected 'a/b' in paths: ${JSON.stringify(paths)}`);
  assert.ok(paths.some((path) => path.length === 1 && path[0] === 'c~d'), `Expected 'c~d' in paths: ${JSON.stringify(paths)}`);
  assert.ok(paths.some((path) => path.length === 1 && path[0] === 'e/f~g'), `Expected 'e/f~g' in paths: ${JSON.stringify(paths)}`);

  // errorsFor('a/b') must find the actual field
  assert.deepEqual(validator.errorsFor('a/b'), ['Field a/b must be a valid string']);
  assert.equal(validator.error('a/b'), 'Field a/b must be a valid string');

  // errorsFor('c~d') must find the actual field
  assert.deepEqual(validator.errorsFor('c~d'), ['Field c~d must be a valid number']);

  // errorsFor('e/f~g') must find the default message
  assert.deepEqual(validator.errorsFor('e/f~g'), ['must be boolean']);

  // Missing required check for escaped fields
  const missingModel = new EscapedModel({});
  const missingValidator = validation.getValidator<EscapedFields, EscapedModel>(missingModel);
  assert.equal(await missingValidator.validate({ failFast: false }), false);
  assert.deepEqual(
    missingValidator.issues.map((i) => ({ code: i.code, path: i.path })),
    [
      { code: 'required', path: ['a/b'] },
      { code: 'required', path: ['c~d'] },
      { code: 'required', path: ['e/f~g'] },
    ],
  );
  assert.deepEqual(missingValidator.errorsFor('a/b'), ["must have required property 'a/b'"]);
});

// ---------------------------------------------------------------------------
// Validator Caching, Integration Order, Reactivity, and State
// ---------------------------------------------------------------------------

test('plain getter called FIRST, MobX getter called SECOND shares identity and enhances in place', async () => {
  const [{ registerGeneratedModel }, validation, mobxValidation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
    runtime('mobx-validation'),
  ]);

  interface Order1Fields {
    title: string;
    count: number;
  }

  class Order1Model {
    public title = '';
    public count = -1;
    public toJSON(): Order1Fields {
      return { title: this.title, count: this.count };
    }
  }

  validatedModel(Order1Model, 'Order1', {
        Order1: {
          kind: 'object',
          required: ['title', 'count'],
          additionalProperties: false,
          properties: {
            title: { kind: 'string' },
            count: { kind: 'number' },
          },
        },
      }, ['title', 'count']);

  const model = new Order1Model();

  // 1. Plain getter called FIRST
  const plainValidator = validation.getValidator<Order1Fields, Order1Model>(model);
  plainValidator
    .extend({
      count: (val: number) => val >= 0 || 'Count must be non-negative',
    })
    .messages({
      'title.type': 'Title has wrong type',
    });

  // 2. MobX getter called SECOND
  const mobxValidator = mobxValidation.getValidator<Order1Fields, Order1Model>(model);

  // Identity check
  assert.strictEqual(plainValidator, mobxValidator, 'Plain and MobX validators must be the exact same instance');

  // Reactivity check: autorun observes valid and issues
  const validityTransitions: boolean[] = [];
  const issueCountTransitions: number[] = [];
  const dispose = autorun(() => {
    validityTransitions.push(mobxValidator.valid);
    issueCountTransitions.push(mobxValidator.issues.length);
  });

  // Initial state before validation
  assert.deepEqual(validityTransitions, [true]);
  assert.deepEqual(issueCountTransitions, [0]);

  // Run validation (count is -1 so custom rule fails)
  const result1 = await mobxValidator.validate();
  assert.equal(result1, false);
  assert.deepEqual(validityTransitions, [true, false]);
  assert.deepEqual(issueCountTransitions, [0, 1]);
  assert.deepEqual(mobxValidator.errorsFor('count'), ['Count must be non-negative']);

  // Fix model and re-validate
  model.count = 10;
  const result2 = await plainValidator.validate();
  assert.equal(result2, true);
  assert.deepEqual(validityTransitions, [true, false, true]);
  assert.deepEqual(issueCountTransitions, [0, 1, 0]);

  // Server errors via setErrors
  plainValidator.setErrors({ title: 'Title already taken' });
  assert.deepEqual(validityTransitions, [true, false, true, false]);
  assert.deepEqual(issueCountTransitions, [0, 1, 0, 1]);
  assert.equal(mobxValidator.error('title'), 'Title already taken');

  // Clear errors
  mobxValidator.clear();
  assert.deepEqual(validityTransitions, [true, false, true, false, true]);
  assert.deepEqual(issueCountTransitions, [0, 1, 0, 1, 0]);

  dispose();
});

test('MobX getter called FIRST, plain getter called SECOND shares identity and observation', async () => {
  const [{ registerGeneratedModel }, validation, mobxValidation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
    runtime('mobx-validation'),
  ]);

  interface Order2Fields {
    name: string;
  }

  class Order2Model {
    public name = 123; // invalid type
    public toJSON(): Record<string, unknown> {
      return { name: this.name };
    }
  }

  validatedModel(Order2Model, 'Order2', {
        Order2: {
          kind: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { kind: 'string' },
          },
        },
      }, ['name']);

  const model = new Order2Model();

  // 1. MobX getter called FIRST
  const mobxValidator = mobxValidation.getValidator<{ name: string }, Order2Model>(model);

  // 2. Plain getter called SECOND
  const plainValidator = validation.getValidator<{ name: string }, Order2Model>(model);

  // Identity check
  assert.strictEqual(mobxValidator, plainValidator);

  const observedErrors: string[] = [];
  const dispose = autorun(() => {
    const err = plainValidator.error('name');
    if (err) observedErrors.push(err);
  });

  await mobxValidator.validate();
  assert.deepEqual(observedErrors, ['must be string']);

  dispose();
});

test('direct MobX ModelValidator constructor enhances in place and runs setters in actions', async () => {
  const [{ registerGeneratedModel }, validation, mobxValidation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
    runtime('mobx-validation'),
  ]);

  interface DirectFields {
    status: string;
  }

  class DirectModel {
    public status = 'pending';
    public toJSON(): DirectFields {
      return { status: this.status };
    }
  }

  validatedModel(DirectModel, 'Direct', {
        Direct: {
          kind: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: {
            status: { kind: 'string' },
          },
        },
      }, ['status']);

  const model = new DirectModel();
  const directValidator = new mobxValidation.ModelValidator(model);

  // Verify getters and actions work without error under MobX strict mode
  const observedIssues: number[] = [];
  const dispose = autorun(() => {
    observedIssues.push(directValidator.issues.length);
  });

  directValidator.setErrors({ status: 'Invalid status' });
  assert.deepEqual(observedIssues, [0, 1]);

  directValidator.clear();
  assert.deepEqual(observedIssues, [0, 1, 0]);

  dispose();
});

test('enhanceValidatorWithMobX and repeated getValidator calls are idempotent', async () => {
  const [{ registerGeneratedModel }, mobxValidation] = await Promise.all([
    runtime('model'),
    runtime('mobx-validation'),
  ]);

  class IdempotentModel {
    public value = 1;
    public toJSON() {
      return { value: this.value };
    }
  }

  registerGeneratedModel(IdempotentModel, { fields: ['value'] });
  const model = new IdempotentModel();

  const v1 = mobxValidation.getValidator(model);
  const v2 = mobxValidation.getValidator(model);
  const v3 = mobxValidation.enhanceValidatorWithMobX(v1);

  assert.strictEqual(v1, v2);
  assert.strictEqual(v1, v3);
});

test('async validation observes pending state transition [false -> true -> false]', async () => {
  const [{ registerGeneratedModel }, mobxValidation] = await Promise.all([
    runtime('model'),
    runtime('mobx-validation'),
  ]);

  interface AsyncFields {
    email: string;
  }

  class AsyncModel {
    public email = 'test@example.com';
    public toJSON(): AsyncFields {
      return { email: this.email };
    }
  }

  validatedModel(AsyncModel, 'Async', {
        Async: {
          kind: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { kind: 'string' },
          },
        },
      }, ['email']);

  const model = new AsyncModel();
  const validator = mobxValidation.getValidator<AsyncFields, AsyncModel>(model);

  // Add an asynchronous rule
  validator.extend({
    email: async (value: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return value.includes('@') || 'Must be a valid email';
    },
  });

  const pendingLog: boolean[] = [];
  const dispose = autorun(() => {
    pendingLog.push(validator.pending);
  });

  assert.deepEqual(pendingLog, [false]);

  const validationPromise = validator.validate();
  assert.equal(validator.pending, true);

  const result = await validationPromise;
  assert.equal(result, true);
  assert.equal(validator.pending, false);

  assert.deepEqual(pendingLog, [false, true, false]);
  dispose();
});

test('ModelValidator keeps the latest overlapping result and clears stale pending state', async () => {
  const [, , mobxValidation] = await Promise.all([
    runtime('model'),
    runtime('validation'),
    runtime('mobx-validation'),
  ]);

  interface OverlapFields {
    value: string;
  }

  class OverlapModel {
    public value = 'value';
    public toJSON(): OverlapFields {
      return { value: this.value };
    }
  }

  validatedModel(OverlapModel, 'Overlap', {
        Overlap: {
          kind: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: {
            value: { kind: 'string' },
          },
        },
      }, ['value']);

  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  let invocation = 0;
  const model = new OverlapModel();
  const validator = mobxValidation.getValidator<OverlapFields, OverlapModel>(model);
  validator.extend({
    value: async () => {
      const current = invocation++;
      await gates[current]!.promise;
      return `result-${current}`;
    },
  });

  const first = validator.validate();
  assert.equal(validator.pending, true);
  const second = validator.validate();
  assert.equal(invocation, 2, 'overlapping validate calls both start instance overlay rules');

  gates[0]!.resolve();
  assert.equal(await first, false);
  assert.equal(validator.pending, true, 'the stale completion must not clear newer pending state');
  assert.deepEqual(validator.issues, [], 'the stale result must not replace the latest state');

  gates[1]!.resolve();
  assert.equal(await second, false);
  assert.equal(validator.pending, false);
  assert.deepEqual(validator.errorsFor('value'), ['result-1']);

  const pendingClear = validator.validate();
  assert.equal(validator.pending, true);
  validator.clear();
  assert.equal(validator.pending, false);
  assert.deepEqual(validator.issues, []);
  gates[2]!.resolve();
  assert.equal(await pendingClear, false);
  assert.equal(validator.pending, false, 'a cleared validation must not restore pending state');
  assert.deepEqual(validator.issues, []);

  const pendingExternal = validator.validate();
  assert.equal(validator.pending, true);
  validator.setErrors({ value: 'server rejected value' });
  assert.equal(validator.pending, false, 'external errors are the latest explicit state');
  assert.deepEqual(validator.errorsFor('value'), ['server rejected value']);
  gates[3]!.resolve();
  assert.equal(await pendingExternal, false);
  assert.equal(validator.pending, false);
  assert.deepEqual(validator.errorsFor('value'), ['server rejected value']);
});
