import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

const HEAD = "import type { IModel } from '@exprtlabs/golem/model';\n";

/** Builds the sources, sends each value through the wire codecs of the named model in the named file, and checks that the generated files name each projection in `names`. */
async function roundTrips(t: TestContext, sources: Record<string, string>, values: readonly (readonly [file: string, model: string, value: unknown])[], names: readonly string[]): Promise<void> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-names-', name: 'recursive-names' });
  writeModelSources(sourceRoot, sources);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  const built = await buildModelProject(root);
  assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
  const generated = fs.readdirSync(sourceRoot).filter(file => file.endsWith('.generated.ts')).map(file => fs.readFileSync(path.join(sourceRoot, file), 'utf8')).join('\n');
  for (const name of names) assert.match(generated, new RegExp(`\\b${name}Fields\\b`), `${name} is a projection name`);
  for (const [file, model, value] of values) {
    const codecs = await import(pathToFileURL(path.join(root, `build/${file}.model.generated.js`)).href) as Record<string, (value: unknown) => unknown>;
    assert.deepEqual(JSON.parse(JSON.stringify(codecs[`toWireFormat${model}`]!(codecs[`fromWireFormat${model}`]!(value)))), value);
  }
}

test('two recursive interfaces with one name in two files both generate', async (t: TestContext) => {
  // protects: T-439 two recursive types named alike in different files no longer stop with RUNM1059
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TA = IModel<{ n: Node }>;\n`,
    'b.model.ts': `${HEAD}export interface Node { label: number; next?: Node }\nexport type TB = IModel<{ n: Node }>;\n`,
  }, [['a', 'TA', { n: { id: 'x', next: { id: 'y' } } }], ['b', 'TB', { n: { label: 1, next: { label: 2 } } }]], ['Node', 'NodeB']);
});

test('a recursive interface beside a recursive alias of the same name both generate', async (t: TestContext) => {
  // protects: T-439 a recursive interface named like a recursive alias no longer stops with RUNM1059
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TA = IModel<{ n: Node }>;\n`,
    'b.model.ts': `${HEAD}export type Node = { label: number; next?: Node };\nexport type TB = IModel<{ n: Node }>;\n`,
  }, [['a', 'TA', { n: { id: 'x', next: { id: 'y' } } }], ['b', 'TB', { n: { label: 1, next: { label: 2 } } }]], ['Node', 'NodeB']);
});

test('instances of one recursive generic type generate, also when their arguments differ only in array depth', async (t: TestContext) => {
  // protects: T-439 Page<string>, Page<string[]> and Page<string[][]> beside each other (interface and alias) no longer stop with RUNM1059
  const page = { items: ['a'], next: { items: [] } };
  await roundTrips(t, {
    'pages.model.ts': `${HEAD}export interface Page<T> { items: T[]; next?: Page<T> }\nexport type Slice<T> = { items: T[]; next?: Slice<T> };\n`
      + 'export type TPages = IModel<{ s: Page<string>; a: Page<string[]>; b: Page<string[][]>; n: Page<number>; t: Slice<string>; u: Slice<number> }>;\n',
  }, [['pages', 'TPages', {
    s: page, a: { items: [['a']], next: { items: [] } }, b: { items: [[['a']]] }, n: { items: [1], next: { items: [2] } }, t: page, u: { items: [3] },
  }]], ['Page', 'PageStringArray', 'PageStringArrayArray', 'PageNumber']);
});

test('a recursive type named like a model takes another name', async (t: TestContext) => {
  // protects: T-439 a recursive type whose name is a model's name no longer stops with RUNM1059
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export type Node = IModel<{ label: string }>;\n`,
    'b.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TB = IModel<{ n: Node }>;\n`,
  }, [['b', 'TB', { n: { id: 'x', next: { id: 'y' } } }]], ['NodeB']);
});

test('a recursive type named like a model once the policy suffix is added takes another name', async (t: TestContext) => {
  // protects: T-439 the name check runs on the name with its Loose suffix, so a model named NodeLoose does not clash with Node
  await roundTrips(t, {
    'a.model.ts': `${HEAD}export type NodeLoose = IModel<{ label: string }>;\n`,
    'b.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TB = IModel<{ n: Node }, { exact: false }>;\n`,
  }, [['b', 'TB', { n: { id: 'x', next: { id: 'y' } } }]], ['NodeBLoose']);
});
