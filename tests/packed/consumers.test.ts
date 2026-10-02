import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { workspace, command, npm, cli } from '../support/process.js';
import { writeFixture, filesUnder } from '../support/consumer.js';
import { startRegistry, packageSpec, type PackedRegistry } from '../../scripts/packed-registry.js';
import { AJV, AJV_FORMATS, ESBUILD, MOBX, NEST_COMMON, NEST_SWAGGER, TYPESCRIPT } from '../../scripts/third-party-installs.js';
import { copyFixture, copyFixtureFile } from '../fixture-project.js';

let registry: PackedRegistry;
before(async () => { registry = await startRegistry(); });
after(async () => { if (registry) await registry.close(); });

test('packed binary ownership survives either generator installation order and uninstall', async t => {
  for (const order of [
    ['golem-model', 'golem-openapi'], ['golem-openapi', 'golem-model'],
    ['golem-ts-openapi', 'golem-model', 'golem-openapi'],
  ]) {
    const root = registry.create(t, order[0]);
    for (const name of order) {
      await npm(root, ['install', '--save-dev', packageSpec(registry, `@exprtlabs/${name}`)]);
      const help = await cli(root, ['--help']);
      assert.match(help.stdout, /Usage: golem /);
      assert.equal(fs.lstatSync(path.join(root, 'node_modules/@exprtlabs/golem')).isSymbolicLink(), false);
    }
    await npm(root, ['uninstall', `@exprtlabs/${order[0]}`]);
    assert.match((await cli(root, ['--help'])).stdout, /golem/);
    assert.equal(fs.existsSync(path.join(root, 'node_modules/@exprtlabs', order[1])), true);
  }
});

