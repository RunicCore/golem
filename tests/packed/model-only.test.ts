import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { command, npm, cli } from '../support/process.js';
import { packageSpec } from '../../scripts/packed-registry.js';
import { distTagForVersion } from '../../packages/golem/src/tooling/dist-tag.js';
import { copyFixture, copyFixtureFile } from '../fixture-project.js';
import { usePackedRegistry } from '../support/packed-registry.js';

const registry = usePackedRegistry();

test('model-only packed installation validates structure with no OpenAPI or MobX runtime', async t => {
  const root = registry().create(t, 'model-only');
  await npm(root, ['install', '--save-dev', packageSpec(registry(), '@exprtlabs/golem-model')]);
  await npm(root, ['install', '--save-prod', packageSpec(registry(), '@exprtlabs/golem')]);
  copyFixture(root, 'packed/model-only');
  await cli(root, ['generate']);
  copyFixtureFile(root, 'packed/model-only-after-generation/item.model.ts', 'src/item.model.ts');
  await cli(root, ['generate']);
  await cli(root, ['build']);
  await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
  for (const name of ['mobx', 'typescript', '@exprtlabs/golem-model', '@exprtlabs/golem-openapi']) assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} should not be installed`);
  await command(root, process.execPath, ['verify.mjs']);
  const browser = await build({ entryPoints: [path.join(root, 'build/item.model.js')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.doesNotMatch(Object.keys(browser.metafile.inputs).join('\n'), /node:|\/tooling\/|\/mobx\//);
});

test('packed manifests and tarballs carry the release contract', () => {
  for (const [name, entry] of registry().packages) {
    assert.equal(entry.manifest.version, registry().workspaceVersion);
    if (name === '@exprtlabs/golem') assert.deepEqual(Object.keys(entry.manifest.bin ?? {}), ['golem']);
    else assert.equal(entry.manifest.bin, undefined);
    assert.equal(entry.manifest.license, 'MIT');
    assert.ok(entry.pack.files.some(file => file.path === 'LICENSE'));
    assert.ok(entry.pack.files.every(file => !/(?:^|\/)(?:docs?|assets?|\.vitepress|vitepress|vue|node_modules)(?:\/|$)/i.test(file.path)), name);
  }
  assert.deepEqual(registry().distTags, { [distTagForVersion(registry().workspaceVersion)]: registry().workspaceVersion });
});
