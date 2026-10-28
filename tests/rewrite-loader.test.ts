// The Node loader scans each TypeScript file with the project's own types and rewrites it in memory; Node then strips the types and runs the result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { load } from '#golem/loader';
import { runPipeline } from '#golem/cli';
import { createFixtureProject, linkProjectPackages, readFixture, snapshotFilesystem } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { createModelProject } from './model-project.js';
import { command, workspace } from './support/process.js';
import { MAIN, MODELS_YAML, NODE_FLAGS, SERDE, frameLine, lineOf, project, run, workspacePackage, write } from './support/loader-project.js';
import { ORDER_WIRE, runSite, sharedFolderProject } from './support/shared-folder-project.js';

/** Runs `file` through the loader and returns the JSON on the first line it printed; a run that fails fails the test with its stderr. */
async function runJson(root: string, file: string, options?: Parameters<typeof run>[2]): Promise<unknown> {
  const result = await run(root, file, options);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout.split('\n')[0]!);
}

test('node runs a TypeScript file whose parse and stringify calls the host rewrites', async (t) => {
  const root = await project(t, 'loader-run');
  assert.deepEqual(await runJson(root, 'src/main.ts'), { money: { currency: 'USD', value: '1' }, twice: 42 });
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
    `import { findCodecIdForConstructor, requireObjectCodec } from '${SERDE}';`,
    "import { Money } from './money.model.js';",
    "const codec = requireObjectCodec(findCodecIdForConstructor(Money) as string);",
    "console.log(JSON.stringify({ good: codec.validate(new Money({ currency: 'USD' })), bad: codec.validate(new Money({ currency: 'x' })) }));",
    '',
  ].join('\n'));
  await runPipeline(path.join(root, 'golem.yaml'));
  assert.deepEqual(await runJson(root, 'src/main.ts'), { good: true, bad: false });
});

test('a construct option the call passes wins over the rewrite default, given as shorthand or inside a variable', async (t) => {
  // protects: T-170 the user's own class is built, not the class in the type argument
  const root = await project(t, 'loader-construct-option');
  write(root, 'src/main.ts', [
    `import { parse } from '${SERDE}';`,
    "import { Payment } from './money.model.ts';",
    'class Sub extends Payment {}',
    'const construct = Sub;',
    'const options = { construct };',
    "const text = JSON.stringify({ id: '1', amount: { currency: 'USD', value: '1' }, note: 'n' });",
    'const plain = parse<Payment>(text);',
    'console.log(JSON.stringify({',
    '  plain: plain.constructor === Payment,',
    '  shorthand: parse<Payment>(text, { construct }) instanceof Sub,',
    '  variable: parse<Payment>(text, options) instanceof Sub,',
    '  other: parse<Payment>(text, { validate: false }).constructor === Payment,',
    '}));',
    '',
  ].join('\n'));
  assert.deepEqual(await runJson(root, 'src/main.ts'), { plain: true, shorthand: true, variable: true, other: true });
});

test('a parse call whose class comes through a type-only namespace import runs', async (t) => {
  // protects: T-171 the erased namespace import must not be named at run time
  const root = await project(t, 'loader-type-only-namespace');
  write(root, 'src/main.ts', [
    `import { parse } from '${SERDE}';`,
    "import type * as models from './money.model.ts';",
    "import './money.model.ts';",
    "const text = JSON.stringify({ id: '1', amount: { currency: 'USD', value: '1' }, note: 'n' });",
    'const payment = parse<models.Payment>(text);',
    "console.log(JSON.stringify({ id: payment.id, built: payment.constructor.name }));",
    '',
  ].join('\n'));
  assert.deepEqual(await runJson(root, 'src/main.ts'), { id: '1', built: 'Payment' });
});

test('a model named only as a type in a parse call has its codec registered with no import of its module', async (t) => {
  // protects: T-190 the erased type import must not leave the codec unregistered
  const root = await project(t, 'loader-codec-module');
  write(root, 'src/main.ts', [
    `import { parse, stringify } from '${SERDE}';`,
    "import type { TMoney } from './money.model.ts';",
    "const money = parse<TMoney>(stringify<TMoney>({ currency: 'USD', value: '1' }));",
    'console.log(JSON.stringify(money));',
    '',
  ].join('\n'));
  assert.deepEqual(await runJson(root, 'src/main.ts'), { currency: 'USD', value: '1' });
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
  assert.deepEqual(await runJson(root, 'main.ts', { cwd: path.join(root, 'src'), env: { GOLEM_CONFIG: '../golem.yaml' } }), { money: { currency: 'USD', value: '1' }, twice: 42 });
});

