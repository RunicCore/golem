// lane: typescript6 ProgramSession.transpileModule: the loader compiles what Node's type stripping cannot load
// The Node loader compiles a `.tsx` file and a file with a decorator with the project's TypeScript, after it rewrites the calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

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
});

test('a decorated .cts file fails the run: the compiled module is an ES module', async (t) => {
  // protects: T-381 a CommonJS file the loader must compile fails with the file named
  const root = await project(t, 'loader-nest-cts', { compilerOptions: { experimentalDecorators: true } });
  write(root, 'src/decorated.cts', 'function tag(target: unknown): void { void target; }\n@tag\nclass Plain {}\nvoid Plain;\n');
  const result = await run(root, 'src/decorated.cts');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem compiles to ES modules only; src/decorated.cts loads as CommonJS'), result.stderr);
});

test('a file with an enum, a namespace with a value and a parameter property runs through the loader', async (t) => {
  // protects: T-381 one rule for what Node cannot strip: the loader compiles enums, value namespaces and parameter properties too
  const root = await project(t, 'loader-strip-only');
  write(root, 'src/plain.ts', [
    "enum Color { Red = 'red' }",
    'namespace Util { export const twice = (value: number): number => value * 2; }',
    'namespace Shapes { export interface Point { x: number } }',
    'class Box {',
    '  constructor(private readonly value: number, public label: string) {}',
    '  show(): string { return `${this.label}:${this.value}`; }',
    '}',
    'console.log(JSON.stringify({ color: Color.Red, twice: Util.twice(2), box: new Box(1, "a").show() }));',
    '',
  ].join('\n'));
  const result = await run(root, 'src/plain.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { color: 'red', twice: 4, box: 'a:1' });
});

test('a .tsx file in a project with no jsx option fails the run with the file and the option to set', async (t) => {
  // protects: T-380 a .tsx file with no jsx option stops with a golem error, not a Node syntax error
  const root = await project(t, 'loader-tsx-no-jsx', { include: JSX_PROJECT.include });
  write(root, 'src/view.tsx', VIEW);
  const result = await run(root, 'src/view.tsx');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GolemHostError: golem cannot compile .*view\.tsx: set compilerOptions\.jsx in .*tsconfig\.json/, result.stderr);
});
