import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { validateModelManifest } from '@exprtlabs/golem/manifest';
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

test('every model manifest entry carries the codec id a rewrite stamps, and validation refuses a manifest without it and says to regenerate', async t => {
  const output = path.join(createFixtureProject(t, 'golem-manifest-codec-'), 'sdk');
  const result = await generateMaterializedSdk(document, { output, name: 'Manifest', profile: { mobx: false, validation: true } });
  const manifest = JSON.parse(result.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as {
    models: { codecId?: string; type: { export: string } }[];
  };
  const ids = new Map(manifest.models.map(entry => [entry.type.export, entry.codecId]));
  for (const name of ['Open', 'Closed', 'Map']) assert.match(ids.get(name) ?? '', new RegExp(`^${name}_[0-9a-f]{8}$`), `${name} has a codec id`);
  assert.equal(new Set(ids.values()).size, ids.size, 'codec ids differ between models');

  assert.doesNotThrow(() => validateModelManifest(manifest));
  const older = { ...manifest, models: manifest.models.map(({ codecId: _codecId, ...entry }) => entry) };
  assert.throws(() => validateModelManifest(older, 'sdk/model-manifest.json'), new RegExp(`Invalid model manifest sdk/model-manifest\\.json: model entry ${manifest.models[0]!.type.export} has no codecId\\. Regenerate the SDK with this golem version\\.`));
  const empty = { ...manifest, models: manifest.models.map(entry => ({ ...entry, codecId: '' })) };
  assert.throws(() => validateModelManifest(empty), /Invalid model entry/);
});

test('a manifest profile with a field golem no longer reads is rejected and says to regenerate', () => {
  const profile = { mobx: false, validation: true, allowAny: false, retiredOption: true };
  assert.throws(
    () => validateModelManifest({ profile, models: [] }, 'sdk/model-manifest.json'),
    /Invalid model manifest sdk\/model-manifest\.json: profile has unsupported field\(s\): retiredOption\. Regenerate or remove the older generated SDK\./,
  );
});
