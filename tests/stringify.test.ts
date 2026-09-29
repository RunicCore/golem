import assert from 'node:assert/strict';
import test from 'node:test';

import {
  stringifyJsonArray,
  stringifyJsonBoolean,
  stringifyJsonNumber,
  stringifyJsonScalar,
  stringifyJsonString,
} from '@exprtlabs/codegen/serde';
import { createSchemaGraph } from '@exprtlabs/codegen/schema-graph';
import { emitCodecRuntime, emitGraphStringify } from '@exprtlabs/codegen/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/codegen/model';
import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import { instantiate } from './emitted-runtime.js';

const stringCorpus = [
  '',
  'ascii',
  '"quoted"\\slash',
  '\n\r\t\b\f',
  '\ud800',
  '\udfff',
  '日本語 🙂',
  '\u2028\u2029',
];


test('leaf tokens match JSON.stringify for strings, numbers, bools and null', () => {
  for (const value of stringCorpus) {
    assert.equal(stringifyJsonString(value), JSON.stringify(value));
    assert.equal(stringifyJsonScalar(value), JSON.stringify(value));
  }
  for (const value of [0, -0, 1, -1.5, 1e21, 1e-8, Number.MAX_SAFE_INTEGER]) {
    assert.equal(String(stringifyJsonNumber(value)), JSON.stringify(value));
    assert.equal(stringifyJsonScalar(value), JSON.stringify(value));
  }
  assert.equal(stringifyJsonBoolean(true), 'true');
  assert.equal(stringifyJsonBoolean(false), 'false');
  assert.equal(stringifyJsonScalar(null), 'null');
  assert.equal(stringifyJsonScalar(undefined), 'null');
});

test('non-finite numbers fail closed instead of becoming JSON null', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => stringifyJsonNumber(value),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Serialization,
    );
    assert.throws(
      () => stringifyJsonScalar(value),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Serialization,
    );
  }
});

test('array stringify writes holes and undefined as null', () => {
  const values = [1, undefined, 3] as Array<number | undefined>;
  const sparse: Array<number | undefined> = [1];
  sparse[2] = 3;
  assert.equal(
    stringifyJsonArray(values, (item) => String(stringifyJsonNumber(item))),
    JSON.stringify(values),
  );
  assert.equal(
    stringifyJsonArray(sparse, (item) => String(stringifyJsonNumber(item))),
    JSON.stringify(sparse),
  );
});