test('an empty GOLEM_CONFIG is no setting: the golem.yaml of the working directory is used', async (t) => {
  // protects: T-27 GOLEM_CONFIG="" resolved to the working directory and failed on a directory
  const root = await project(t, 'loader-empty-env-config');
  const result = await run(root, 'src/main.ts', { env: { GOLEM_CONFIG: '' } });
  assert.equal(result.code, 0, result.stderr);
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
  assert.deepEqual(await runJson(root, 'src/listed.mts'), { money: { currency: 'USD', value: '1' }, twice: 42 });
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

/** A workspace package of `root` linked into its node_modules, with one parse call; `src/linked.ts` imports it. */
function linkedPackage(t: TestContext, root: string, preserveSymlinks = false): void {
  workspacePackage(t, root, preserveSymlinks);
  write(root, 'src/linked.ts', "import './money.model.ts';\nimport { value } from 'workspace-lib';\nconsole.log(JSON.stringify(value));\n");
}

test('a parse call in a workspace package symlinked into node_modules runs rewritten', async (t) => {
  const root = await project(t, 'loader-symlinked-package');
  linkedPackage(t, root);
  const result = await run(root, 'src/linked.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { currency: 'USD', value: '1' });
});

test('with preserveSymlinks, the load hook rewrites a workspace package that keeps its node_modules path', async (t) => {
  // protects: T-382 a linked package keeps its node_modules path under preserveSymlinks and was skipped
  // Node itself refuses to strip types under node_modules, so the hook is called as a chained loader would call it.
  const root = await project(t, 'loader-preserved-symlink', { preserveSymlinks: true });
  linkedPackage(t, root, true);
  const file = path.join(root, 'node_modules/workspace-lib/lib.ts');
  const original = fs.readFileSync(file, 'utf8');
  write(root, 'hook.mjs', `import { load } from '@exprtlabs/golem/loader';
const loaded = await load(${JSON.stringify(pathToFileURL(file).href)}, {}, () => ({ format: 'module-typescript', source: ${JSON.stringify(original)} }));
console.log(JSON.stringify({ rewritten: loaded.source !== ${JSON.stringify(original)}, codec: /TMoney_[0-9a-f]+/.test(String(loaded.source)) }));
`);
  const result = await command(root, process.execPath, ['hook.mjs']);
  assert.deepEqual(JSON.parse(result.stdout), { rewritten: true, codec: true });
});

test('a file outside the project with no rewrite site loads normally', async (t) => {
  const root = await project(t, 'loader-outside-plain');
  outsideDirectory(t, root, { 'lib.ts': 'export const value: number = 42;\n' });
  const result = await run(root, 'src/outside.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '42\n');
});

test('the Node loader runs app A over the plain types of a shared folder', async (t) => {
  const project = sharedFolderProject(t, 'loader-shared-folder');
  await runPipeline(path.join(project.appA, 'golem.yaml'));
  const outcome = await runSite(project.appA, path.join(project.appA, 'src/site.ts'), NODE_FLAGS);
  assert.deepEqual(outcome.wire, ORDER_WIRE);
  assert.equal(outcome.validityObservable, true);
  assert.match(outcome.rejected ?? '', /Model validation failed/);
});

test('parse of a shared alias runs under the Node loader with no import of its companion, and the codec is registered', async (t) => {
  // protects: P-12 done check 6: a serde call on a shared alias loads the companion the app generated in models.output
  const { root: outer } = createModelProject(t, { prefix: 'golem-loader-shared-', name: 'loader-shared', linkTypescript: true, packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') } });
  const app = path.join(outer, 'app');
  write(outer, 'shared/package.json', JSON.stringify({ name: '@acme/shared', type: 'module' }));
  write(outer, 'shared/customer.model.ts', "import type { IModel } from '@exprtlabs/golem/model';\nimport type { MinLength } from '@exprtlabs/golem/tags';\nexport type TCustomer = IModel<{ name: string & MinLength<3> }>;\n");
  write(app, 'package.json', JSON.stringify({ name: 'shared-app', private: true, type: 'module' }));
  write(app, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: true\nmodels:\n  root: .\n');
  write(app, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true }, include: ['src/**/*.ts', '../shared/**/*.ts'] }));
  write(app, 'src/main.ts', `import { parse } from '${SERDE}';
import type { TCustomer } from '../../shared/customer.model.ts';

let rejected: string | null = null;
try { parse<TCustomer>('{"name":"Al"}'); } catch (error) { rejected = (error as Error).message; }
console.log(JSON.stringify({ accepted: parse<TCustomer>('{"name":"Ann"}'), rejected }));
`);
  await runPipeline(path.join(app, 'golem.yaml'));

  const result = await run(app, 'src/main.ts');

  assert.equal(result.code, 0, result.stderr);
  const { accepted, rejected } = JSON.parse(result.stdout.split('\n')[0]!) as { accepted: unknown; rejected: string };
  assert.deepEqual(accepted, { name: 'Ann' });
  assert.match(rejected, /Model validation failed/);
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
  const root = await nestCodecProject(t, NEST_CONTROLLER, NEST_MAIN);
  assert.deepEqual(await runJson(root, 'src/main.ts'), { stamped: true, parsed: { id: '1', note: 'hello' } });
});

/** A Nest project with a controllers job; `controller` and `main` are its source files. */
async function nestCodecProject(t: TestContext, controller: string, main: string): Promise<string> {
  const root = createControllerFixture(t, {
    prefix: 'golem-loader-nest-codec-',
    links: 'workspace',
    tsconfig: {
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, experimentalDecorators: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true },
      include: ['src/**/*.ts'],
    },
    files: {
      'golem.yaml': MODELS_YAML,
      'src/payment.model.ts': readFixture('controllers/nest-plugin/project/payment.model.ts').replace('.generated.js', '.generated.ts'),
      'src/payments.controller.ts': controller,
      'src/main.ts': main,
    },
  });
  await runPipeline(path.join(root, 'golem.yaml'));
  write(root, 'golem.yaml', `${MODELS_YAML}controllers:\n  - root: .\n    output: generated/api.json\n    info: { title: Payments, version: "1" }\n`);
  return root;
}

test('a @Body() IObject alias named only as a type has its codec registered with no import of its module', async (t) => {
  // protects: T-190 the erased type import must not leave the codec of nestModelCodec unregistered
  const root = await nestCodecProject(t, [
    "import { Body, Controller, Post } from '@nestjs/common';",
    "import type { TPaymentInput } from './payment.model.ts';",
    "@Controller('payments')",
    'export class PaymentsController {',
    '  @Post()',
    '  create(@Body() input: TPaymentInput): number { return input.note.length; }',
    '}',
    '',
  ].join('\n'), [
    "import 'reflect-metadata';",
    "import { objectCodecFromMetatype } from '@exprtlabs/golem/nest';",
    "import { PaymentsController } from './payments.controller.ts';",
    "const types = Reflect.getMetadata('design:paramtypes', PaymentsController.prototype, 'create') as unknown[];",
    "const codec = objectCodecFromMetatype<{ note: string }>(types[0]);",
    "console.log(JSON.stringify({ stamped: codec !== undefined, parsed: codec?.parse('{\"note\":\"hello\"}') }));",
    '',
  ].join('\n'));
  assert.deepEqual(await runJson(root, 'src/main.ts'), { stamped: true, parsed: { note: 'hello' } });
});

test('a model named only in an async Promise return has its codec registered with no import of its module', async (t) => {
  // protects: T-190 the erased type import must not leave the codec of nestModelReturn unregistered
  const root = await nestCodecProject(t, [
    "import { Controller, Get } from '@nestjs/common';",
    "import type { TPayment } from './payment.model.ts';",
    "@Controller('payments')",
    'export class PaymentsController {',
    '  @Get()',
    "  async read(): Promise<TPayment> { return { id: '1', note: 'n' }; }",
    '}',
    '',
  ].join('\n'), [
    "import 'reflect-metadata';",
    "import fs from 'node:fs';",
    "import { getObjectCodec } from '@exprtlabs/golem/serde';",
    "import './payments.controller.ts';",
    "const keys = JSON.parse(fs.readFileSync('.golem/codec-keys.json', 'utf8')).keys;",
    "const id = keys[Object.keys(keys).find((key) => key.endsWith('#TPayment'))];",
    "console.log(JSON.stringify({ registered: getObjectCodec(id) !== undefined }));",
    '',
  ].join('\n'));
  assert.deepEqual(await runJson(root, 'src/main.ts'), { registered: true });
});

test('files under node_modules, other schemes and non-TypeScript files pass through without opening a project', async (t) => {
  const root = createFixtureProject(t, 'golem-loader-passthrough-');
  const before = snapshotFilesystem(root);
  const next = { format: 'module', source: 'marker' };
  const nextLoad = () => next;
  for (const url of [
    pathToFileURL(path.join(root, 'node_modules/dep/index.ts')).href,
    pathToFileURL(path.join(root, 'src/plain.js')).href,
    pathToFileURL(path.join(root, 'src/data.json')).href,
    'node:fs',
    'data:text/javascript,export default 1',
  ]) assert.equal(await load(url, {}, nextLoad), next, url);
  assert.deepEqual(snapshotFilesystem(root), before);
});

