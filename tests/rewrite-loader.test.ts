// The Node loader scans each TypeScript file with the project's own types and rewrites it in memory; Node then strips the types and runs the result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { load } from '#golem/loader';
import { runPipeline } from '#golem/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages, readFixture, snapshotFilesystem, writeGeneratedArtifacts } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { createModelProject } from './model-project.js';
import { command, workspace, type CommandResult } from './support/process.js';

const NODE_FLAGS = ['--import', '@exprtlabs/golem/register', '--experimental-strip-types', '--enable-source-maps'] as const;
const SERDE = '@exprtlabs/golem/serde';
const MODELS_YAML = 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n';

/** Under Node's type stripping every relative import names its `.ts` file. */
const MAIN = `import { parse, stringify } from '${SERDE}';
import type { TMoney } from './money.model.ts';
import './money.model.ts';
import { twice } from './util.ts';

const text = stringify<TMoney>({ currency: 'USD', value: '1' });
const money = parse<TMoney>(text);
console.log(JSON.stringify({ money, twice: twice(21) }));
const trace = new Error('where am I').stack;
console.log(trace);
`;
const UTIL = 'export const twice = (value: number): number => value * 2;\n';

function write(root: string, relative: string, text: string): void {
  writeGeneratedArtifacts([{ path: path.join(root, relative), content: text }]);
}

function lineOf(source: string, prefix: string): number {
  return source.split(/\r?\n/).findIndex((text) => text.replace(/^\uFEFF/, '').startsWith(prefix)) + 1;
}

