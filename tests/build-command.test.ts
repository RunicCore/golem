// golem build: type-checks the original sources with the project's own tsc, emits the rewritten ones from a staging copy.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { parseArguments, runPipeline } from '#golem/cli';
import { runBuild } from '#golem/build';
import { readRewriteIndex, sha256Hex } from '#golem/rewrite';
import { decodeMappings } from '#golem/source-map';
import { resolveTypeScript } from '#golem/typescript-version';
import { generate } from '#model/generator';
import { copyFixtureFile, createFixtureProject, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { createModelProject } from './model-project.js';
import { command, workspace } from './support/process.js';

const GOLEM = path.join(workspace, 'packages/golem/dist/bin/golem.js');
const TSC = path.join(resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? workspace).packageDir, 'bin/tsc');
const PROFILE = { mobx: false, validation: true } as const;
/** How long a watching build gets to exit after SIGINT before the test fails with what it printed. */
const STOP_TIMEOUT_MS = 15_000;
/** A heavy test is bounded below the file's 90 s budget, so a kill names the test. */
const HEAVY_TEST_TIMEOUT_MS = 45_000;
const REJECTION = 'golem build does not support project references (-b); run golem build -p <tsconfig> per project.';

// Fixture projects

function write(root: string, relative: string, text: string): void {
  writeGeneratedArtifacts([{ path: path.join(root, relative), content: text }]);
}

function editTsconfig(root: string, edit: (tsconfig: { compilerOptions: Record<string, unknown>; include?: string[]; files?: string[]; [key: string]: unknown }) => void, name = 'tsconfig.json'): void {
  const file = path.join(root, name);
  const tsconfig = JSON.parse(fs.readFileSync(file, 'utf8')) as { compilerOptions: Record<string, unknown> };
  edit(tsconfig);
  fs.writeFileSync(file, JSON.stringify(tsconfig));
}

/** A serde project (the shared money model and its generated files) with `declaration` and `sourceMap` on; the caller adds sources. */
function serdeProject(t: TestContext, name: string): string {
  const { root } = createModelProject(t, {
    prefix: 'golem-build-',
    name,
    linkTypescript: true,
    compilerOptions: { declaration: true, sourceMap: true },
  });
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  writeGeneratedArtifacts(generate({ root, profile: PROFILE }).artifacts);
  return root;
}

const USE = `import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';

export const text = stringify<TMoney>({ currency: 'USD', value: '1' });
export const money = parse<TMoney>(text);
`;

/** Every file of the project that is neither a dependency nor something golem build writes: its bytes and mtime. */
function snapshot(root: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (['node_modules', '.golem', 'build'].includes(entry.name)) continue;
      if (entry.isDirectory()) { visit(filename); continue; }
      files.set(path.relative(root, filename), `${fs.statSync(filename, { bigint: true }).mtimeNs}:${fs.readFileSync(filename, 'utf8')}`);
    }
  };
  visit(root);
  return files;
}

/** Runs `action`, then asserts that no source or generated file of the project changed: bytes and mtimes. */
async function withoutSourceEdits<T>(root: string, action: () => Promise<T>): Promise<T> {
  const before = snapshot(root);
  try {
    return await action();
  } finally {
    assert.deepEqual(snapshot(root), before, 'golem build changed a file it does not own');
  }
}

function build(root: string, project = 'tsconfig.json', config?: string): Promise<{ exitCode: number }> {
  return withoutSourceEdits(root, () => runBuild({ project: path.join(root, project), watch: false, ...(config === undefined ? {} : { config }) }));
}

function mtimes(directory: string, suffix: string): Map<string, bigint> {
  const found = new Map<string, bigint>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith(suffix)) found.set(path.relative(directory, filename), fs.statSync(filename, { bigint: true }).mtimeNs);
    }
  };
  visit(directory);
  return found;
}

function importBuilt(root: string, file: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path.join(root, 'build', file)).href) as Promise<Record<string, unknown>>;
}

function golemBuild(root: string, args: readonly string[]) {
  return withoutSourceEdits(root, () => command(root, process.execPath, [GOLEM, 'build', ...args], { allowFailure: true }));
}

