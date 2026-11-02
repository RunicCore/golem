import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { buildRecursiveNames } from './support/recursive-names.js';

const HEAD = "import type { IModel } from '@exprtlabs/golem/model';\n";

/**
 * Builds the sources and sends each value through the wire codecs of the named model in the named file (`file` is the path without `.model.ts`).
 * `fields` is every name that the generated files give a `<name>Fields` type: the models and the projections.
 */
async function roundTrips(t: TestContext, sources: Record<string, string>, values: readonly (readonly [file: string, model: string, value: unknown])[], fields: readonly string[]): Promise<void> {
  const { root, names } = await buildRecursiveNames(t, sources);
  assert.deepEqual(names, [...fields].sort());
  for (const [file, model, value] of values) {
    const codecs = await import(pathToFileURL(path.join(root, `build/${file}.model.generated.js`)).href) as Record<string, (value: unknown) => unknown>;
    assert.deepEqual(JSON.parse(JSON.stringify(codecs[`toWireFormat${model}`]!(codecs[`fromWireFormat${model}`]!(value)))), value);
  }
}

const chain = (id: string): unknown => ({ n: { [id]: 'x', next: { [id]: 'y' } } });

test('two recursive interfaces with one name in two files both generate', async (t: TestContext) => {
  // protects: T-439 two recursive types named alike in different files no longer stop with RUNM1059
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TA = IModel<{ n: Node }>;\n`,
    'b.model.ts': `${HEAD}export interface Node { label: number; next?: Node }\nexport type TB = IModel<{ n: Node }>;\n`,
  }, [['a', 'TA', chain('id')], ['b', 'TB', { n: { label: 1, next: { label: 2 } } }]], ['Node', 'NodeB', 'TA', 'TB']);
});

test('two recursive interfaces with one name in files of a custom model suffix take the file name without that suffix', async (t: TestContext) => {
  // protects: T-826 the file part of a recursive type name drops the models job's own suffix, not a fixed .model
  const { names } = await buildRecursiveNames(t, {
    'a.entity.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TA = IModel<{ n: Node }>;\n`,
    'b.entity.ts': `${HEAD}export interface Node { label: number; next?: Node }\nexport type TB = IModel<{ n: Node }>;\n`,
  }, ['.entity.ts']);
  assert.deepEqual(names, ['Node', 'NodeB', 'TA', 'TB']);
});

test('a recursive interface beside a recursive alias of the same name both generate', async (t: TestContext) => {
  // protects: T-439 a recursive interface named like a recursive alias no longer stops with RUNM1059
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TA = IModel<{ n: Node }>;\n`,
    'b.model.ts': `${HEAD}export type Node = { label: number; next?: Node };\nexport type TB = IModel<{ n: Node }>;\n`,
  }, [['a', 'TA', chain('id')], ['b', 'TB', { n: { label: 1, next: { label: 2 } } }]], ['Node', 'NodeB', 'TA', 'TB']);
});

test('instances of one recursive generic type generate, also when their arguments differ only in array depth', async (t: TestContext) => {
  // protects: T-439 Page<string>, Page<string[]> and Page<string[][]> beside each other (interface and alias) no longer stop with RUNM1059
  const page = { items: ['a'], next: { items: [] } };
  await roundTrips(t, {
    'pages.model.ts': `${HEAD}export interface Page<T> { items: T[]; next?: Page<T> }\nexport type Slice<T> = { items: T[]; next?: Slice<T> };\n`
      + 'export type TPages = IModel<{ s: Page<string>; a: Page<string[]>; b: Page<string[][]>; n: Page<number>; t: Slice<string>; u: Slice<number> }>;\n',
  }, [['pages', 'TPages', {
    s: page, a: { items: [['a']], next: { items: [] } }, b: { items: [[['a']]] }, n: { items: [1], next: { items: [2] } }, t: page, u: { items: [3] },
  }]], ['Page', 'PageNumber', 'PageStringArray', 'PageStringArrayArray', 'TPages']);
});

test('a recursive type named like a model takes another name', async (t: TestContext) => {
  // protects: T-439 a recursive type whose name is a model's name no longer stops with RUNM1059
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export type Node = IModel<{ label: string }>;\n`,
    'b.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TB = IModel<{ n: Node }>;\n`,
  }, [['b', 'TB', chain('id')]], ['Node', 'NodeB', 'TB']);
});