/** The mapped line of the stack frame that names `file`. */
function frameLine(output: string, file: string): number {
  const frame = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+\\)?$`, 'm');
  return Number(output.match(frame)?.[1]);
}

/** A project that runs under Node's type stripping. It runs `golem generate` unless told not to. */
async function project(t: TestContext, name: string, options: { readonly generate?: boolean } = {}): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-loader-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    compilerOptions: { noEmit: true, allowImportingTsExtensions: true },
  });
  write(root, 'golem.yaml', MODELS_YAML);
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/money.model.ts', fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8').replace('.generated.js', '.generated.ts'));
  write(root, 'src/main.ts', MAIN);
  write(root, 'src/util.ts', UTIL);
  if (options.generate !== false) await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

/** Runs the loader in a child Node, then asserts that the loader changed no file of the project: bytes and mtimes. */
async function run(root: string, file: string, options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly flags?: readonly string[] } = {}): Promise<CommandResult> {
  const before = snapshotFilesystem(root);
  const result = await command(options.cwd ?? root, process.execPath, [...NODE_FLAGS, ...(options.flags ?? []), file], { allowFailure: true, ...(options.env ? { env: options.env } : {}) });
  assert.deepEqual(snapshotFilesystem(root), before, 'the loader changed a file of the project');
  return result;
}

test('node runs a TypeScript file whose parse and stringify calls the host rewrites', async (t) => {
  const root = await project(t, 'loader-run');
  const result = await run(root, 'src/main.ts');
  assert.equal(result.code, 0, result.stderr);
  const [json] = result.stdout.split('\n');
  assert.deepEqual(JSON.parse(json!), { money: { currency: 'USD', value: '1' }, twice: 42 });
});

test('a validating model project runs when its sources and its companions are imported with .js specifiers', async (t) => {
  const root = await project(t, 'loader-js-specifiers', { generate: false });
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: true\nmodels:\n  root: .\n');
  write(root, 'src/money.model.ts', [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { MinLength } from '@exprtlabs/golem/tags';",
    "import { TMoneyBaseModel } from './money.model.generated.js';",
    'export type TMoney = IModel<{ currency: string & MinLength<3> }>;',
    'export class Money extends TMoneyBaseModel {}',
    '',
  ].join('\n'));
  write(root, 'src/main.ts', [
    `import { requireObjectCodec } from '${SERDE}';`,
    "import { Money } from './money.model.js';",
    "const codec = requireObjectCodec('TMoney');",
    "console.log(JSON.stringify({ good: codec.validate(new Money({ currency: 'USD' })), bad: codec.validate(new Money({ currency: 'x' })) }));",
    '',
  ].join('\n'));
  await runPipeline(path.join(root, 'golem.yaml'));
  const result = await run(root, 'src/main.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { good: true, bad: false });
});

test('a stack trace through a rewritten file names its original line', async (t) => {
  const root = await project(t, 'loader-source-map');
  const result = await run(root, 'src/main.ts');
  assert.equal(result.code, 0, result.stderr);
  // The rewrite prepends an import line, so the generated line is one past the original. Node reports a mapped
  // frame at the column where the map's segment starts, so the line and the file name carry the check.
  assert.equal(frameLine(result.stdout, path.join(root, 'src/main.ts')), lineOf(MAIN, 'const trace'), result.stdout);
});

test('a call whose model has no generated code fails the run with the file, the line and what to run', async (t) => {
  const root = await project(t, 'loader-no-generated', { generate: false });
  const result = await run(root, 'src/main.ts');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GolemHostError/);
  assert.match(result.stderr, new RegExp(`src/main\\.ts:${lineOf(MAIN, 'const text')}\\b`), result.stderr);
  assert.match(result.stderr, /run golem generate/);
});

test('a project with no golem.yaml fails the run with the config error', async (t) => {
  const root = await project(t, 'loader-no-config');
  fs.rmSync(path.join(root, 'golem.yaml'));
  const result = await run(root, 'src/util.ts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem needs a golem.yaml to rewrite parse<T>() calls; set config or GOLEM_CONFIG'), result.stderr);
});

test('GOLEM_CONFIG names the golem.yaml when the working directory has none', async (t) => {
  const root = await project(t, 'loader-env-config');
  const result = await run(root, 'main.ts', { cwd: path.join(root, 'src'), env: { GOLEM_CONFIG: '../golem.yaml' } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { money: { currency: 'USD', value: '1' }, twice: 42 });
});

/** A source that starts with a byte order mark, has CRLF line ends and Vietnamese text. */
const BOM_CRLF = `﻿${[
  '// Thanh toán — đơn hàng',
  `import { parse } from '${SERDE}';`,
  "import type { TMoney } from './money.model.ts';",
  "import './money.model.ts';",
  "const label = 'đơn hàng';",
  'const money = parse<TMoney>(\'{"currency":"VND","value":"1"}\');',
  'console.log(JSON.stringify({ label, money }));',
  "console.log(new Error('where am I').stack);",
].join('\r\n')}\r\n`;

test('a file with a byte order mark, CRLF line ends and Vietnamese text runs rewritten and maps to its original line', async (t) => {
  const root = await project(t, 'loader-bom-crlf');
  write(root, 'src/bom-crlf.ts', BOM_CRLF);
  const result = await run(root, 'src/bom-crlf.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { label: 'đơn hàng', money: { currency: 'VND', value: '1' } });
  assert.equal(frameLine(result.stdout, path.join(root, 'src/bom-crlf.ts')), lineOf(BOM_CRLF, 'console.log(new Error'), result.stdout);
});

test('a .mts file whose tsconfig include misses it runs rewritten', async (t) => {
  const root = await project(t, 'loader-mts');
  write(root, 'src/listed.mts', MAIN);
  const result = await run(root, 'src/listed.mts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { money: { currency: 'USD', value: '1' }, twice: 42 });
});

/** A directory next to the project, as a workspace package that the project imports from its real path: outside the golem.yaml's tsconfig directory. */
function outsideDirectory(t: TestContext, root: string, files: Readonly<Record<string, string>>): string {
  const outside = createFixtureProject(t, 'golem-loader-outside-');
  linkProjectPackages(outside, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  for (const [relative, text] of Object.entries(files)) write(outside, relative, text);
  write(root, 'src/outside.ts', `import './money.model.ts';\nimport { value } from '${pathToFileURL(path.join(outside, 'lib.ts')).href}';\nconsole.log(JSON.stringify(value));\n`);
  return outside;
}

test('a parse call in a file outside the project runs rewritten', async (t) => {
  const root = await project(t, 'loader-outside-call');
  outsideDirectory(t, root, {
    'lib.ts': `import { parse } from '${SERDE}';\nimport type { TMoney } from '${path.join(root, 'src/money.model.ts')}';\nexport const value = parse<TMoney>('{"currency":"USD","value":"1"}');\n`,
  });
  const result = await run(root, 'src/outside.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { currency: 'USD', value: '1' });
});

test('a parse call in a workspace package symlinked into node_modules runs rewritten', async (t) => {
  const root = await project(t, 'loader-symlinked-package');
  const workspacePackage = createFixtureProject(t, 'golem-loader-workspace-package-');
  linkProjectPackages(workspacePackage, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  write(workspacePackage, 'package.json', JSON.stringify({ name: 'workspace-lib', type: 'module', exports: './lib.ts' }));
  write(workspacePackage, 'lib.ts', `import { parse } from '${SERDE}';\nimport type { TMoney } from '${path.join(root, 'src/money.model.ts')}';\nexport const value = parse<TMoney>('{"currency":"USD","value":"1"}');\n`);
  linkProjectPackages(root, { 'workspace-lib': workspacePackage });
  write(root, 'src/linked.ts', "import './money.model.ts';\nimport { value } from 'workspace-lib';\nconsole.log(JSON.stringify(value));\n");
  const result = await run(root, 'src/linked.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { currency: 'USD', value: '1' });
});

test('a file outside the project with no rewrite site loads normally', async (t) => {
  const root = await project(t, 'loader-outside-plain');
  outsideDirectory(t, root, { 'lib.ts': 'export const value: number = 42;\n' });
  const result = await run(root, 'src/outside.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '42\n');
});

/** A layer as `golem generate` will write it, by hand: `#golem-models` resolves to the file, whatever generated it. */
const LAYER = 'export const layer = { profile: { mobx: true, validation: false }, schemas: {}, serdeBindings: {} };\n';
const LAYER_USE = "import { layer } from '#golem-models';\nexport const mobx: boolean = layer.profile.mobx;\n";
const NO_MODELS_YAML = 'version: 1\ncontrollers:\n  - root: .\n    output: generated/api.json\n    info: { title: Payments, version: "1" }\n';

