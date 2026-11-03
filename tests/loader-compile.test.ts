// lane: typescript6 ProgramSession.transpileModule: the loader compiles what Node's type stripping cannot load
// The Node loader compiles a `.tsx` file and a file with a decorator with the project's TypeScript, after it rewrites the calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { openRewriteProject } from '#golem/rewrite-host';
import { SERDE, frameLine, lineOf, project, run, write } from './support/loader-project.js';
import { workspace } from './support/process.js';

const PARSE_MONEY = `const money = parse<TMoney>('{"currency":"USD","value":"1"}');`;
const H = 'export const h = (tag: string, props: object | null, ...children: unknown[]): object => ({ tag, props, children });';

/** A `.tsx` view that builds its element with the project's own `h`, so the output shows which factory the tsconfig named. */
const VIEW = `import { parse } from '${SERDE}';
import type { TMoney } from './money.model.ts';
import './money.model.ts';

${H}
${PARSE_MONEY}
const trace = new Error('where am I').stack;
console.log(JSON.stringify(<b title={money.currency}>{money.value}</b>));
console.log(trace);
`;

const JSX_PROJECT = { compilerOptions: { jsx: 'react', jsxFactory: 'h' }, include: ['src/**/*.ts', 'src/**/*.tsx'] } as const;

test('a .tsx file runs rewritten, its JSX follows the tsconfig, and a stack frame names its original line', async (t) => {
  // protects: T-380 the Node loader loads .tsx files
  const root = await project(t, 'loader-tsx', JSX_PROJECT);
  write(root, 'src/view.tsx', VIEW);
  const result = await run(root, 'src/view.tsx');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { tag: 'b', props: { title: 'USD' }, children: ['1'] });
  assert.equal(frameLine(result.stdout, path.join(root, 'src/view.tsx')), lineOf(VIEW, 'const trace'), result.stdout);
});

test('a relative .js import names the .tsx source that has no built file', async (t) => {
  // protects: T-380 a .tsx module is imported the way TypeScript names it
  const root = await project(t, 'loader-tsx-import', JSX_PROJECT);
  write(root, 'src/badge.tsx', `${H}\nexport const badge = <i>{'ok'}</i>;\n`);
  write(root, 'src/main.ts', "import { badge } from './badge.js';\nconsole.log(JSON.stringify(badge));\n");
  const result = await run(root, 'src/main.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { tag: 'i', props: null, children: ['ok'] });
});

/** A Nest app whose constructor takes a parameter decorator and a typed parameter, and whose file holds a `parse<T>()` call. */
const NEST_APP = `import 'reflect-metadata';
import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { parse } from '${SERDE}';
import type { TMoney } from './money.model.ts';
import './money.model.ts';

@Injectable()
class Greeter {
  greet(name: string): string { return 'hello ' + name; }
}

@Controller()
class AppController {
  constructor(private readonly greeter: Greeter, @Inject('SUFFIX') private readonly suffix: string) {}
  @Get()
  get(@Query('name') name: string): string { return this.greeter.greet(name) + this.suffix; }
}

@Module({ controllers: [AppController], providers: [Greeter, { provide: 'SUFFIX', useValue: '!' }] })
class AppModule {}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
${PARSE_MONEY}
console.log(JSON.stringify({ greeting: app.get(AppController).get('Ada'), money }));
const trace = new Error('where am I').stack;
console.log(trace);
await app.close();
`;

test('a NestJS app with parameter decorators and injected types starts through the loader alone', async (t) => {
  // protects: T-381 a Nest app runs through the Node loader with no second decorator loader
  const root = await project(t, 'loader-nest', {
    compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true },
    packages: Object.fromEntries(['@nestjs/common', '@nestjs/core', 'reflect-metadata', 'rxjs'].map((name) => [name, path.join(workspace, 'node_modules', name)])),
  });
  write(root, 'src/app.ts', NEST_APP);
  const result = await run(root, 'src/app.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { greeting: 'hello Ada!', money: { currency: 'USD', value: '1' } });
  assert.equal(frameLine(result.stdout, path.join(root, 'src/app.ts')), lineOf(NEST_APP, 'const trace'), result.stdout);
});

test('a decorated .cts file fails the run: the compiled module is an ES module', async (t) => {
  // protects: T-381 a CommonJS file the loader must compile fails with the file named
  const root = await project(t, 'loader-nest-cts', { compilerOptions: { experimentalDecorators: true } });
  write(root, 'src/decorated.cts', 'function tag(target: unknown): void { void target; }\n@tag\nclass Plain {}\nvoid Plain;\n');
  const result = await run(root, 'src/decorated.cts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem compiles to ES modules only; src/decorated.cts loads as CommonJS'), result.stderr);
});

const STRIP_ONLY = [
  "enum Color { Red = 'red' }",
  'namespace Util { export const twice = (value: number): number => value * 2; }',
  'namespace Shapes { export interface Point { x: number } }',
  'class Box {',
  '  constructor(private readonly value: number, public label: string) {}',
  '  show(): string { return `${this.label}:${this.value}`; }',
  '}',
  "const trace = new Error('where am I').stack;",
  'console.log(JSON.stringify({ color: Color.Red, twice: Util.twice(2), box: new Box(1, "a").show() }));',
  'console.log(trace);',
  '',
].join('\n');

