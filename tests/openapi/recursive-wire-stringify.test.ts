import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, readGeneratedModelSource, requireRecord } from './helpers.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { LibError } from '@exprtlabs/golem/errors';

const dateTime = { type: 'string', format: 'date-time' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', required, properties });

// Report is a model with a date, so its stringify writes the encoded wire value. It holds a recursive model that lives
// in another module: Tree has no date (its wire form equals its model form), Dated has one (its wire form differs), and
// Node is a oneOf of plain objects, one of which holds the oneOf again.
const document = {
  openapi: '3.1.0',
  info: { title: 'RecursiveWire', version: '1' },
  paths: {
    '/reports': {
      post: {
        operationId: 'createReport',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Report') } } },
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref('Report') } } } },
      },
    },
  },
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

test('a model with a date writes a recursive model or oneOf of another module, with and without a date, and rejects an invalid nested value', async t => {
  // protects: T-200 recursive oneOf/object under a dated model generates with validation on
  const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-wire-'), 'sdk');
  await generateMaterializedSdk(document, { output, name: 'RecursiveWire', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  // Only a recursive model's wire stringify is exported: Report is not recursive.
  assert.doesNotMatch(readGeneratedModelSource(output), /export \{ stringifyReport\w*Wire as /);
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
  const stringifyReport = models.stringifyReport as (value: unknown) => string;
  const parseReport = models.parseReport as (text: string) => unknown;

  const wire = {
    at: '2025-01-02T03:04:05.000Z',
    tree: { name: 'root', children: [{ name: 'leaf' }] },
    dated: { at: '2025-02-03T04:05:06.000Z', children: [{ at: '2025-03-04T05:06:07.000Z', children: [] }] },
    node: { kind: 'Branch', children: [{ kind: 'Leaf', value: 'a' }, { kind: 'Branch', children: [] }] },
  };
  const text = stringifyReport(parseReport(JSON.stringify(wire)));
  assert.deepEqual(JSON.parse(text), wire);

  const invalid = parseReport(JSON.stringify(wire)) as { tree: { children: { name: unknown }[] } };
  invalid.tree.children[0].name = 7;
  assert.throws(() => stringifyReport(invalid), (error: unknown) => error instanceof LibError);

  const invalidNode = parseReport(JSON.stringify(wire)) as { node: { children: { value: unknown }[] } };
  invalidNode.node.children[0].value = 7;
  assert.throws(() => stringifyReport(invalidNode), (error: unknown) => error instanceof LibError);
});
