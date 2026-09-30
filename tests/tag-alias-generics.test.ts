import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { getValidator } from '@exprtlabs/golem/validation';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject, compileModelProject } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';

function fixture(t: TestContext) {
  return createModelProject(t, { prefix: 'golem-tag-alias-generics-', name: 'tag-alias-generics', ttscPlugin: true, linkWorkspaceNodeModules: true });
}

async function validity(t: TestContext, prelude: SourceFragment, field: SourceFragment, values: readonly unknown[]): Promise<boolean[]> {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), `export function notBlank(value: string): boolean | string { return value.trim() !== '' || 'blank'; }\n`);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: prelude, fields: field }).text);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const results: boolean[] = [];
  for (const value of values) results.push(await getValidator(new A({ value })).validate());
  return results;
}

const tags = tsSource`import type { MaxLength, MinLength, Pattern, TValidation } from '@exprtlabs/golem/tags';\nimport { notBlank } from './rules.js';`;

test('direct generic alias substitutes its argument', async t => {
  assert.deepEqual(await validity(t, tsSource`${tags}\ntype V<N extends number> = string & MaxLength<N>;`, tsSource`value: V<3>`, ['abc', 'abcd']), [true, false]);
});

test('nested alias forwards a parameter', async t => {
  assert.deepEqual(await validity(t, tsSource`${tags}\ntype V<N extends number> = string & MaxLength<N>;\ntype W<M extends number> = V<M> & Pattern<'^[a-z]+$'>;`, tsSource`value: W<3>`, ['abc', 'abcd', 'AB']), [true, false, false]);
});

test('defaulted parameter', async t => {
  assert.deepEqual(await validity(t, tsSource`${tags}\ntype V<N extends number = 2> = string & MaxLength<N>;`, tsSource`value: V`, ['ab', 'abc']), [true, false]);
});

test('template-literal pattern argument', async t => {
  assert.deepEqual(await validity(t, tsSource`${tags}\ntype Digits<N extends number> = string & Pattern<\`^\\\\d{1,\${N}}$\`>;`, tsSource`value: Digits<2>`, ['12', '123']), [true, false]);
});

test('computed numeric argument', async t => {
  const prelude = tsSource`${tags}
type Tuple<N extends number, R extends unknown[] = []> = R['length'] extends N ? R : [...R, unknown]['length'] extends N ? [...R, unknown] : Tuple<N, [...R, unknown, unknown]>;
type Minus<A extends number, B extends number> = Tuple<A> extends [...Tuple<B>, ...infer Rest] ? Rest['length'] : never;
type Whole<P extends number, S extends number> = string & MaxLength<Minus<P, S>>;`;
  assert.deepEqual(await validity(t, prelude, tsSource`value: Whole<5, 2>`, ['123', '1234']), [true, false]);
});

test('computed argument at Postgres maximum precision', t => {
  // Settles the instantiation-depth risk (spec §3). TypeScript stops tail-recursive conditional types at 1000 steps,
  // so a one-element-per-step Tuple reduces only up to 999; this helper adds two per step and reaches 1000.
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { MaxLength } from '@exprtlabs/golem/tags';
type Tuple<N extends number, R extends unknown[] = []> = R['length'] extends N ? R : [...R, unknown]['length'] extends N ? [...R, unknown] : Tuple<N, [...R, unknown, unknown]>;
type Minus<A extends number, B extends number> = Tuple<A> extends [...Tuple<B>, ...infer Rest] ? Rest['length'] : never;
type Whole<P extends number, S extends number> = string & MaxLength<Minus<P, S>>;`, fields: tsSource`value: Whole<1000, 0>` }).text);
  const shared = generate({ root, profile: { mobx: false, validation: true } }).artifacts.map(a => a.content).join('\n');
  // The schema is embedded as a JSON string, so its quotes are escaped in the generated source.
  assert.match(shared, /\\"maxLength\\":1000\b/);
});

test('array of generic alias', async t => {
  assert.deepEqual(await validity(t, tsSource`${tags}\ntype V<N extends number> = string & MaxLength<N>;`, tsSource`value: V<2>[]`, [['ab'], ['abc']]), [true, false]);
});

test('nullable generic alias', async t => {
  assert.deepEqual(await validity(t, tsSource`${tags}\ntype V<N extends number> = string & MaxLength<N>;`, tsSource`value: V<2> | null`, [null, 'ab', 'abc']), [true, true, false]);
});

test('generic alias with predicate', async t => {
  assert.deepEqual(await validity(t, tsSource`${tags}\ntype V<N extends number> = string & MaxLength<N> & TValidation<typeof notBlank>;`, tsSource`value: V<3>`, ['ab', '  ', 'abcd']), [true, false, false]);
});

for (const item of [
  { name: 'non-literal argument', prelude: tsSource`type V<N extends number> = string & MaxLength<N>;`, field: tsSource`value: V<number>`, expected: /a\.model\.ts:\d+:\d+ RUNM1043: MaxLength requires a finite numeric literal argument/ },
  { name: 'typeof depends on a parameter', prelude: tsSource`type V<F extends (value: string) => boolean> = string & TValidation<F>;`, field: tsSource`value: V<typeof notBlank>`, expected: /RUNM1061: /},
  { name: 'two same-kind tags, one parameter-dependent', prelude: tsSource`type V<N extends number> = string & MaxLength<N> & MaxLength<9>;`, field: tsSource`value: V<3>`, expected: /RUNM1062: / },
] as const) {
  test(`generic alias diagnostic: ${item.name}`, t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), `export function notBlank(value: string): boolean { return value.trim() !== ''; }\n`);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`${tags}\n${item.prelude}`, fields: item.field }).text);
    assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), error => { assert.match(String(error), item.expected); return true; });
  });
}