test('packed controller generator installs independently and resolves real Nest and Swagger packages', async t => {
  const root = registry.create(t, 'controller-only');
  await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/golem-ts-openapi'), NEST_COMMON, NEST_SWAGGER]);
  copyFixture(root, 'packed/controller-only');
  await cli(root, ['generate']);
  await cli(root, ['check']);
  const document = JSON.parse(fs.readFileSync(path.join(root, 'generated/openapi.json'), 'utf8')) as { openapi: string };
  assert.equal(document.openapi, '3.2.0');
  assert.equal(fs.existsSync(path.join(root, 'node_modules/@exprtlabs/golem-model')), false);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/@exprtlabs/golem-openapi')), false);
  for (const name of ['mobx', 'ajv', 'ajv-formats']) {
    assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} must not be installed`);
  }
  assert.equal(fs.existsSync(path.join(root, 'node_modules/.bin/golem')), true);
  assert.equal(fs.lstatSync(path.join(root, 'node_modules/@exprtlabs/golem')).isSymbolicLink(), false);
  const golemManifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@exprtlabs/golem/package.json'), 'utf8')) as { bin?: Record<string, string> };
  assert.deepEqual(Object.keys(golemManifest.bin ?? {}), ['golem']);
});

for (const profile of [
  { mobx: false, validation: false, ajvStandalone: false },
  { mobx: false, validation: true, ajvStandalone: false },
  { mobx: true, validation: false, ajvStandalone: false },
  { mobx: true, validation: true, ajvStandalone: false },
  { mobx: true, validation: true, ajvStandalone: true },
]) {
  test(`packed SDK and frontend model compose with mobx=${profile.mobx}, validation=${profile.validation}, standalone=${profile.ajvStandalone}`, async t => {
    const root = registry.create(t, `profile-${profile.mobx}-${profile.validation}-${profile.ajvStandalone}`);
    await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/golem-model'), packageSpec(registry, '@exprtlabs/golem-openapi')]);
    if (profile.ajvStandalone) await npm(root, ['install', '--save-dev', ESBUILD]);
    const production = [packageSpec(registry, '@exprtlabs/golem')];
    if (profile.mobx) production.push(MOBX);
    if (profile.validation) production.push(AJV, AJV_FORMATS);
    await npm(root, ['install', '--save-prod', ...production]);
    writeFixture(root, profile);
    await cli(root, ['generate']);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sdk/model-manifest.json'), 'utf8'));
    assert.equal(Object.hasOwn(manifest, 'manifestVersion'), false);
    assert.deepEqual(manifest.profile, { ...profile, allowAny: false });
    const packedVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@exprtlabs/golem/package.json'), 'utf8')).version;
    assert.deepEqual(manifest.runtime, { name: '@exprtlabs/golem', minimumVersion: packedVersion });
    copyFixtureFile(root, profile.mobx ? 'packed/profile-mobx-after-generation/cart.model.ts' : 'packed/profile-after-generation/cart.model.ts', 'src/cart.model.ts');
    await cli(root, ['generate']);
    const generated = [...filesUnder(path.join(root, 'sdk')), path.join(root, 'src/cart.model.generated.ts'), path.join(root, '.golem/outputs.json')];
    const before = new Map(generated.map(filename => [filename, { content: fs.readFileSync(filename, 'utf8'), mtime: fs.statSync(filename).mtimeMs }]));
    await cli(root, ['check']);
    await command(root, process.execPath, [path.join(root, 'node_modules/@exprtlabs/golem/dist/bin/golem.js'), 'check']);
    await cli(root, ['generate']);
    for (const [filename, old] of before) {
      assert.equal(fs.readFileSync(filename, 'utf8'), old.content, filename);
      assert.equal(fs.statSync(filename).mtimeMs, old.mtime, filename);
    }
    const text = generated.filter(filename => filename.endsWith('.ts')).map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
    const generatedImports = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map(match => match[1] ?? match[2]);
    assert.ok(generatedImports.length > 0);
    assert.ok(generatedImports.every(source => source.startsWith('./') || source.startsWith('../') || source.startsWith('@exprtlabs/golem/')), generatedImports.join('\n'));
    for (const absent of ['inbound.ts', 'links.ts']) assert.equal(fs.existsSync(path.join(root, 'sdk', absent)), false);
    if (!profile.mobx) assert.doesNotMatch(text, /asGenObservable|ModelAnnotations|@exprtlabs\/golem\/mobx/);
    if (!profile.validation) assert.doesNotMatch(text, /\$validator|runtimeSchemaRegistry|@exprtlabs\/golem\/(?:validation|ajv|mobx-validation)/);
    await command(root, path.join(root, 'node_modules/.bin/ttsc'), ['-p', 'tsconfig.json']);
    await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
    for (const name of ['typescript', '@redocly/openapi-core', '@exprtlabs/golem-model', '@exprtlabs/golem-openapi']) assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} leaked into production`);
    if (!profile.mobx) assert.equal(fs.existsSync(path.join(root, 'node_modules/mobx')), false);
    if (!profile.validation) assert.equal(fs.existsSync(path.join(root, 'node_modules/ajv')), false);
    copyFixtureFile(root, 'packed/profile/verify-profile.mjs', 'verify-profile.mjs');
    copyFixtureFile(root, 'packed/profile/browser-exports.ts', 'browser-exports.ts');
    fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify(profile));
    await command(root, process.execPath, ['verify-profile.mjs']);
    await command(root, process.execPath, ['verify-profile.mjs']);
    const browser = await build({ entryPoints: [path.join(root, 'browser-exports.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
    const modules = Object.keys(browser.metafile.inputs).join('\n');
    assert.doesNotMatch(modules, /node:|\/tooling\/|\/typescript\/|\/@redocly\//);
    if (!profile.mobx) assert.doesNotMatch(modules, /\/mobx\//);
    if (!profile.validation) assert.doesNotMatch(modules, /\/ajv(?:-formats)?\//);
    if (!profile.validation) assert.doesNotMatch(modules, /\/(?:validation|validation-runner|schema)\.js/);
  });
}

test('packed OpenAPI-only install generates without loading the model generator', async t => {
  const root = registry.create(t, 'openapi-only');
  await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/golem-openapi')]);
  writeFixture(root, { mobx: false, validation: false }, false);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/@exprtlabs/golem-model')), false);
  await cli(root, ['generate']);
  await cli(root, ['check']);
  await npm(root, ['install', '--save-dev', TYPESCRIPT]);
  await cli(root, ['build']);
});

test('CLI resolves configured providers from a project with spaces outside cwd and never downloads missing providers', async t => {
  const root = registry.create(t, 'resolver with spaces');
  await npm(root, ['install', '--save-prod', packageSpec(registry, '@exprtlabs/golem')]);
  writeFixture(root, { mobx: false, validation: false }, false);
  const config = path.join(root, 'golem.yaml');
  const binary = path.join(root, 'node_modules/.bin/golem');
  const before = registry.requests.length;
  const missing = await command(workspace, binary, ['generate', '--config', config], { allowFailure: true });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /openapi is configured.*not installed/);
  assert.equal(registry.requests.length, before);
  assert.equal(fs.existsSync(path.join(root, 'sdk')), false);

  await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/golem-openapi')]);
  await command(workspace, binary, ['generate', '--config', config]);
  await command(workspace, process.execPath, [binary, 'check', '--config', config]);

  // Executable loading does not inherit the consuming project's module format.
  const manifest: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.type = 'commonjs';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  await command(workspace, binary, ['check', '--config', config]);

  const provider = path.join(root, 'node_modules/@exprtlabs/golem-openapi');
  copyFixtureFile(provider, 'packed/incompatible-provider/package.json', 'package.json');
  // The runtime version check runs before the provider loads, so the fake needs the packed release version.
  const providerManifest: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(provider, 'package.json'), 'utf8'));
  const packedRelease: { version: string } = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@exprtlabs/golem/package.json'), 'utf8'));
  fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ ...providerManifest, version: packedRelease.version }));
  copyFixtureFile(provider, 'packed/incompatible-provider/incompatible.js', 'incompatible.js');
  const beforeIncompatible = registry.requests.length;
  const incompatible = await command(workspace, binary, ['check', '--config', config], { allowFailure: true });
  assert.match(incompatible.stderr, /Incompatible generator.*API 1.*99/);
  assert.equal(registry.requests.length, beforeIncompatible);
});

