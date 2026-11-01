import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '#golem/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { command, workspace } from './support/process.js';
import { TSC } from './support/build-project.js';

const CONFIG = [
  'version: 1',
  'validation: sanity',
  'acme:',
  '  output: src/ext',
  '  fields: { name: string, age: number }',
  'model:',
  '',
].join('\n');

/** The extension package as an author sees `@exprtlabs/golem`: every subpath but `internal/*`, so an import of an internal path does not compile. */
function installPublicGolem(compileRoot: string): void {
  const golem = path.join(workspace, 'packages/golem');
  const manifest = JSON.parse(fs.readFileSync(path.join(golem, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
  const exported = Object.fromEntries(Object.entries(manifest.exports).filter(([subpath]) => !subpath.startsWith('./internal/')));
  const installed = path.join(compileRoot, 'node_modules/@exprtlabs/golem');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: '@exprtlabs/golem', type: 'module', exports: exported }));
  fs.symlinkSync(path.join(golem, 'dist'), path.join(installed, 'dist'), 'dir');
  fs.symlinkSync(path.join(workspace, 'node_modules/@types'), path.join(compileRoot, 'node_modules/@types'), 'dir');
}

test('a third-party package that imports only public golem subpaths registers its own block, its job writes the output, and the model block generates and compiles it; the project validation level reaches it', async (t: TestContext) => {
  // protects: T-654 an extension package builds with the public API alone (its plan entry and generator), and its output goes through the models job and compiles
  // protects: T-766 a third-party package registers its own block and the pipeline runs its job from the registry
  // protects: T-663 the validation level of golem.yaml reaches a third-party job through GolemProfile
  const compileRoot = createFixtureProject(t, 'golem-extension-build-');
  for (const file of ['package.json', 'tsconfig.json', 'plan.ts', 'generator.ts']) copyFixtureFile(compileRoot, `extension-generator/${file}`, file);
  installPublicGolem(compileRoot);
  await command(compileRoot, process.execPath, [TSC, '-p', 'tsconfig.json']);

  const root = createFixtureProject(t, 'golem-extension-project-');
  linkProjectPackages(root, Object.fromEntries(['golem', 'golem-model'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)])));
  const extension = path.join(root, 'node_modules/@fixture/extension');
  fs.mkdirSync(extension, { recursive: true });
  fs.copyFileSync(path.join(compileRoot, 'package.json'), path.join(extension, 'package.json'));
  fs.cpSync(path.join(compileRoot, 'dist'), path.join(extension, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"golem-extension-fixture","type":"module","dependencies":{"@fixture/extension":"*","@exprtlabs/golem-model":"*"}}');
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.writeFileSync(path.join(root, 'golem.yaml'), CONFIG);

  await runPipeline(path.join(root, 'golem.yaml'));

  const card = fs.readFileSync(path.join(root, 'src/ext/card.model.ts'), 'utf8');
  assert.match(card, /^\/\* profile: \{"mobx":false,"validation":"sanity"\} \*\/$/m);
  assert.match(card, /^ {2}age: number;\n {2}name: string;$/m);

  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--noEmit']);
});

test('a clean clone generates when a model source is a file that another block writes into a folder that does not exist yet', async (t: TestContext) => {
  // protects: T-786 docs/reference/config.md: a model source may be one an earlier job writes
  const root = createFixtureProject(t, 'golem-written-source-');
  linkProjectPackages(root, Object.fromEntries(['golem', 'golem-model'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)])));
  const extension = path.join(root, 'node_modules/@fixture/writer');
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: '@fixture/writer', version: '0.0.1', exports: { './plan': './plan.js', './generator': './generator.mjs' }, golem: { apiVersion: 2, block: 'writer', plan: './plan', generator: './generator' } }));
  fs.writeFileSync(path.join(extension, 'plan.js'), `const path = require('node:path');
exports.plan = { declare({ directory, block }) {
  const output = path.resolve(directory, block.output);
  return [{ facts: { id: 'writer', outputs: [{ path: output, kind: 'folder' }], ownedRoots: [], inputFiles: [], inputFolders: [], readsProgram: false, provides: [], needs: [], hooks: [], watch: [] }, options: { output } }];
} };
`);
  fs.writeFileSync(path.join(extension, 'generator.mjs'), `import path from 'node:path';
export const apiVersion = 1;
export function generate({ output }) {
  const content = "/* Generated by @fixture/writer. Do not edit. */\\nimport type { IModel } from '@exprtlabs/golem/model';\\nexport type TEvent = IModel<{ name: string }>;\\n";
  return { artifacts: [{ path: path.join(output, 'a.model.ts'), content }], manifestPaths: [], watchInputs: [] };
}
`);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"golem-written-source-fixture","type":"module","dependencies":{"@fixture/writer":"*","@exprtlabs/golem-model":"*"}}');
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nmodel:\n  sources: [src/events/a.model.ts]\nwriter:\n  output: src/events\n');

  await runPipeline(path.join(root, 'golem.yaml'));

  assert.equal(fs.existsSync(path.join(root, 'src/events/a.model.generated.ts')), true);
});