test('a recursive type named like a model once the policy suffix is added takes another name', async (t: TestContext) => {
  // protects: T-439 the name check runs on the name with its Loose suffix, so a model named NodeLoose does not clash with Node
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export type NodeLoose = IModel<{ label: string }>;\n`,
    'b.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TB = IModel<{ n: Node }, { exact: false }>;\n`,
  }, [['b', 'TB', chain('id')]], ['NodeBLoose', 'NodeLoose', 'TB']);
});

test('recursive types with one name and the same shape share one projection, and different shapes do not', async (t: TestContext) => {
  // protects: T-439 two files that declare the same recursive type give one projection, as the structural check always did
  const same = (field: string): string => `${HEAD}export type Node = { ${field}: string; next?: Node };\n`;
  await roundTrips(t, {
    'a.model.ts': `${same('id')}export type TA = IModel<{ n: Node }>;\n`,
    'b.model.ts': `${same('id')}export type TB = IModel<{ n: Node }>;\n`,
    'c.model.ts': `${same('label')}export type TC = IModel<{ n: Node }>;\n`,
  }, [['a', 'TA', chain('id')], ['b', 'TB', { n: { id: 'x' } }], ['c', 'TC', chain('label')]], ['Node', 'NodeC', 'TA', 'TB', 'TC']);
});

test('names that stay equal after the file name get a number', async (t: TestContext) => {
  // protects: T-439 three recursive types of one name, two of them in files of one name, all generate
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export interface Node { a: string; next?: Node }\nexport type TA = IModel<{ n: Node }>;\n`,
    'b.model.ts': `${HEAD}export interface Node { b: string; next?: Node }\nexport type TB = IModel<{ n: Node }>;\n`,
    'sub/b.model.ts': `${HEAD}export interface Node { c: string; next?: Node }\nexport type TSub = IModel<{ n: Node }>;\n`,
  }, [['a', 'TA', chain('a')], ['b', 'TB', chain('b')], ['sub/b', 'TSub', chain('c')]], ['Node', 'NodeB', 'NodeB2', 'TA', 'TB', 'TSub']);
});

test('the type arguments and the file name together tell two generic instances apart', async (t: TestContext) => {
  // protects: T-439 when both the arguments and the file name alone are taken, their join names the type
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export interface Page<T> { items: T[]; next?: Page<T> }\nexport interface PageB { next?: PageB }\n`
      + 'export type TA = IModel<{ p: Page<string>; q: PageB }>;\n',
    'b.model.ts': `${HEAD}export interface Page<T> { rows: T[]; next?: Page<T> }\nexport type TB = IModel<{ p: Page<number> }>;\n`,
    'sub/b.model.ts': `${HEAD}export interface Page<T> { cells: T[]; next?: Page<T> }\nexport type TSub = IModel<{ p: Page<number> }>;\n`,
  }, [['a', 'TA', { p: { items: ['a'], next: { items: [] } }, q: { next: {} } }], ['b', 'TB', { p: { rows: [1], next: { rows: [] } } }], ['sub/b', 'TSub', { p: { cells: [1], next: { cells: [] } } }]],
  ['Page', 'PageB', 'PageNumber', 'PageNumberB', 'TA', 'TB', 'TSub']);
});

test('recursive types that refer to each other share their projections when two files declare them alike', async (t: TestContext) => {
  // protects: T-439 a mutual recursion declared twice with one shape gives one projection for each type
  const pair = `${HEAD}export interface Even { odd?: Odd }\nexport interface Odd { even?: Even }\n`;
  await roundTrips(t, {
    'a.model.ts': `${pair}export type TA = IModel<{ e: Even }>;\n`,
    'b.model.ts': `${pair}export type TB = IModel<{ e: Even }>;\n`,
  }, [['a', 'TA', { e: { odd: { even: {} } } }], ['b', 'TB', { e: { odd: {} } }]], ['Even', 'Odd', 'TA', 'TB']);
});

test('the same chain of recursive types in two files generates in linear time', async (t: TestContext) => {
  // protects: T-439 the verdict that a type reads like the holder of its plain name is computed once per type, so a long shared chain does not double its work at each type
  const links = 24;
  const declarations = Array.from({ length: links }, (_, index) =>
    `export interface L${index} { next?: L${index}${index + 1 < links ? `; child?: L${index + 1}` : ''} }\n`).join('');
  const sources = (model: string): string => `${HEAD}${declarations}export type ${model} = IModel<{ n: L0 }>;\n`;
  await roundTrips(t, { 'a.model.ts': sources('TA'), 'b.model.ts': sources('TB') },
    [['a', 'TA', { n: { child: { child: {} } } }], ['b', 'TB', { n: { next: {} } }]],
    [...Array.from({ length: links }, (_, index) => `L${index}`), 'TA', 'TB']);
});