/** The map of a built file resolves the rewritten `stringify` call of `USE` to its line and column in `source`. */
function assertCallMap(root: string, built: string, source: string): void {
  const generated = fs.readFileSync(path.join(root, built), 'utf8').split('\n');
  const mapFile = path.join(root, `${built}.map`);
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { sources: string[]; mappings: string };
  assert.deepEqual(map.sources.map((entry) => path.resolve(path.dirname(mapFile), entry)), [path.join(root, source)]);
  const line = generated.findIndex((text) => text.includes('.stringify('));
  assert.notEqual(line, -1);
  const column = generated[line]!.indexOf('requireObjectCodec');
  const segments = decodeMappings(map.mappings)[line]!;
  const segment = [...segments].reverse().find((candidate) => candidate[0]! <= column);
  assert.ok(segment, 'a segment covers the rewritten call');
  const original = USE.split('\n');
  const originalLine = original.findIndex((text) => text.startsWith('export const text'));
  assert.equal(segment[2], originalLine, 'the original line');
  assert.equal(segment[3], original[originalLine]!.indexOf('stringify<TMoney>'), 'the original column');
}

// Original sources are checked, rewritten sources are emitted

test('golem build checks the original sources and emits the rewritten ones', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = serdeProject(t, 'build-main');
  write(root, 'src/use.ts', USE);
  write(root, 'src/plain.ts', 'export const answer: number = 42;\n');
  // The rewritten text of this file does not type-check: the codec's parse returns unknown.
  write(root, 'src/typed.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
export const typed: TMoney = parse<TMoney>('{"currency":"EUR","value":"2"}');
`);
  write(root, 'src/load.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { Payment } from './money.model.js';
export function load(t: string) { return parse<Payment>(t); }
`);
  editTsconfig(root, (tsconfig) => { tsconfig.include = ['**/*.ts']; });
  const before = snapshot(root);
  assert.deepEqual(await build(root), { exitCode: 0 });

  await t.test('the built JavaScript runs with the codec of the model', async () => {
    const built = await importBuilt(root, 'use.js');
    assert.equal(built.text, '{"currency":"USD","value":"1"}');
    assert.deepEqual(built.money, { currency: 'USD', value: '1' });
    assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
  });

  await t.test('no source file changes: bytes and mtimes stay', () => {
    assert.deepEqual(snapshot(root), before);
  });

  await t.test('a file whose rewritten text would not type-check builds, because the originals are checked', () => {
    assert.match(fs.readFileSync(path.join(root, '.golem/build/tsconfig/stage/src/typed.ts'), 'utf8'), /__golem_requireObjectCodec\(/, 'the stage holds the rewritten text');
    assert.match(fs.readFileSync(path.join(root, 'build/typed.js'), 'utf8'), /requireObjectCodec/);
  });

  await t.test('a declaration comes from the original: an inferred return type names the model class', () => {
    assert.match(fs.readFileSync(path.join(root, 'build/load.d.ts'), 'utf8'), /export declare function load\(t: string\): Payment;/);
  });

  await t.test('a source map of a rewritten call resolves to the original line and column', () => {
    assertCallMap(root, 'build/use.js', 'src/use.ts');
  });

  await t.test('a source map of a copied file names the original', () => {
    const mapFile = path.join(root, 'build/plain.js.map');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { sources: string[] };
    assert.deepEqual(map.sources.map((source) => path.resolve(path.dirname(mapFile), source)), [path.join(root, 'src/plain.ts')]);
  });

  await t.test('the project include never reaches the stage', async () => {
    const listed = await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--listFilesOnly']);
    const own = listed.stdout.split('\n').filter((file) => file.startsWith(root));
    assert.ok(own.some((file) => file.endsWith('src/use.ts')));
    assert.deepEqual(own.filter((file) => file.includes('.golem')), []);
  });
});

// Incremental builds and a stale index

test('a second build emits only the changed file, and a changed source refreshes the index instead of failing', async (t) => {
  const root = serdeProject(t, 'build-incremental');
  write(root, 'src/use.ts', USE);
  write(root, 'src/other.ts', 'export const other = 1;\n');
  assert.equal((await build(root)).exitCode, 0);
  const first = mtimes(path.join(root, 'build'), '.js');
  const index = readRewriteIndex(root);
  assert.equal(index?.files['src/use.ts']?.sha256, sha256Hex(USE));

  // The edit leaves the index stale, and adds a call the index does not list.
  const edited = `${USE}export const again = stringify<TMoney>({ currency: 'EUR', value: '2' });\n`;
  await new Promise((resolve) => setTimeout(resolve, 20));
  write(root, 'src/use.ts', edited);
  assert.equal((await build(root)).exitCode, 0);
  const second = mtimes(path.join(root, 'build'), '.js');
  assert.deepEqual([...second].filter(([file, time]) => first.get(file) !== time).map(([file]) => file), ['use.js']);
  assert.equal(readRewriteIndex(root)?.files['src/use.ts']?.sha256, sha256Hex(edited));
  const built = await importBuilt(root, 'use.js');
  assert.equal(built.again, '{"currency":"EUR","value":"2"}');

  // A source that leaves the program leaves the stage too.
  fs.rmSync(path.join(root, 'src/other.ts'));
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, '.golem/build/tsconfig/stage/src/other.ts')), false);
});

