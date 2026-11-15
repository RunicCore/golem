import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, importGeneratedModule, sdkBodyCodec, withRootOperations } from './helpers.js';
import { dateTime, object, operation, ref } from './schema-builders.js';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
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
  await generateMaterializedSdk(withRootOperations(document, 'Report'), { output, name: 'RecursiveWire', profile: { validation: true } });
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

// Entry composes Base with allOf and holds itself: it stays a model of its own group, so Ledger's wire write cannot write it in place.
const composedDocument = {
  openapi: '3.1.0',
  info: { title: 'ComposedWire', version: '1' },
  paths: { '/ledgers': operation('createLedger', 'Ledger') },
  components: {
    schemas: {
      Ledger: object({ at: dateTime, entry: ref('Entry') }, ['at', 'entry']),
      Base: object({ at: dateTime }, ['at']),
      Entry: { allOf: [ref('Base'), object({ closed: dateTime, children: { type: 'array', items: ref('Entry') } }, ['closed'])] },
    },
  },
};

test('a model with a date writes the date of a composed recursive model of another group as its wire value', async t => {
  // protects: T-915 the wire write of an imported composed model called its model stringify on an encoded date
  const output = path.join(createFixtureProject(t, 'golem-openapi-composed-wire-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(composedDocument, 'Ledger'), { output, name: 'ComposedWire', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const ledger = await sdkBodyCodec(output, 'ComposedWire', 'Ledger');

  const wire = {
    at: '2025-01-02T03:04:05.000Z',
    entry: { at: '2025-02-03T04:05:06.000Z', closed: '2025-03-04T05:06:07.000Z', children: [{ at: '2025-04-05T06:07:08.000Z', closed: '2025-05-06T07:08:09.000Z' }] },
  };
  const models = path.join(output, 'dist/models');
  const stringifyLedgers = await Promise.all(readdirSync(models).filter(file => file.startsWith('_group') && file.endsWith('.js'))
    .map(async file => (await importGeneratedModule(output, file, `dist/models/${file}`))['stringifyLedger']));
  const stringifyLedger = stringifyLedgers.find(candidate => typeof candidate === 'function') as (value: unknown) => string;
  assert.deepEqual(JSON.parse(stringifyLedger(await ledger.decode(wire))), wire);
});
