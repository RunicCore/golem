import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelField } from '@exprtlabs/golem/model';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import {
  getValidator,
} from '@exprtlabs/golem/validation';
import { installCodecModel } from './register-codec-model.js';

const numberDescriptor: ModelTypeDescriptor = { kind: 'number' };
const childDescriptor: ModelTypeDescriptor = {
  kind: 'object',
  properties: { value: numberDescriptor },
  required: ['value'],
  additionalProperties: false,
};

async function registerModel<Model extends object>(
  constructor: new (...arguments_: never[]) => Model,
  root: string,
  definitions: Readonly<Record<string, ModelTypeDescriptor>>,
  fields: readonly ModelField<Model>[],
  nestedCodecIds?: readonly string[],
): Promise<void> {
  await installCodecModel({
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

/** Registers `Child` (one numeric `value`) and `Root` (one `child` model) with their codecs, and returns both classes. */
async function registerNestedPair() {
  class Child {
    public value = 1;
  }
  class Root {
    public child = new Child();
  }
  await registerModel(Child, 'Child', { Child: childDescriptor }, ['value']);
  await registerModel(
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
  return { Child, Root };
}

test('unconstrained structural validation stays synchronous through nested models and arrays', async () => {
  class Child {
    public value = 1;
  }
  class Root {
    public child = new Child();
    public children = [new Child(), new Child()];
  }
  await registerModel(Child, 'Child', { Child: childDescriptor }, ['value']);
  await registerModel(
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

  assert.equal(requireObjectCodec('Root').validate(new Root()), true);
});

test('nested instance rules run when the root has no local rules', async () => {
  const { Child, Root } = await registerNestedPair();

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
  const { Child, Root } = await registerNestedPair();

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
  await registerModel(
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
  await registerModel(Model, 'Model', { Model: childDescriptor }, ['value']);
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

/** Registers `Holder` with the declared fields `fields`, each of type `unknown`. */
async function registerUnknownHolder<Model extends object>(constructor: new () => Model, fields: readonly string[]): Promise<void> {
  await registerModel(
    constructor,
    'Holder',
    {
      Holder: {
        kind: 'object',
        properties: Object.fromEntries(fields.map(field => [field, { kind: 'unknown' } as ModelTypeDescriptor])),
        required: [],
        additionalProperties: false,
      },
    },
    fields as readonly ModelField<Model>[],
  );
}

test('the rule walk reads an object that many paths share once', async () => {
  // protects: T-1038 a graph that doubles at each level was read once for each path, so the walk grew with the paths, not the objects
  class Holder {
    public data: unknown;
  }
  await registerUnknownHolder(Holder, ['data']);
  // A class instance is read by the rule walk only: the cycle check of the call does not descend into it.
  class Node {
    public constructor(public left?: Node, public right?: Node) {}
  }
  let leafReads = 0;
  const leaf = Object.defineProperty(new Node(), 'value', { enumerable: true, get: () => { leafReads += 1; return 1; } });
  let level = leaf;
  for (let depth = 0; depth < 12; depth++) level = new Node(level, level);
  const holder = new Holder();
  holder.data = level;
  getValidator(holder).extend({ data: () => true });

  assert.equal(await getValidator(holder).validate(), true);
  assert.equal(leafReads, 1);
});

test('a model that a shared object holds is reported under each path to it', async () => {
  // protects: T-1038 the memo of model-free objects leaves out an object that holds a model, whose issue paths depend on the path
  class Holder {
    public first: unknown;
    public second: unknown;
  }
  await registerUnknownHolder(Holder, ['first', 'second']);
  const { Child } = await registerNestedPair();
  const child = new Child();
  getValidator(child).extend({ value: () => 'child is invalid' });
  const shared = [child];
  const holder = new Holder();
  holder.first = shared;
  holder.second = shared;
  getValidator(holder).extend({ first: () => true });

  assert.equal(await getValidator(holder).validate({ failFast: false }), false);
  assert.deepEqual(getValidator(holder).issues.map(issue => issue.path), [['first', 0, 'value'], ['second', 0, 'value']]);
});