// The compiler's own messages and the rejected -b

test('a type error in an original file fails the build with the compiler message at the original line', async (t) => {
  const root = serdeProject(t, 'build-error');
  write(root, 'src/use.ts', USE);
  write(root, 'src/broken.ts', "export const n: number = 'text';\n");
  const result = await golemBuild(root, ['-p', 'tsconfig.json']);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /src\/broken\.ts\(1,14\): error TS2322: Type 'string' is not assignable to type 'number'\./);
  assert.equal(fs.existsSync(path.join(root, 'build/use.js')), false, 'a failed check emits nothing');
});

test('-b and --build are rejected', async (t) => {
  assert.throws(() => parseArguments(['build', '-b']), { message: REJECTION });
  assert.throws(() => parseArguments(['build', '--build']), { message: REJECTION });
  const root = serdeProject(t, 'build-reject');
  const result = await golemBuild(root, ['-b']);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(REJECTION), result.stderr);
  assert.deepEqual(parseArguments(['build', '--project', 'a/tsconfig.json', '--watch']), { action: 'build', project: 'a/tsconfig.json', watch: true });
  assert.deepEqual(parseArguments(['build']), { action: 'build', project: 'tsconfig.json', watch: false });
  assert.deepEqual(parseArguments(['build', '--config', 'app/golem.yaml']), { action: 'build', project: 'tsconfig.json', watch: false, config: 'app/golem.yaml' });
  assert.throws(() => parseArguments(['build', '--config']), { message: '--config requires a filename.' });
});

// Output the incremental state cannot see, and configurations that differ in one directory

test('a build restores an outDir that was deleted, with its declarations and source maps', async (t) => {
  const root = serdeProject(t, 'build-deleted-outdir');
  write(root, 'src/use.ts', USE);
  assert.equal((await build(root)).exitCode, 0);
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  assert.equal((await build(root)).exitCode, 0);
  for (const file of ['use.js', 'use.js.map', 'use.d.ts', 'money.model.js']) assert.ok(fs.existsSync(path.join(root, 'build', file)), `build/${file} is written again`);
});

test('a class expression with a private member builds when the original does not emit declarations', async (t) => {
  const root = serdeProject(t, 'build-no-declaration');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.declaration = false; });
  write(root, 'src/anonymous.ts', 'export const Foo = class { private x = 1; get() { return this.x; } };\n');
  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/anonymous.js')));
  assert.equal(fs.existsSync(path.join(root, 'build/anonymous.d.ts')), false);
});

/** A project with a golem.yaml whose models job generates the serde model, and the index golem generate wrote. */
async function generatedProject(t: TestContext, name: string): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-build-generated-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    compilerOptions: { declaration: true, sourceMap: true },
  });
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/use.ts', USE);
  write(root, 'src/use.test.ts', USE.replace('export const text', 'export const testText').replace('(text)', '(testText)'));
  await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

