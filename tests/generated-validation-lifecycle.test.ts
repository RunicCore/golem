import assert from 'node:assert/strict';
import test from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import { getValidator, validateInstance } from '@exprtlabs/codegen/validation';
import { installCodecModel } from './register-codec-model.js';

test('nested generated-model $ref reports issues at the nested child path', async () => {
  class Child {
    public name = '';
  }
  class Root {
    public child!: Child;
  }

  installCodecModel({
    constructor: Child,
    name: 'Child',
    fields: ['name'],
    definitions: {
      Child: {
        kind: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { kind: 'string' } },
      },
    },
    conversion: {
      decode: value => Object.assign(new Child(), value as object),
      encode: model => model,
    },
  });
  installCodecModel({
    constructor: Root,
    name: 'Root',
    fields: ['child'],
    definitions: {
      Root: {
        kind: 'object',
        required: ['child'],
        additionalProperties: false,
        properties: { child: { kind: 'generated-model', id: 'Child' } },
      },
    },
    nestedCodecIds: ['Child'],
    conversion: {
      decode: value => Object.assign(new Root(), value as object),
      encode: model => model,
    },
  });

  const valid = Object.assign(new Root(), { child: Object.assign(new Child(), { name: 'ok' }) });
  assert.deepEqual((await validateInstance(valid)).map(issue => issue.path), []);
  const invalid = Object.assign(new Root(), { child: Object.assign(new Child(), { name: 1 as never }) });
  const issues = await validateInstance(invalid);
  assert.ok(issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['child', 'name'])));
});

test('instance validation stops at the first issue unless failFast is false', async () => {
  class TwoFieldsModel {
    public constructor(public name: unknown = 1, public count: unknown = 'x') {}
  }
  installCodecModel({
    constructor: TwoFieldsModel,
    name: 'FailFastDefault',
    fields: ['name', 'count'],
    definitions: {
      FailFastDefault: {
        kind: 'object',
        properties: { name: { kind: 'string' }, count: { kind: 'number' } },
        required: ['name', 'count'],
        additionalProperties: false,
      },
    },
  });
  const model = new TwoFieldsModel();
  assert.equal((await validateInstance(model)).length, 1);
  assert.equal((await validateInstance(model, { failFast: false })).length, 2);
  const validator = getValidator(model);
  assert.equal(await validator.validate(), false);
  assert.equal(validator.issues.length, 1);
  assert.equal(await validator.validate({ failFast: false }), false);
  assert.equal(validator.issues.length, 2);
});

test('a throwing custom rule is a program fault, not rejected input', async () => {
  class RuleFaultModel {
    public constructor(public name: unknown = 'ok') {}
  }
  installCodecModel({
    constructor: RuleFaultModel,
    name: 'RuleFault',
    fields: ['name'],
    definitions: {
      RuleFault: { kind: 'object', properties: { name: { kind: 'string' } }, required: ['name'], additionalProperties: false },
    },
  });
  const model = new RuleFaultModel();
  getValidator(model).extend({ name: () => { throw new Error('rule bug'); } });
  await assert.rejects(() => validateInstance(model), (error: unknown) =>
    error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === false);
});
