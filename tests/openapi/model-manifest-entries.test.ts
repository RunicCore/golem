import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import { generateMaterializedSdk } from './helpers.js';

const document = {
  openapi: '3.1.0',
  info: { title: 'Manifest', version: '1' },
  paths: {},
  components: {
    schemas: {
      Open: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      Closed: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      Map: { type: 'object', additionalProperties: { type: 'number' } },
    },
  },
};

test('model manifest entries carry no top-level additionalProperties; field descriptors own that fact', async t => {
  const output = path.join(createFixtureProject(t, 'golem-manifest-entries-'), 'sdk');
  const result = await generateMaterializedSdk(document, { output, name: 'Manifest', profile: { mobx: false, validation: true } });
  const manifest = JSON.parse(result.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as {
    models?: { id?: unknown; type?: { export?: string } }[];
  };
  const models = manifest.models ?? [];
  const exported = models.map(entry => entry.type?.export);
  assert.ok(exported.includes('Open'), 'Open is recorded');
  assert.ok(exported.includes('Closed'), 'Closed is recorded');
  for (const entry of models) {
    assert.equal(Object.hasOwn(entry, 'additionalProperties'), false, `${String(entry.id)} has no additionalProperties key`);
  }
});
