import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, sdkBodyCodec, withRootOperations } from './helpers.js';
import { dateTime, object, operation, ref } from './schema-builders.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LibError } from '@exprtlabs/golem/errors';

// Report is a model with a date, so its stringify writes the encoded wire value. It holds a recursive model that lives
// in another module: Tree has no date (its wire form equals its model form), Dated has one (its wire form differs), and
// Node is a oneOf of plain objects, one of which holds the oneOf again.
const document = {
  openapi: '3.1.0',
  info: { title: 'RecursiveWire', version: '1' },
  paths: { '/reports': operation('createReport', 'Report') },
  components: {
    schemas: {
      Report: object({ at: dateTime, tree: ref('Tree'), dated: ref('Dated'), node: ref('Node') }, ['at', 'tree', 'dated', 'node']),
      Tree: object({ name: { type: 'string' }, children: { type: 'array', items: ref('Tree') } }, ['name']),
      Node: { oneOf: [ref('Leaf'), ref('Branch')], discriminator: { propertyName: 'kind' } },
      Leaf: object({ kind: { const: 'Leaf' }, value: { type: 'string' } }, ['kind', 'value']),
      Branch: object({ kind: { const: 'Branch' }, children: { type: 'array', items: ref('Node') } }, ['kind', 'children']),
      Dated: object({ at: dateTime, children: { type: 'array', items: ref('Dated') } }, ['at']),
    },
  },
};

test('a body with a date writes a recursive object or oneOf, with and without a date, and rejects an invalid nested value', async t => {
  // protects: T-200 recursive oneOf/object under a dated model generates with validation on
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-wire-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(document, 'Report'), { output, name: 'RecursiveWire', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const report = await sdkBodyCodec(output, 'RecursiveWire', 'Report');

  const wire = {
    at: '2025-01-02T03:04:05.000Z',
    tree: { name: 'root', children: [{ name: 'leaf' }] },
    dated: { at: '2025-02-03T04:05:06.000Z', children: [{ at: '2025-03-04T05:06:07.000Z', children: [] }] },
    node: { kind: 'Branch', children: [{ kind: 'Leaf', value: 'a' }, { kind: 'Branch', children: [] }] },
  };
  const decoded = await report.decode(wire);
  assert.deepEqual(await report.encode(decoded), wire);

  const isLibError = (error: unknown): boolean => error instanceof LibError;
  const invalid = structuredClone(decoded) as { tree: { children: { name: unknown }[] } };
  invalid.tree.children[0]!.name = 7;
  await assert.rejects(() => report.encode(invalid), isLibError);

  const invalidNode = structuredClone(decoded) as { node: { children: { value: unknown }[] } };
  invalidNode.node.children[0]!.value = 7;
  await assert.rejects(() => report.encode(invalidNode), isLibError);
});
