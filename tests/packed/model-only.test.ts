import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { command, npm, cli } from '../support/process.js';
import { startRegistry, packageSpec, type PackedRegistry } from '../../scripts/packed-registry.js';
import { AJV_FORMATS_PINNED, AJV_PINNED } from '../../scripts/third-party-installs.js';
import { copyFixture, copyFixtureFile } from '../fixture-project.js';

let registry: PackedRegistry;
before(async () => { registry = await startRegistry(); });
after(async () => { if (registry) await registry.close(); });

test('model-only packed installation validates structure with no OpenAPI or MobX runtime', async t => {
  const root = registry.create(t, 'model-only');
  await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/model-codegen')]);
  await npm(root, ['install', '--save-prod', packageSpec(registry, '@exprtlabs/codegen'), AJV_PINNED, AJV_FORMATS_PINNED]);
  copyFixture(root, 'packed/model-only');
  await cli(root, ['generate']);
  copyFixtureFile(root, 'packed/model-only-after-generation/item.model.ts', 'src/item.model.ts');
  await cli(root, ['generate']);
  await command(root, path.join(root, 'node_modules/.bin/ttsc'), ['-p', 'tsconfig.json']);
  await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
  for (const name of ['mobx', 'typescript', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts']) assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} should not be installed`);
  await command(root, process.execPath, ['verify.mjs']);
  const browser = await build({ entryPoints: [path.join(root, 'build/item.model.js')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.doesNotMatch(Object.keys(browser.metafile.inputs).join('\n'), /node:|\/tooling\/|\/mobx\//);
});
