// The extension settings that change generated code reach the manifest an SDK job writes. The test packages are tests/fixtures/extensions/probe (extension `mark`, no
// flag) and tests/fixtures/extensions/profiled (extension `shape`, registered with `profile: true`).
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { resolveConfig } from '#golem/config';
import { runPipeline } from '#golem/cli';

import { copyFixture, linkGolemPackages, listProjectDependencies } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { generateMaterializedSdk } from './openapi/helpers.js';
import { write } from './support/build-project.js';

const DOCUMENT = { openapi: '3.1.0', info: { title: 'Manifest', version: '1' }, paths: {}, components: { schemas: { Open: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } } };

/** The profile that `resolveConfig` gives for a project with the two test packages installed and `blocks` after `model: {}` in its golem.yaml. */
async function profileOf(t: TestContext, blocks: string): Promise<{ readonly root: string; readonly profile: Awaited<ReturnType<typeof resolveConfig>>['profile'] }> {
  const { root } = createModelProject(t, { prefix: 'golem-profile-extensions-', name: 'profile-extensions' });
  copyFixture(path.join(root, 'node_modules/@fixture/probe'), 'extensions/probe');
  copyFixture(path.join(root, 'node_modules/@fixture/profiled'), 'extensions/profiled');
  listProjectDependencies(root, ['@fixture/probe', '@fixture/profiled']);
  write(root, 'golem.yaml', `version: 1\nmodel: {}\n${blocks}`);
  return { root, profile: (await resolveConfig(path.join(root, 'golem.yaml'))).profile };
}

/** The `profile` that the SDK job writes into model-manifest.json for `profile`. */
async function manifestProfile(root: string, profile: Awaited<ReturnType<typeof profileOf>>['profile']): Promise<unknown> {
  const result = await generateMaterializedSdk(DOCUMENT, { output: path.join(root, 'sdk'), name: 'Manifest', profile });
  return (JSON.parse(result.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as { profile: unknown }).profile;
}

test('a project that turns on a flagged extension writes its options, as golem.yaml has them, into the manifest profile', async (t) => {
  // protects: T-782 the manifest records the options of an extension registered with profile: true, by package and extension name
  const { root, profile } = await profileOf(t, 'probe:\n  extensions:\n    mark:\n      label: probe\nprofiled:\n  extensions:\n    shape:\n      precision: 2\n      names: [b, a]\n');

  assert.deepEqual(profile.extensions, { '@fixture/profiled': { shape: { precision: 2, names: ['b', 'a'] } } });
  assert.deepEqual(await manifestProfile(root, profile), {
    allowAny: false,
    extensions: { '@fixture/profiled': { shape: { names: ['b', 'a'], precision: 2 } } },
    unknownFormats: 'error',
    validation: true,
  });
});

test('an extension with no profile flag writes no extensions key into the manifest profile', async (t) => {
  // protects: T-782 a rewrite-only extension adds nothing to the profile, so a manifest written before the key existed still matches
  const { root, profile } = await profileOf(t, 'probe:\n  extensions:\n    mark:\n      label: probe\n');

  assert.equal(Object.hasOwn(profile, 'extensions'), false);
  assert.deepEqual(await manifestProfile(root, profile), { allowAny: false, unknownFormats: 'error', validation: true });
});

test('a flagged extension turned on with no options is recorded as used, with no settings', async (t) => {
  // protects: T-782 "used with no options" and "not used" differ in the manifest profile
  const { profile } = await profileOf(t, 'profiled:\n  extensions:\n    shape:\n');

  assert.deepEqual(profile.extensions, { '@fixture/profiled': { shape: {} } });
});

test('generate and check pass for a project with a flagged extension and a golem SDK job', async (t) => {
  // protects: T-786 the profile an SDK writes into its manifest is compared by value, so an extension record does not stop every run
  const { root } = createModelProject(t, { prefix: 'golem-profile-sdk-', name: 'profile-sdk' });
  copyFixture(path.join(root, 'node_modules/@fixture/profiled'), 'extensions/profiled');
  linkGolemPackages(root, ['golem-openapi-ts']);
  listProjectDependencies(root, ['@fixture/profiled']);
  write(root, 'api/payments.json', JSON.stringify(DOCUMENT));
  write(root, 'golem.yaml', 'version: 1\nmodel: {}\nprofiled:\n  extensions:\n    shape:\n      precision: 2\nopenapi-ts:\n  sdks:\n    - input: api/payments.json\n      output: sdk\n      mode: golem\n');
  const config = path.join(root, 'golem.yaml');

  await runPipeline(config);
  await runPipeline(config, { check: true });
});