test('generated stringify matches JSON.stringify for required, optional and array shapes', () => {
  const point: ModelTypeDescriptor = {
    kind: 'object',
    properties: { x: { kind: 'number' }, y: { kind: 'number' }, z: { kind: 'number' } },
    required: ['x', 'y', 'z'],
    additionalProperties: false,
  };
  const box: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      scale: point,
      label: { kind: 'string' },
      note: { kind: 'string' },
      ids: { kind: 'array', item: { kind: 'number' } },
    },
    required: ['scale', 'label', 'ids'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(point, 'Point3D');
  graph.intern(box, 'Box');
  graph.seal();
  const source = emitGraphStringify(graph);
  assert.doesNotMatch(source, /if \(true\)/, 'budget: no unconditionally-true guard is emitted for a required field');
  const boxBody = source.slice(source.indexOf('function stringifyBox'));
  assert.match(boxBody, /stringifyPoint3D\(/, 'one stringify function per interned node: Box calls stringifyPoint3D instead of inlining scale');
  assert.doesNotMatch(
    boxBody,
    /stringifyJsonNumber\([^;]*?\["x"\]/,
    'Point3D fields are not inlined into stringifyBox',
  );
  const { stringifyBox } = instantiate(source);
  const payload = {
    scale: { x: 1, y: 2, z: 3 },
    label: 'ascii',
    ids: [1, 2, 3],
  };
  assert.equal(stringifyBox(payload as never), JSON.stringify(payload));
  const withNote = { scale: payload.scale, label: payload.label, note: '"quoted"\\slash', ids: payload.ids };
  assert.equal(stringifyBox(withNote as never), JSON.stringify(withNote));
  const holes = { scale: payload.scale, label: payload.label, ids: Object.assign([1], { 2: 3 }) };
  assert.equal(stringifyBox(holes as never), JSON.stringify(holes));
  for (const label of stringCorpus) {
    const labeled = { scale: payload.scale, label, ids: payload.ids };
    assert.equal(stringifyBox(labeled as never), JSON.stringify(labeled));
  }
});

test('nullable nested objects stringify both populated and null values', () => {
  const account: ModelTypeDescriptor = {
    kind: 'object',
    properties: { id: { kind: 'number' }, code: { kind: 'string' } },
    required: ['id', 'code'],
    additionalProperties: false,
  };
  const customer: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      id: { kind: 'number' },
      account: { kind: 'union', variants: [account, { kind: 'null' }] },
      href: { kind: 'string' },
    },
    required: ['id', 'account', 'href'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(account, 'Account');
  graph.intern(customer, 'Customer');
  graph.seal();
  const source = emitGraphStringify(graph);
  const { stringifyCustomer } = instantiate(source);
  const present = { id: 101, account: { id: 601, code: 'customer-account-601' }, href: 'https://example.test/customers/101' };
  assert.equal(stringifyCustomer(present as never), JSON.stringify(present));
  const missing = { id: 101, account: null, href: 'https://example.test/customers/101' };
  assert.equal(stringifyCustomer(missing as never), JSON.stringify(missing));
});

test('tagged generated-model unions stringify the selected interned branch', () => {
  const email: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      kind: { kind: 'literal', value: 'email' },
      address: { kind: 'string' },
    },
    required: ['kind', 'address'],
    additionalProperties: false,
  };
  const phone: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      kind: { kind: 'literal', value: 'phone' },
      number: { kind: 'string' },
    },
    required: ['kind', 'number'],
    additionalProperties: false,
  };
  const book: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      contact: {
        kind: 'union',
        variants: [
          { kind: 'generated-model', id: 'Email' },
          { kind: 'generated-model', id: 'Phone' },
        ],
      },
    },
    required: ['contact'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(email, 'Email');
  graph.intern(phone, 'Phone');
  graph.intern(book, 'ContactBook');
  graph.seal();
  const source = emitGraphStringify(graph);
  const contactBookBody = source.slice(source.indexOf('function stringifyContactBook'));
  assert.match(contactBookBody, /stringifyEmail\(/, 'one stringify function per interned node: ContactBook calls stringifyEmail instead of inlining it');
  assert.match(contactBookBody, /stringifyPhone\(/, 'one stringify function per interned node: ContactBook calls stringifyPhone instead of inlining it');
  assert.match(
    contactBookBody,
    /\+ \(/,
    'budget: the union dispatch is a single ternary expression concatenated into the return, not a per-branch if/else statement sequence',
  );
  const { stringifyContactBook } = instantiate(source);
  const withEmail = { contact: { kind: 'email', address: 'one@example.test' } };
  const withPhone = { contact: { kind: 'phone', number: '123' } };
  assert.equal(stringifyContactBook(withEmail as never), JSON.stringify(withEmail));
  assert.equal(stringifyContactBook(withPhone as never), JSON.stringify(withPhone));
});

test('an explicit union tag table must list every variant', () => {
  const graph = createSchemaGraph();
  graph.intern({ kind: 'object', properties: { kind: { kind: 'string' } }, required: ['kind'], additionalProperties: false }, 'Cat');
  const owner: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      pet: {
        kind: 'union',
        variants: [{ kind: 'generated-model', id: 'Cat' }, { kind: 'null' }],
        discriminator: { propertyName: 'kind', variants: [{ values: ['cat'] }] },
      },
    },
    required: ['pet'],
    additionalProperties: false,
  };
  assert.throws(() => {
    graph.intern(owner, 'Owner');
    graph.seal();
    emitCodecRuntime(graph, { validationEnabled: false });
  }, /tag values for every (union )?variant/);
});