test('a file with an enum, a namespace with a value and a parameter property runs through the loader and maps to its original line', async (t) => {
  // protects: T-381 one rule for what Node cannot strip: the loader compiles enums, value namespaces and parameter properties too
  const root = await project(t, 'loader-strip-only');
  write(root, 'src/plain.ts', STRIP_ONLY);
  const result = await run(root, 'src/plain.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { color: 'red', twice: 4, box: 'a:1' });
  assert.equal(frameLine(result.stdout, path.join(root, 'src/plain.ts')), lineOf(STRIP_ONLY, 'const trace'), result.stdout);
});

test('an enum inside a declare namespace is only a type: Node strips it, so a CommonJS file with it still runs', async (t) => {
  // protects: T-381 a declare form does not make the loader compile (a compile would refuse a CommonJS file)
  const root = await project(t, 'loader-ambient');
  write(root, 'src/ambient.cts', "declare namespace Ambient { enum Inner { A } }\nconsole.log('ambient ok');\n");
  const result = await run(root, 'src/ambient.cts');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'ambient ok\n');
});

test('a syntax error in a decorated file stops the load with the file, the line and the message', async (t) => {
  // protects: T-381 the compiler's recovered output never runs
  const root = await project(t, 'loader-syntax-error', { compilerOptions: { experimentalDecorators: true } });
  const source = 'function tag(target: unknown): void { void target; }\n@tag\nclass Broken {}\nconst broken = ;\n';
  write(root, 'src/broken.ts', source);
  const result = await run(root, 'src/broken.ts');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`golem cannot compile .*broken\\.ts:\n.*broken\\.ts:${lineOf(source, 'const broken')} TS\\d+: `), result.stderr);
});

for (const [label, compilerOptions] of [['sets no jsx option', {}], ['sets jsx to preserve', { jsx: 'preserve' }]] as const) {
  test(`a .tsx file whose tsconfig ${label} fails the run with the file and the option to set`, async (t) => {
    // protects: T-380 a .tsx file that no jsx option compiles stops with a golem error, not a Node syntax error
    const root = await project(t, 'loader-tsx-no-jsx', { include: JSX_PROJECT.include, compilerOptions });
    write(root, 'src/view.tsx', VIEW);
    const result = await run(root, 'src/view.tsx');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /golem cannot compile .*view\.tsx: set compilerOptions\.jsx in .*tsconfig\.json/, result.stderr);
  });
}

test('a file with import x = require() stops the load with its line and what to write instead', async (t) => {
  // protects: T-485 CommonJS-only forms get a golem message before Node's ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
  const root = await project(t, 'loader-import-equals');
  write(root, 'src/required.ts', "// the first line\nimport fs = require('node:fs');\nconsole.log(fs.existsSync('.'));\n");
  const result = await run(root, 'src/required.ts');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /golem cannot load .*required\.ts:2: import <name> = require\(\) is CommonJS only, and golem compiles to ES modules only\. Write import <name> from '<module>' or import \* as <name> from '<module>'/, result.stderr);
  assert.ok(!result.stderr.includes('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'), result.stderr);
});

test('a file with export = stops the load with its line and what to write instead', async (t) => {
  // protects: T-485 CommonJS-only forms get a golem message before Node's ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
  const root = await project(t, 'loader-export-equals');
  write(root, 'src/value.ts', 'const value = { answer: 42 };\nexport = value;\n');
  const result = await run(root, 'src/value.ts');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /golem cannot load .*value\.ts:2: export = is CommonJS only, and golem compiles to ES modules only\. Write export default <value>/, result.stderr);
  assert.ok(!result.stderr.includes('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'), result.stderr);
});

test('a .tsx file with export = stops the load with the golem message, not the compiler output', async (t) => {
  // protects: T-485 a .tsx file gets the CommonJS-only check too
  const root = await project(t, 'loader-tsx-export-equals', JSX_PROJECT);
  write(root, 'src/view.tsx', `${H}\nconst view = <i>{'ok'}</i>;\nexport = view;\n`);
  const result = await run(root, 'src/view.tsx');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /golem cannot load .*view\.tsx:3: export = is CommonJS only/, result.stderr);
});

test('a .cts file with export = gets the CommonJS refusal, which names the module formats to use', async (t) => {
  // protects: T-485 advice to write ES module forms is for ES module files only
  const root = await project(t, 'loader-cts-export-equals');
  write(root, 'src/value.cts', 'const value = { answer: 42 };\nexport = value;\n');
  const result = await run(root, 'src/value.cts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem compiles to ES modules only; src/value.cts loads as CommonJS'), result.stderr);
  assert.ok(!result.stderr.includes('golem cannot load'), result.stderr);
});

test('export default and a type-only import = require() still load: they are types or plain exports', async (t) => {
  // protects: T-485 only export = and a value import = require() are CommonJS-only
  const root = await project(t, 'loader-export-default');
  write(root, 'src/default.ts', "import type fs = require('node:fs');\nconst value = { answer: 42 };\nexport default value;\nconst unused: fs.Stats | undefined = undefined;\nconsole.log(JSON.stringify({ value, unused }));\n");
  const result = await run(root, 'src/default.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"value":{"answer":42}}\n');
});

test('a file whose only decorator a participant added is compiled, not left for Node to reject', async (t) => {
  // protects: T-858 a decorator that a rewrite added reached Node as a syntax error
  const root = await project(t, 'loader-added-decorator');
  const text = 'class M { run(): number { return 1; } }\n';
  write(root, 'src/added.ts', text);
  const host = await openRewriteProject({ cwd: root });
  t.after(() => host.close());
  const code = 'declare const mark: MethodDecorator;\nclass M { @mark run(): number { return 1; } }\n';
  const compiled = host.transpile(path.join(root, 'src/added.ts'), text, { code, map: { version: 3, sources: ['src/added.ts'], names: [], mappings: '' } }, true);
  assert.match(compiled?.code ?? '', /__decorate|__esDecorate/);
});
