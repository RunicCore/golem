import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { generate } from '#model/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

const HEAD = "import type { IModel } from '@exprtlabs/golem/model';\n";

test('recursive types that share a name generate and round-trip', async (t: TestContext) => {
  // protects: T-439 two recursive types with one name (two files, interface beside alias, Page<string> beside Page<number>) no longer stop with RUNM1059
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-names-', name: 'recursive-names' });
  writeModelSources(sourceRoot, {
    'a.model.ts': `${HEAD}export interface Node { id: string; next?: Node }\nexport type TA = IModel<{ n: Node }>;\n`,
    'b.model.ts': `${HEAD}export type Node = { label: number; next?: Node };\nexport type TB = IModel<{ n: Node }>;\n`,
    'c.model.ts': `${HEAD}export interface Node { flag: boolean; next?: Node }\nexport type TC = IModel<{ n: Node }>;\n`,
    'pages.model.ts': `${HEAD}export interface Page<T> { items: T[]; next?: Page<T> }\nexport type Slice<T> = { items: T[]; next?: Slice<T> };\n`
      + 'export type TPages = IModel<{ s: Page<string>; n: Page<number>; a: Slice<string>; b: Slice<number> }>;\n',
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  const built = await buildModelProject(root);
  assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
  const wire = async (file: string, name: string, value: unknown): Promise<unknown> => {
    const codecs = await import(pathToFileURL(path.join(root, `build/${file}.model.generated.js`)).href) as Record<string, (value: unknown) => unknown>;
    return JSON.parse(JSON.stringify(codecs[`toWireFormat${name}`]!(codecs[`fromWireFormat${name}`]!(value))));
  };
  const a = { n: { id: 'x', next: { id: 'y' } } };
  const b = { n: { label: 1, next: { label: 2 } } };
  const c = { n: { flag: true, next: { flag: false } } };
  const pages = { s: { items: ['a'], next: { items: ['b'] } }, n: { items: [1], next: { items: [2] } }, a: { items: ['c'], next: { items: [] } }, b: { items: [3], next: { items: [] } } };
  assert.deepEqual(await wire('a', 'TA', a), a);
  assert.deepEqual(await wire('b', 'TB', b), b);
  assert.deepEqual(await wire('c', 'TC', c), c);
  assert.deepEqual(await wire('pages', 'TPages', pages), pages);
});

test('two instances that cannot be told apart stop with RUNM1059 that names each place once', (t: TestContext) => {
  // protects: T-439 RUNM1059 stays for names that stay equal after qualifying, and its message names both types and their places
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-clash-', name: 'recursive-clash' });
  writeModelSources(sourceRoot, {
    'pages.model.ts': `${HEAD}export interface Page<T> { items: T[]; next?: Page<T> }\n`
      + 'export type TPages = IModel<{ a: Page<string>; b: Page<string[]>; c: Page<string[][]> }>;\n',
  });
  assert.throws(() => generate({ root, sources: [path.join(sourceRoot, 'pages.model.ts')], profile: { mobx: false, validation: false } }),
    /RUNM1059: Projection name PageString is used by two different types: Page<string\[\]> declared at \S+pages\.model\.ts:2:\d+ and Page<string\[\]\[\]> declared at \S+pages\.model\.ts:2:\d+\./);
});