/** A project and a directory next to it: `src/layer.ts` of the project prints what `use.ts` of the directory reads through `#golem-models`. */
async function layerProject(t: TestContext, name: string): Promise<{ readonly root: string; readonly outside: string }> {
  const root = await project(t, name, { generate: false });
  const outside = createFixtureProject(t, 'golem-loader-layer-');
  write(outside, 'use.ts', LAYER_USE);
  write(root, 'src/layer.ts', `import { mobx } from '${pathToFileURL(path.join(outside, 'use.ts')).href}';\nconsole.log(mobx);\n`);
  return { root, outside };
}

test('the Node loader resolves #golem-models in a file outside the project to the layer of the project', async (t) => {
  const { root } = await layerProject(t, 'loader-layer');
  write(root, 'src/generated/models/models.generated.ts', LAYER);
  const result = await run(root, 'src/layer.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'true\n');
});

test('a project with no models job that imports #golem-models fails the Node loader with the missing-layer error', async (t) => {
  const { root, outside } = await layerProject(t, 'loader-layer-missing');
  write(root, 'golem.yaml', NO_MODELS_YAML);
  const result = await run(root, 'src/layer.ts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(`${path.join(outside, 'use.ts')} imports #golem-models, but ${path.join(root, 'golem.yaml')} has no models job. Add a models job to golem.yaml.`), result.stderr);
});

/** A CommonJS file with a rewrite site: the import the rewrite adds cannot run in CommonJS. */
const CJS_CALL = `import { parse } from '${SERDE}';\nimport type { TMoney } from './money.model.ts';\nconst text: string = '{}';\nexport const money = parse<TMoney>(text);\n`;
const CJS_PLAIN = "const count: number = 7;\nconsole.log('cjs ran', count, typeof require);\n";

test('a .cts file with a rewrite fails the run: a rewrite cannot give CommonJS an import', async (t) => {
  const root = await project(t, 'loader-cts');
  write(root, 'src/listed.cts', CJS_CALL);
  const result = await run(root, 'src/listed.cts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem rewrites need ES modules; src/listed.cts loads as CommonJS'), result.stderr);
  assert.doesNotMatch(result.stderr, /Cannot use import statement/);
});

test('CommonJS TypeScript with no rewrite still runs', async (t) => {
  const root = await project(t, 'loader-cjs-plain');
  write(root, 'package.json', '{}');
  write(root, 'src/plain.cts', CJS_PLAIN);
  write(root, 'src/plain.ts', CJS_PLAIN);
  for (const file of ['src/plain.cts', 'src/plain.ts']) {
    const result = await run(root, file);
    assert.equal(result.code, 0, `${file}: ${result.stderr}`);
    assert.equal(result.stdout, 'cjs ran 7 function\n', file);
  }
});

/**
 * Node cannot parse decorators, so the test chains a loader hook after golem's that compiles them with esbuild. The
 * hook sees the controller as golem's hook rewrote it.
 */
const DECORATOR_HOOK = `import { transform } from 'esbuild';
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith('.controller.ts')) return loaded;
  const { code } = await transform(String(loaded.source), { loader: 'ts', format: 'esm', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
  return { ...loaded, format: 'module', source: code };
}
`;
const DECORATOR_REGISTER = "import { register } from 'node:module';\nregister('./decorator-hook.mjs', import.meta.url);\n";
const NEST_CONTROLLER = `import { Body, Controller, Post } from '@nestjs/common';
import { Payment } from './payment.model.ts';

@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: Payment): number { return input.note.length; }
}
`;
const NEST_MAIN = `import 'reflect-metadata';
import { objectCodecFromMetatype } from '@exprtlabs/golem/nest';
import './payment.model.ts';
import { PaymentsController } from './payments.controller.ts';

const types = Reflect.getMetadata('design:paramtypes', PaymentsController.prototype, 'create') as unknown[];
const codec = objectCodecFromMetatype<{ id: string; note: string }>(types[0]);
console.log(JSON.stringify({ stamped: codec !== undefined, parsed: codec?.parse('{"id":"1","note":"hello"}') }));
`;

test('a Nest controller with a @Body() model parameter carries nestModelCodec metadata when the loader runs it, in a project whose yaml has a controllers job', async (t) => {
  const root = createControllerFixture(t, {
    prefix: 'golem-loader-nest-',
    links: 'workspace',
    tsconfig: {
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, experimentalDecorators: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true },
      include: ['src/**/*.ts'],
    },
    files: {
      'golem.yaml': MODELS_YAML,
      'src/payment.model.ts': readFixture('controllers/nest-plugin/project/payment.model.ts').replace('.generated.js', '.generated.ts'),
      'src/payments.controller.ts': NEST_CONTROLLER,
      'src/main.ts': NEST_MAIN,
      'decorator-hook.mjs': DECORATOR_HOOK,
      'decorator-register.mjs': DECORATOR_REGISTER,
    },
  });
  await runPipeline(path.join(root, 'golem.yaml'));
  write(root, 'golem.yaml', `${MODELS_YAML}controllers:\n  - root: .\n    output: generated/api.json\n    info: { title: Payments, version: "1" }\n`);
  const result = await run(root, 'src/main.ts', { flags: ['--import', './decorator-register.mjs'] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { stamped: true, parsed: { id: '1', note: 'hello' } });
});

test('files under node_modules, .tsx files, other schemes and non-TypeScript files pass through without opening a project', async (t) => {
  const root = createFixtureProject(t, 'golem-loader-passthrough-');
  const before = snapshotFilesystem(root);
  const next = { format: 'module', source: 'marker' };
  const nextLoad = () => next;
  for (const url of [
    pathToFileURL(path.join(root, 'node_modules/dep/index.ts')).href,
    pathToFileURL(path.join(root, 'src/view.tsx')).href,
    pathToFileURL(path.join(root, 'src/plain.js')).href,
    pathToFileURL(path.join(root, 'src/data.json')).href,
    'node:fs',
    'data:text/javascript,export default 1',
  ]) assert.equal(await load(url, {}, nextLoad), next, url);
  assert.deepEqual(snapshotFilesystem(root), before);
});

