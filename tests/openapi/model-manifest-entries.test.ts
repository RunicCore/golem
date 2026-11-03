import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import { validateModelManifest } from '@exprtlabs/golem/manifest';
import { generate as generateModels } from '#model/generator';
import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import { createModelProject } from '../model-project.js';
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
  const result = await generateMaterializedSdk(document, { output, name: 'Manifest', profile: { validation: true } });
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
  const result = await generateMaterializedSdk(document, { output, name: 'Manifest', profile: { validation: true } });
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

test('a manifest error names an absolute manifest file relative to the working directory', () => {
  // protects: T-375 messages print a local file relative to the working directory
  const beside = path.join(path.dirname(process.cwd()), 'other/model-manifest.json');
  assert.throws(() => validateModelManifest({ profile: { validation: true, allowAny: false }, models: 'none' }, beside), {
    message: 'Invalid model manifest ../other/model-manifest.json: models must be an array.',
  });
});

test('a manifest profile with a field golem no longer reads is rejected and says to regenerate', () => {
  const profile = { validation: true, allowAny: false, retiredOption: true };
  assert.throws(
    () => validateModelManifest({ profile, models: [] }, 'sdk/model-manifest.json'),
    /Invalid model manifest sdk\/model-manifest\.json: profile has unsupported field\(s\): retiredOption\. Regenerate or remove the older generated SDK\./,
  );
});

test('an SDK generated at validation sanity records sanity in its manifest, and the manifest reader takes true, false and sanity only', async t => {
  // protects: T-663 SDK manifests record the sanity level and the reader accepts it
  const output = path.join(createFixtureProject(t, 'golem-manifest-sanity-'), 'sdk');
  const result = await generateMaterializedSdk(document, { output, name: 'Manifest', profile: { validation: 'sanity' } });
  const manifest = JSON.parse(result.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as { profile?: unknown };
  assert.deepEqual(manifest.profile, { allowAny: false, unknownFormats: 'error', validation: 'sanity' });
  assert.doesNotThrow(() => validateModelManifest(manifest));
  for (const validation of [true, false, 'sanity']) {
    assert.equal(validateModelManifest({ profile: { validation, allowAny: false }, models: [] }).profile.validation, validation);
  }
  assert.throws(
    () => validateModelManifest({ profile: { validation: 'full', allowAny: false }, models: [] }, 'sdk/model-manifest.json'),
    /Invalid model manifest sdk\/model-manifest\.json: profile must include validation and an allowAny boolean \(validation may also be "sanity"\)\. Regenerate the models\./,
  );
});

const BASE_PROFILE = { validation: true, allowAny: false, unknownFormats: 'error' } as const;

/** A project that generates its models against one SDK manifest holding `manifestProfile`; returns the call with the project profile. */
function modelsAgainstManifest(t: test.TestContext, manifestProfile: Record<string, unknown>) {
  const { root } = createModelProject(t, { prefix: 'golem-manifest-extensions-', name: 'manifest-extensions' });
  const manifest = path.join(root, 'external-model-manifest.json');
  const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/x.model.ts');
  fs.writeFileSync(manifest, JSON.stringify({ profile: manifestProfile, models: [] }));
  return (extensions?: Record<string, Record<string, unknown>>) => generateModels({ root, sources: [source], profile: { ...BASE_PROFILE, ...(extensions ? { extensions } : {}) }, manifestInputs: [manifest] });
}

test('an SDK manifest records the extension settings of the profile by package name, and writes no key for none', async t => {
  // protects: T-782 profile.extensions records the settings by package name; no extension writes no key
  const output = path.join(createFixtureProject(t, 'golem-manifest-extension-record-'), 'sdk');
  const manifestProfile = async (profile: Record<string, unknown>) => {
    const result = await generateMaterializedSdk(document, { output, name: 'Manifest', profile: { validation: true, ...profile } });
    return (JSON.parse(result.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as { profile: unknown }).profile;
  };
  assert.deepEqual(await manifestProfile({ extensions: { '@scope/pack': { level: 2, mode: 'fast' } } }), {
    allowAny: false, extensions: { '@scope/pack': { level: 2, mode: 'fast' } }, unknownFormats: 'error', validation: true,
  });
  assert.deepEqual(await manifestProfile({ extensions: {} }), { allowAny: false, unknownFormats: 'error', validation: true });
  assert.deepEqual(await manifestProfile({}), { allowAny: false, unknownFormats: 'error', validation: true });
});

test('the models job accepts an SDK manifest whose extension settings equal the project settings, whatever their key order, and one written before extensions existed when the project has none', t => {
  // protects: T-782 extension settings compare as stable JSON; a missing key means not used
  const manifestProfile = { ...BASE_PROFILE, extensions: { '@scope/pack': { b: [1, { y: 2, x: 1 }], a: 'on' } } };
  const generateWith = modelsAgainstManifest(t, manifestProfile);
  assert.doesNotThrow(() => generateWith({ '@scope/pack': { a: 'on', b: [1, { x: 1, y: 2 }] } }));
  const older = modelsAgainstManifest(t, BASE_PROFILE);
  assert.doesNotThrow(() => older());
  assert.doesNotThrow(() => older({}));
});

test('the models job refuses an SDK manifest whose extension settings differ from the project and names the package and both values', t => {
  // protects: T-782 a different extension setting makes the profile differ
  const manifestProfile = { ...BASE_PROFILE, extensions: { '@scope/pack': { mode: 'fast' }, '@scope/other': { on: true } } };
  const generateWith = modelsAgainstManifest(t, manifestProfile);
  assert.throws(
    () => generateWith({ '@scope/pack': { mode: 'slow' }, '@scope/other': { on: true } }),
    /profile mismatch in .*: extensions of @scope\/pack: manifest \{"mode":"fast"\}, project \{"mode":"slow"\}\. The project expects \{ validation: true, allowAny: false, unknownFormats: error, extensions: \{"@scope\/other":\{"on":true\},"@scope\/pack":\{"mode":"slow"\}\} \}\./,
  );
  assert.throws(() => generateWith({ '@scope/pack': { mode: 'fast' } }), /extensions of @scope\/other: manifest \{"on":true\}, project not used\./);
  const older = modelsAgainstManifest(t, BASE_PROFILE);
  assert.throws(() => older({ '@scope/pack': { mode: 'fast' } }), /extensions of @scope\/pack: manifest not used, project \{"mode":"fast"\}\./);
});

test('the manifest reader keeps an older profile without extensions and refuses extensions that are no object per package', () => {
  // protects: T-782 an older manifest reads as no extensions
  assert.deepEqual(validateModelManifest({ profile: { validation: true, allowAny: false }, models: [] }).profile, { validation: true, allowAny: false });
  assert.deepEqual(validateModelManifest({ profile: { validation: true, allowAny: false, extensions: { '@scope/pack': { a: 1 } } }, models: [] }).profile.extensions, { '@scope/pack': { a: 1 } });
  assert.throws(
    () => validateModelManifest({ profile: { validation: true, allowAny: false, extensions: { '@scope/pack': true } }, models: [] }, 'sdk/model-manifest.json'),
    /Invalid model manifest sdk\/model-manifest\.json: profile extensions must map a package name to an object of settings\. Regenerate the models\./,
  );
});
