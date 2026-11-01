import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { PackageRegistryError, loadPackageRegistry, registrationForBlock } from '#golem/package-registry';
import { copyFixture, createFixtureProject } from './fixture-project.js';
import { workspace } from './support/process.js';

const GOLEM_VERSION = (JSON.parse(fs.readFileSync(path.join(workspace, 'packages/golem/package.json'), 'utf8')) as { version: string }).version;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A project folder with the golem.yaml of an app at `app`; returns the root and the golem.yaml. */
function project(t: TestContext, app = '.'): { root: string; config: string } {
  const root = createFixtureProject(t, 'golem-registry-');
  const config = path.join(root, app, 'golem.yaml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, 'version: 1\n');
  return { root, config };
}

/** Installs a fixture package under node_modules of `root`. */
function install(root: string, fixture: string, name: string): string {
  const destination = path.join(root, 'node_modules', name);
  copyFixture(destination, `registry/${fixture}`);
  return destination;
}

const thrown = (action: () => unknown): PackageRegistryError => {
  try { action(); } catch (error) {
    assert.ok(error instanceof PackageRegistryError, `expected a PackageRegistryError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the registry to stop loading' });
};

test('a package that only the workspace root lists registers its block, with every entry resolved and none loaded', (t) => {
  // protects: T-764 page Registration: a package that only the workspace root lists is found; entries resolve through Node and are not loaded
  const { root, config } = project(t, 'apps/web');
  writeJson(path.join(root, 'package.json'), { name: 'workspace', workspaces: ['apps/*'], devDependencies: { '@fixture/block-a': '1.0.0' } });
  writeJson(path.join(root, 'apps/web/package.json'), { name: 'web' });
  const installed = install(root, 'block-a', '@fixture/block-a');

  const { packages } = loadPackageRegistry(config);

  assert.deepEqual(packages, [{
    name: '@fixture/block-a',
    directory: installed,
    block: 'alpha',
    plan: path.join(installed, 'plan.js'),
    generator: path.join(installed, 'generator.js'),
    extensions: new Map([['nest', { entry: path.join(installed, 'nest.js'), profile: false }]]),
    schema: path.join(installed, 'golem-schema.json'),
  }]);
});

test('the app registers its own block and generator, and a listed package that is not installed is skipped', (t) => {
  // protects: T-764 page Registration: an app that registers its own generator is found
  const { root, config } = project(t);
  copyFixture(root, 'registry/app');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as object;
  writeJson(path.join(root, 'package.json'), { ...manifest, optionalDependencies: { '@fixture/absent': '1.0.0' } });

  const { packages } = loadPackageRegistry(config);

  assert.deepEqual(packages.map(({ name, block, plan, generator }) => ({ name, block, plan, generator })), [
    { name: 'my-app', block: 'mine', plan: undefined, generator: path.join(root, 'generator.js') },
  ]);
});

test('a pnpm-style link resolves to the real folder of the package', (t) => {
  // protects: T-764 page Registration: pnpm symlinks work
  const { root, config } = project(t);
  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/block-b': '1.0.0' } });
  const store = install(path.join(root, 'node_modules/.pnpm/@fixture+block-b@1.0.0'), 'block-b', '@fixture/block-b');
  fs.mkdirSync(path.join(root, 'node_modules/@fixture'), { recursive: true });
  fs.symlinkSync(store, path.join(root, 'node_modules/@fixture/block-b'), 'dir');

  const [registration] = loadPackageRegistry(config).packages;

  assert.equal(registration?.directory, store);
  assert.equal(registration?.plan, path.join(store, 'plan.js'));
});

test('two packages that claim one block stop loading, and the message names both', (t) => {
  // protects: T-764 page Registration: two packages that claim one block name stop loading
  const { root, config } = project(t);
  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/block-a': '1.0.0', '@fixture/rival': '1.0.0' } });
  install(root, 'block-a', '@fixture/block-a');
  install(root, 'rival', '@fixture/rival');

  assert.equal(thrown(() => loadPackageRegistry(config)).message,
    '@fixture/block-a and @fixture/rival both register the golem block "alpha". A block has one package: remove one of them.');
});

test('an unknown block lists the installed golem packages and their blocks', (t) => {
  // protects: T-764 page Registration: an unknown block lists the installed golem packages and their blocks
  const { root, config } = project(t);
  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/block-a': '1.0.0', '@fixture/block-b': '1.0.0', '@fixture/plain': '1.0.0' } });
  install(root, 'block-a', '@fixture/block-a');
  install(root, 'block-b', '@fixture/block-b');
  writeJson(path.join(root, 'node_modules/@fixture/plain/package.json'), { name: '@fixture/plain' });
  const registry = loadPackageRegistry(config);

  assert.equal(registrationForBlock(registry, 'beta').name, '@fixture/block-b');
  assert.equal(thrown(() => registrationForBlock(registry, 'gamma')).message,
    'No installed package registers the golem block "gamma". Installed golem packages and their blocks: @fixture/block-a (block alpha), @fixture/block-b (block beta). A package that only devDependencies lists is gone after a production install.');
});

test('a package that declares another apiVersion stops loading, also when it holds no other key', (t) => {
  // protects: T-764 page Versions: every package passes the apiVersion check
  const { root, config } = project(t);
  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/future': '1.0.0' } });
  writeJson(path.join(root, 'node_modules/@fixture/future/package.json'), { name: '@fixture/future', golem: { apiVersion: 3, kind: 'new shape' } });

  assert.equal(thrown(() => loadPackageRegistry(config)).message,
    'Incompatible golem package @fixture/future: this golem reads registration API 2; the package declares apiVersion 3.');
});

test('a package that pins the golem version it is published with must match the installed golem', (t) => {
  // protects: T-764 page Versions: a package that declares golem's own version passes the lockstep check
  const { root, config } = project(t);
  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/lockstep': '1.0.0', '@fixture/ranged': '1.0.0' } });
  const golem = { apiVersion: 2, block: 'lock' };
  writeJson(path.join(root, 'node_modules/@fixture/lockstep/package.json'), { name: '@fixture/lockstep', version: '0.0.1', dependencies: { '@exprtlabs/golem': '0.0.1' }, golem });
  // A third-party package versions on its own: a range for golem declares nothing.
  writeJson(path.join(root, 'node_modules/@fixture/ranged/package.json'), { name: '@fixture/ranged', version: '7.0.0', dependencies: { '@exprtlabs/golem': '^1.0.0' }, golem: { apiVersion: 2, block: 'free' } });

  assert.equal(thrown(() => loadPackageRegistry(config)).message,
    `@exprtlabs/golem ${GOLEM_VERSION} and @fixture/lockstep 0.0.1 must have the same version. Run: npm install -D @fixture/lockstep@${GOLEM_VERSION}`);

  writeJson(path.join(root, 'node_modules/@fixture/lockstep/package.json'), { name: '@fixture/lockstep', version: GOLEM_VERSION, dependencies: { '@exprtlabs/golem': GOLEM_VERSION }, golem });
  assert.deepEqual(loadPackageRegistry(config).packages.map(({ block }) => block), ['lock', 'free']);
});

test('the walk reads up to the workspace root and no further; without a workspace root it reads only the nearest package.json', (t) => {
  // protects: T-764 page Where core looks: the walk stops at workspaces, at a pnpm-workspace.yaml, else at the nearest package.json
  const { root, config } = project(t, 'group/ws/app');
  install(root, 'block-a', '@fixture/block-a');
  install(root, 'block-b', '@fixture/block-b');
  const blocksOf = () => loadPackageRegistry(config).packages.map(({ block }) => block);
  const dependsOn = (name: string) => ({ name: 'listing', dependencies: { [name]: '1.0.0' } });
  writeJson(path.join(root, 'package.json'), dependsOn('@fixture/block-a'));
  writeJson(path.join(root, 'group/ws/package.json'), { ...dependsOn('@fixture/block-b'), workspaces: ['app'] });
  writeJson(path.join(root, 'group/ws/app/package.json'), { name: 'app' });

  assert.deepEqual(blocksOf(), ['beta'], 'a workspaces field stops the walk');

  writeJson(path.join(root, 'group/ws/package.json'), dependsOn('@fixture/block-b'));
  fs.writeFileSync(path.join(root, 'group/ws/pnpm-workspace.yaml'), 'packages: [app]\n');
  assert.deepEqual(blocksOf(), ['beta'], 'a pnpm-workspace.yaml beside a package.json stops the walk');

  fs.rmSync(path.join(root, 'group/ws/pnpm-workspace.yaml'));
  assert.deepEqual(blocksOf(), [], 'with no workspace root, the nearest package.json is the only one');
});

test('the registry is read once, and read again after a package.json changes', (t) => {
  // protects: T-764 page Once: the registrations are read once for each config load and again only when a package.json changes
  const { root, config } = project(t);
  writeJson(path.join(root, 'package.json'), { name: 'app' });
  install(root, 'block-b', '@fixture/block-b');

  const first = loadPackageRegistry(config);
  assert.equal(loadPackageRegistry(config), first);
  assert.deepEqual(first.packages, []);

  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/block-b': '1.0.0' } });
  assert.deepEqual(loadPackageRegistry(config).packages.map(({ block }) => block), ['beta']);
});

test('a broken package.json or entry is a clear error naming the file or the package, never a raw exception', (t) => {
  // protects: T-764 error-handling: a package.json or a package is the developer's input; it stops loading with a message, not a raw exception
  const { root, config } = project(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": ');
  assert.match(thrown(() => loadPackageRegistry(config)).message, /^[^\n]*package\.json is not valid JSON: /);

  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/unexported': '1.0.0' } });
  writeJson(path.join(root, 'node_modules/@fixture/unexported/package.json'), { name: '@fixture/unexported', exports: {}, golem: { apiVersion: 2, block: 'x', plan: './plan' } });
  assert.match(thrown(() => loadPackageRegistry(config)).message,
    /^@fixture\/unexported declares golem\.plan "\.\/plan", but @fixture\/unexported\/plan does not resolve from [^\n]*: [^\n]*\. Export "\.\/plan" in the exports of @fixture\/unexported\.$/);
});

test('an extension registers the profile flag beside its entry; a flag that is not a boolean names the package and the extension', (t) => {
  // protects: T-782 golem.extensions.<name> takes { entry, profile }; a malformed flag is a PackageRegistryError, not a silent "no flag"
  const { root, config } = project(t);
  writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { '@fixture/flagged': '1.0.0' } });
  const register = (extension: unknown): void => writeJson(path.join(root, 'node_modules/@fixture/flagged/package.json'), {
    name: '@fixture/flagged', exports: { './plan': './plan.js', './shape': './shape.js' }, golem: { apiVersion: 2, block: 'flagged', extensions: { shape: extension } },
  });
  const entry = path.join(fs.realpathSync(root), 'node_modules/@fixture/flagged/shape.js');

  register({ entry: './shape', profile: true });
  for (const file of ['plan.js', 'shape.js']) fs.writeFileSync(path.join(root, 'node_modules/@fixture/flagged', file), '');
  assert.deepEqual(loadPackageRegistry(config).packages[0]!.extensions, new Map([['shape', { entry, profile: true }]]));
  register({ entry: './shape' });
  assert.deepEqual(loadPackageRegistry(config).packages[0]!.extensions, new Map([['shape', { entry, profile: false }]]));

  register({ entry: './shape', profile: 'yes' });
  assert.equal(thrown(() => loadPackageRegistry(config)).message, 'golem.extensions.shape.profile of @fixture/flagged must be true or false, not "yes".');
});

test('a package.json above the nearest one that does not parse ends the walk and is named when a block is not found, and a broken nearest one still stops loading', (t) => {
  // protects: T-786 a package.json above the project may be a file outside it, so its syntax error is no error of the project
  const { root, config } = project(t, 'group/app');
  install(root, 'block-b', '@fixture/block-b');
  writeJson(path.join(root, 'group/app/package.json'), { name: 'app', dependencies: { '@fixture/block-b': '1.0.0' } });
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": ');

  const registry = loadPackageRegistry(config);
  assert.deepEqual(registry.packages.map(({ block }) => block), ['beta']);
  assert.match(thrown(() => registrationForBlock(registry, 'gamma')).message, /Installed golem packages and their blocks: @fixture\/block-b \(block beta\)\. [^\n]*package\.json is no valid JSON object, so its dependency list was not read\. A package that only devDependencies lists is gone after a production install\.$/);

  fs.writeFileSync(path.join(root, 'group/app/package.json'), '{ "name": ');
  assert.match(thrown(() => loadPackageRegistry(config)).message, /^[^\n]*package\.json is not valid JSON: /);
});
