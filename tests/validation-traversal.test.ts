import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelField, ModelTypeDescriptor } from '@exprtlabs/codegen/model';
import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import {
  getModelRuntimeValidator,
  getValidator,
} from '@exprtlabs/codegen/validation';
import { installCodecModel } from './register-codec-model.js';

const numberDescriptor: ModelTypeDescriptor = { kind: 'number' };
const childDescriptor: ModelTypeDescriptor = {
  kind: 'object',
  properties: { value: numberDescriptor },
  required: ['value'],
  additionalProperties: false,
};

function registerModel<Model extends object>(
  constructor: new (...arguments_: never[]) => Model,
  root: string,
  definitions: Readonly<Record<string, ModelTypeDescriptor>>,
  fields: readonly ModelField<Model>[],
  nestedCodecIds?: readonly string[],
): void {
  installCodecModel({
    constructor,
    name: root,
    fields,
    definitions,
    nestedCodecIds,
    conversion: {
      decode: value => Object.assign(new constructor(), value as object),
      encode: model => Object.fromEntries(fields.map(field => [field, Reflect.get(model, field)])),
    },
  });
}

test('unconstrained structural validation stays synchronous through nested models and arrays', () => {
  class Child {
    public value = 1;
  }
  class Root {
    public child = new Child();
    public children = [new Child(), new Child()];
  }
  registerModel(Child, 'Child', { Child: childDescriptor }, ['value']);
  registerModel(
    Root,
    'Root',
    {
      Root: {
        kind: 'object',
        properties: {
          child: { kind: 'generated-model', id: 'Child' },
          children: { kind: 'array', item: { kind: 'generated-model', id: 'Child' } },
        },
        required: ['child', 'children'],
        additionalProperties: false,
      },
    },
    ['child', 'children'],
    ['Child'],
  );

  const result = getModelRuntimeValidator(new Root())(new Root());
  assert.equal(result, true);
});

test('nested instance rules run when the root has no local rules', async () => {
  class Child {
    public value = 1;
  }
  class Root {
    public child = new Child();
  }
  registerModel(Child, 'Child', { Child: childDescriptor }, ['value']);
  registerModel(
    Root,
    'Root',
    {
      Root: {
        kind: 'object',
        properties: { child: { kind: 'generated-model', id: 'Child' } },
        required: ['child'],
        additionalProperties: false,
      },
    },
    ['child'],
    ['Child'],
  );

  const child = new Child();
  let calls = 0;
  getValidator(child).extend({ value: () => { calls += 1; return 'child is invalid'; } });
  const root = new Root();
  root.child = child;
  const valid = await getValidator(root).validate();

  assert.equal(valid, false);
  assert.equal(calls, 1);
  assert.deepEqual(getValidator(root).issues.map(issue => issue.path), [['child', 'value']]);
});

test('custom thenables suspend rule traversal once and preserve the original result', async () => {
  class Child {
    public value = 1;
  }
  class Root {
    public child = new Child();
  }
  registerModel(Child, 'Child', { Child: childDescriptor }, ['value']);
  registerModel(
    Root,
    'Root',
    {
      Root: {
        kind: 'object',
        properties: { child: { kind: 'generated-model', id: 'Child' } },
        required: ['child'],
        additionalProperties: false,
      },
    },
    ['child'],
    ['Child'],
  );

  let thenCalls = 0;
  const child = new Child();
  getValidator(child).extend({
    value: () => ({
      then(resolve: (value: string) => void): void {
        thenCalls += 1;
        resolve('delayed child error');
      },
    } as unknown as Promise<string>),
  });
  const root = new Root();
  root.child = child;

  const validation = getValidator(root).validate();
  assert.equal(thenCalls, 0, 'thenable assimilation stays asynchronous');
  assert.equal(await validation, false);
  assert.equal(thenCalls, 1);
  assert.deepEqual(getValidator(root).issues.map(issue => issue.message), ['delayed child error']);
});

test('async rule continuation resumes at the next rule without replaying siblings', async () => {
  class Model {
    public first = 1;
    public second = 2;
  }
  registerModel(
    Model,
    'Model',
    {
      Model: {
        kind: 'object',
        properties: { first: numberDescriptor, second: numberDescriptor },
        required: ['first', 'second'],
        additionalProperties: false,
      },
    },
    ['first', 'second'],
  );

  let firstThenCalls = 0;
  let secondCalls = 0;
  const model = new Model();
  getValidator(model).extend({
    first: () => ({
      then(resolve: (value: string) => void): void {
        firstThenCalls += 1;
        resolve('first failed');
      },
    } as unknown as Promise<string>),
    second: () => {
      secondCalls += 1;
      return 'second failed';
    },
  });

  assert.equal(await getValidator(model).validate({ failFast: false }), false);
  assert.equal(firstThenCalls, 1);
  assert.equal(secondCalls, 1);
  assert.deepEqual(getValidator(model).issues.map(issue => issue.message), ['first failed', 'second failed']);
});

test('rejected thenables become validation errors without rerunning the rule', async () => {
  class Model {
    public value = 1;
  }
  registerModel(Model, 'Model', { Model: childDescriptor }, ['value']);
  const cause = new Error('rule failed');
  let thenCalls = 0;
  const model = new Model();
  getValidator(model).extend({
    value: () => ({
      then(_resolve: unknown, reject: (error: Error) => void): void {
        thenCalls += 1;
        reject(cause);
      },
    } as unknown as Promise<string>),
  });

  await assert.rejects(
    () => getValidator(model).validate(),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.cause === cause,
  );
  assert.equal(thenCalls, 1);
});