test('a build of another tsconfig leaves the project index alone, and each tsconfig keeps its own build state', async (t) => {
  const root = await generatedProject(t, 'build-two-configs');
  fs.writeFileSync(path.join(root, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/*.test.ts'] }));
  const indexFile = path.join(root, '.golem/rewrites.json');
  const generated = fs.readFileSync(indexFile, 'utf8');
  assert.ok(Object.keys(readRewriteIndex(root)?.files ?? {}).includes('src/use.test.ts'));

  assert.equal((await build(root, 'tsconfig.build.json')).exitCode, 0);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), generated, 'a build of tsconfig.build.json does not rewrite the index of tsconfig.json');
  assert.equal(fs.existsSync(path.join(root, 'build/use.test.js')), false);
  await runPipeline(path.join(root, 'golem.yaml'), { check: true });

  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), generated);
  assert.ok(fs.existsSync(path.join(root, 'build/use.test.js')));
  for (const name of ['tsconfig', 'tsconfig.build']) assert.ok(fs.existsSync(path.join(root, '.golem/build', name, 'emit.tsbuildinfo')), `${name} has its own state`);
});

test('golem build --config takes the Nest setting from a golem.yaml below the parent tsconfig, and leaves the index golem generate wrote', async (t) => {
  const nest = 'controllers/nest-plugin/project';
  const root = createControllerFixture(t, {
    prefix: 'golem-build-nest-config-',
    links: 'workspace',
    tsconfig: {
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
        outDir: 'build',
        rootDir: '.',
        types: ['node'],
      },
      include: ['packages/*/src/**/*.ts'],
    },
    files: {
      'packages/api/src/payment.model.ts': readFixture(`${nest}/payment.model.ts`),
      'packages/api/src/payments.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { TPaymentFilter, TPaymentInput, TPayment } from './payment.model.js';
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: TPaymentInput): TPayment { return { id: '1', ...input }; }
  @Get()
  list(@Query() filter: TPaymentFilter): TPayment[] { return []; }
}
`,
      'packages/api/golem.yaml': 'version: 1\nmodels: { root: . }\ncontrollers:\n  - root: .\n    output: generated/api.json\n    info: { title: Payments, version: "1" }\n',
    },
  });
  const config = path.join(root, 'packages/api/golem.yaml');
  await runPipeline(config);
  const generated = fs.readFileSync(path.join(root, '.golem/rewrites.json'), 'utf8');
  assert.match(generated, /nestModelCodec/, 'golem generate indexes the Nest decorators at the parent tsconfig');

  const result = await golemBuild(root, ['-p', 'tsconfig.json', '--config', config]);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(root, '.golem/rewrites.json'), 'utf8'), generated, 'golem build writes the index golem generate wrote');
  assert.match(fs.readFileSync(path.join(root, 'build/packages/api/src/payments.controller.js'), 'utf8'), /nestModelCodec/);
});

test('a source map of an .mts file names the original and resolves the rewritten call', async (t) => {
  const root = serdeProject(t, 'build-mts');
  write(root, 'src/mod.mts', USE);
  editTsconfig(root, (tsconfig) => { tsconfig.include = ['src/**/*.ts', 'src/**/*.mts']; });
  assert.equal((await build(root)).exitCode, 0);
  assertCallMap(root, 'build/mod.mjs', 'src/mod.mts');
});

// A configuration with nothing to emit

test('a noEmit or emitDeclarationOnly project is checked and writes no JavaScript, no stage and no index', async (t) => {
  const root = serdeProject(t, 'build-no-js');
  write(root, 'src/use.ts', USE);
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.emitDeclarationOnly = true; });
  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.d.ts')), 'the declarations are written from the originals');
  assert.deepEqual([...mtimes(path.join(root, 'build'), '.js').keys()], []);

  editTsconfig(root, (tsconfig) => { delete tsconfig.compilerOptions.emitDeclarationOnly; tsconfig.compilerOptions.declaration = false; tsconfig.compilerOptions.noEmit = true; tsconfig.compilerOptions.outDir = 'unused'; });
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'unused')), false);
  assert.equal(fs.existsSync(path.join(root, '.golem/build/tsconfig/stage')), false, 'a check-only build stages nothing');
  assert.equal(readRewriteIndex(root), undefined, 'and indexes nothing');
});

// Decorator metadata

test('a Nest controller builds with the design:paramtypes of a plain tsc emit of the original', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const nest = 'controllers/nest-plugin/project';
  const root = createControllerFixture(t, {
    prefix: 'golem-build-nest-',
    links: 'workspace',
    tsconfig: {
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
        outDir: 'build',
        rootDir: 'src',
        types: ['node'],
      },
      include: ['src/**/*.ts'],
    },
    files: {
      'src/payment.model.ts': readFixture(`${nest}/payment.model.ts`),
      'src/payments.controller.ts': readFixture(`${nest}/payments.controller.ts`),
      'golem.yaml': 'version: 1\nmodels: { root: . }\ncontrollers:\n  - root: .\n    output: generated/api.json\n    info: { title: Payments, version: "1" }\n',
    },
  });
  writeGeneratedArtifacts(generate({ root, profile: PROFILE }).artifacts);
  assert.equal((await build(root, 'tsconfig.json', path.join(root, 'golem.yaml'))).exitCode, 0);
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--outDir', 'plain']);

  const metadata = (directory: string): string[] => (fs.readFileSync(path.join(root, directory, 'payments.controller.js'), 'utf8').match(/__metadata\("design:[^\n]*\)/g) ?? []);
  const plain = metadata('plain');
  assert.ok(plain.some((line) => line.includes('design:paramtypes')), 'the controller carries parameter metadata');
  assert.deepEqual(metadata('build'), plain);
  assert.match(fs.readFileSync(path.join(root, 'build/payments.controller.js'), 'utf8'), /nestModelCodec/, 'the build carries the nest rewrite');
});

// tsconfig forms the stage supports and rejects

test('a tsconfig that extends a file outside the root, with paths and a rootDir, builds', async (t) => {
  const parent = createFixtureProject(t, 'golem-build-forms-');
  const root = path.join(parent, 'app');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(workspace, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir');
  fs.writeFileSync(path.join(parent, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', sourceMap: true } }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    extends: '../tsconfig.base.json',
    compilerOptions: { outDir: 'build', rootDir: 'src', paths: { '@lib/*': ['./src/lib/*'] } },
    include: ['src/**/*.ts'],
  }));
  write(root, 'src/lib/answer.ts', 'export const answer: number = 42;\n');
  write(root, 'src/main.ts', "import { answer } from '@lib/answer.js';\nexport const doubled = answer * 2;\n");
  const before = snapshot(root);
  assert.equal((await build(root)).exitCode, 0);
  assert.deepEqual([...mtimes(path.join(root, 'build'), '.js').keys()].sort(), ['lib/answer.js', 'main.js']);
  assert.equal(fs.existsSync(path.join(root, 'src/lib/answer.js')), false);
  assert.deepEqual(snapshot(root), before);
});

test('golem build rejects a tsconfig the stage cannot mirror', async (t) => {
  const parent = createFixtureProject(t, 'golem-build-rejected-');
  const root = path.join(parent, 'app');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(workspace, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir');
  fs.mkdirSync(path.join(parent, 'shared'));
  fs.writeFileSync(path.join(parent, 'shared/shared.d.ts'), 'export declare const shared: number;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  write(root, 'src/main.ts', "import { shared } from '../../shared/shared.js';\nexport const value = shared;\n");
  const base = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' };
  const config = (extra: Record<string, unknown>, name: string): string => {
    fs.writeFileSync(path.join(root, name), JSON.stringify({ compilerOptions: { ...base, outDir: 'build', ...extra }, include: ['src/**/*.ts'] }));
    return name;
  };

  // A declaration file outside the root is not subject to rootDir, so the compiler accepts it; the stage would not reach it.
  await assert.rejects(build(root, config({ rootDir: 'src' }, 'outside.json')), (error: Error) => {
    assert.match(error.message, /shared\/shared\.d\.ts/);
    assert.match(error.message, /outside the project root/);
    return true;
  });
  await assert.rejects(build(root, config({ rootDir: '..' }, 'root-dir-outside.json')), /rootDir .* outside the project root/);
  fs.writeFileSync(path.join(root, 'no-outdir.json'), JSON.stringify({ compilerOptions: base, include: ['src/**/*.ts'] }));
  write(root, 'src/main.ts', 'export const value = 1;\n');
  await assert.rejects(build(root, 'no-outdir.json'), /requires compilerOptions\.outDir/);
  await assert.rejects(build(root, config({ rootDirs: ['src', 'other'] }, 'root-dirs.json')), /rootDirs/);
  await assert.rejects(build(root, config({ outFile: 'build/all.js' }, 'out-file.json')), /outFile/);
  await assert.rejects(build(root, config({ rootDir: 'src', sourceMap: true, sourceRoot: '/sources' }, 'source-root.json')), /sourceRoot/);
  fs.writeFileSync(path.join(root, 'solution.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.json' }] }));
  await assert.rejects(build(root, 'solution.json'), /project references/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'a rejected project writes no output');
});

// The root

test('the tsconfig directory owns the index: a parent tsconfig builds every package under it, and no package gets an index of its own', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-build-monorepo-', name: 'build-monorepo', linkTypescript: true, rootDir: '.', include: ['packages/*/src/**/*.ts'] });
  for (const name of ['a', 'b']) {
    for (const file of ['payment.model.ts', 'payment.model.generated.ts', 'iobject-plugin-keys.ts', 'calls.ts']) copyFixtureFile(root, `rewrite/${file}`, `packages/${name}/src/${file}`);
    write(root, `packages/${name}/package.json`, JSON.stringify({ name, private: true, type: 'module' }));
  }
  assert.equal((await build(root)).exitCode, 0);
  const index = readRewriteIndex(root);
  assert.deepEqual(Object.keys(index?.files ?? {}).filter((file) => file.endsWith('calls.ts')).sort(), ['packages/a/src/calls.ts', 'packages/b/src/calls.ts']);
  assert.equal(fs.existsSync(path.join(root, 'packages/a/.golem')), false);
  assert.match(fs.readFileSync(path.join(root, 'build/packages/b/src/calls.js'), 'utf8'), /requireObjectCodec\("TMoney_11111111"\)\.stringify\(/);
});

test('a package without a tsconfig of its own, under a parent tsconfig, gets one index from golem generate and golem build', async (t) => {
  const { root } = createModelProject(t, {
    prefix: 'golem-build-package-',
    name: 'build-package',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    rootDir: '.',
    include: ['packages/*/src/**/*.ts'],
  });
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: packages/a\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'packages/a/src/money.model.ts');
  write(root, 'packages/a/src/use.ts', USE);
  // A sibling package that the same tsconfig includes: its sites are not outside the tsconfig directory.
  for (const file of ['payment.model.ts', 'payment.model.generated.ts', 'iobject-plugin-keys.ts', 'calls.ts']) copyFixtureFile(root, `rewrite/${file}`, `packages/b/src/${file}`);

  await runPipeline(path.join(root, 'golem.yaml'));
  const index = readRewriteIndex(root);
  assert.deepEqual(Object.keys(index?.files ?? {}).filter((file) => file.endsWith('use.ts') || file.endsWith('calls.ts')).sort(), ['packages/a/src/use.ts', 'packages/b/src/calls.ts']);
  assert.equal(fs.existsSync(path.join(root, 'packages/a/.golem')), false, 'the package gets no index of its own');
  await runPipeline(path.join(root, 'golem.yaml'), { check: true });
  const generated = fs.readFileSync(path.join(root, '.golem/rewrites.json'), 'utf8');

  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.readFileSync(path.join(root, '.golem/rewrites.json'), 'utf8'), generated, 'golem build reads and writes the index golem generate wrote');
  assert.match(fs.readFileSync(path.join(root, 'build/packages/a/src/use.js'), 'utf8'), /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
});

// Watch

interface Watching { readonly output: () => string; readonly stop: () => Promise<number | null> }

function watching(t: TestContext, root: string): Watching {
  const child: ChildProcess = spawn(process.execPath, [GOLEM, 'build', '--watch', '-p', 'tsconfig.json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk; });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => { child.kill('SIGKILL'); });
  const stop = async (): Promise<number | null> => {
    child.kill('SIGINT');
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`golem build --watch did not exit ${STOP_TIMEOUT_MS} ms after SIGINT. Output:\n${output}`)); }, STOP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([exited, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  return { output: () => output, stop };
}

async function until(condition: () => boolean, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const count = (output: string, pattern: RegExp): number => output.split('\n').filter((line) => pattern.test(line)).length;

test('golem build --watch rebuilds once per edit, reports an error, recovers, and sees a new file', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = serdeProject(t, 'build-watch');
  write(root, 'src/use.ts', USE);
  const before = snapshot(root);
  const watcher = watching(t, root);
  await until(() => count(watcher.output(), /^Built /) === 1, 'the first build');

  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => count(watcher.output(), /^Built /) === 2, 'the rebuild after one edit');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(count(watcher.output(), /^Built /), 2, 'one edit triggers one rebuild');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);

  write(root, 'src/use.ts', `${USE}export const broken: number = 'text';\n`);
  await until(() => count(watcher.output(), /^Build failed/) === 1, 'the failed build');
  assert.match(watcher.output(), /src\/use\.ts\(\d+,\d+\): error TS2322/);

  write(root, 'src/use.ts', `${USE}export const third = 3;\n`);
  await until(() => count(watcher.output(), /^Built /) === 3, 'the build after the fix');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /third = 3/);

  // A file created in a directory the build already watches starts a rebuild, though no input changed.
  write(root, 'src/added.ts', 'export const added = 4;\n');
  await until(() => count(watcher.output(), /^Built /) === 4, 'the rebuild after a new file');
  assert.ok(fs.existsSync(path.join(root, 'build/added.js')));
  assert.equal(await watcher.stop(), 130);

  const after = new Map(snapshot(root));
  after.delete('src/added.ts');
  after.delete('src/use.ts');
  const expected = new Map(before);
  expected.delete('src/use.ts');
  assert.deepEqual(after, expected, 'a watching build changes no file it does not own');
});