test('packed public generator declarations retain synchronous models and asynchronous OpenAPI API-1 fields', async t => {
  const root = registry.create(t, 'declarations');
  await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/golem-model'), packageSpec(registry, '@exprtlabs/golem-openapi')]);
  copyFixture(root, 'packed/declarations');
  await command(root, path.join(root, 'node_modules/.bin/ttsc'), ['-p', 'tsconfig.contracts.json']);
});


test('packed standalone model and SDK validators work without optional compiler peers', async t => {
  const root = registry.create(t, 'standalone-runtime');
  await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/golem-model'), packageSpec(registry, '@exprtlabs/golem-openapi'), AJV, AJV_FORMATS], { includeOptional: true });
  await npm(root, ['install', '--save-prod', packageSpec(registry, '@exprtlabs/golem')]);
  copyFixture(root, 'packed/standalone-runtime');
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  await cli(root, ['generate']);
  copyFixtureFile(root, 'packed/standalone-runtime-after-generation/cart.model.ts', 'src/cart.model.ts');
  await cli(root, ['generate']);
  await cli(root, ['check']);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sdk/model-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.profile, { mobx: false, validation: true, ajvStandalone: true, allowAny: false });
  const generatedText = [...filesUnder(path.join(root, 'sdk')), path.join(root, 'src/cart.model.generated.ts')]
    .filter(filename => filename.endsWith('.ts')).map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
  assert.doesNotMatch(generatedText, /asGenObservable|ModelAnnotations|@exprtlabs\/golem\/mobx/);
  await command(root, path.join(root, 'node_modules/.bin/ttsc'), ['-p', 'tsconfig.json']);
  await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
  for (const name of ['ajv', 'ajv-formats', 'esbuild', 'mobx', 'typescript', '@exprtlabs/golem-model', '@exprtlabs/golem-openapi']) {
    assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} must be absent from standalone production`);
  }
  await command(root, process.execPath, ['--disallow-code-generation-from-strings', 'verify.mjs']);
  const browser = await build({ entryPoints: [path.join(root, 'build/src/cart.model.js'), path.join(root, 'build/sdk/index.js')], outdir: 'browser', bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.doesNotMatch(Object.keys(browser.metafile.inputs).join('\n'), /node:|\/tooling\/|\/esbuild\/|\/mobx\//);
  assert.doesNotMatch(Object.keys(browser.metafile.inputs).join('\n'), /node_modules\/(?:ajv|ajv-formats)\//);
});
