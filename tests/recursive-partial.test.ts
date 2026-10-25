import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { generate } from '#model/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

const MODELS = `import type { IModel } from '@exprtlabs/golem/model';
import { TCfgBaseModel, TSettingsBaseModel, TListBaseModel } from './cfg.model.generated.js';
export interface Cfg { name: string; patch?: Partial<Cfg> }
export type Settings = { name: string; patch?: Partial<Settings> };
export type Chain = { name: string; steps: Partial<Chain>[] };
export type TCfg = IModel<Cfg>;
export type TSettings = IModel<Settings>;
export type TList = IModel<{ chain: Chain; loose: Partial<Chain> }>;
export class CfgModel extends TCfgBaseModel {}
export class SettingsModel extends TSettingsBaseModel {}
export class ListModel extends TListBaseModel {}
`;

for (const [label, profile] of [['validation off', { mobx: false, validation: false }], ['validation on', { mobx: false, validation: true }]] as readonly (readonly [string, GolemProfile])[]) {
  test(`a type that holds Partial of itself round-trips (${label})`, async (t: TestContext) => {
    // protects: T-440 a type with a field of Partial of itself no longer overflows the stack; the projection refers back to itself
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-partial-', linkTypescript: true });
    writeModelSources(sourceRoot, { 'cfg.model.ts': MODELS });
    writeModelGolemYaml(root, profile);
    const built = await buildModelProject(root);
    assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
    const codecs = await import(pathToFileURL(path.join(root, 'build/cfg.model.generated.js')).href) as Record<string, (value: unknown) => unknown>;
    const wire = (name: string, value: unknown): unknown => JSON.parse(JSON.stringify(codecs[`toWireFormat${name}`]!(codecs[`fromWireFormat${name}`]!(value))));
    const cfg = { name: 'a', patch: { patch: { name: 'c', patch: {} } } };
    assert.deepEqual(wire('TCfg', cfg), cfg);
    assert.deepEqual(wire('TSettings', cfg), cfg);
    const list = { chain: { name: 'a', steps: [{ steps: [{ name: 'b' }] }] }, loose: { steps: [{ name: 'c' }] } };
    assert.deepEqual(wire('TList', list), list);
  });
}

const EXPANDING: readonly (readonly [string, string])[] = [
  ['interface', 'export interface Box<T> { value: T; next?: Box<Box<T>> }'],
  ['alias', 'export type Box<T> = { value: T; next?: Box<T[]> };'],
];
for (const [form, declaration] of EXPANDING) {
  test(`a generic ${form} that holds itself with new type arguments on each level stops with RUNM1083`, (t: TestContext) => {
    // protects: T-440 a type that expands without end stops with a coded diagnostic, not a stack overflow
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-expanding-type-', name: 'expanding-type' });
    writeModelSources(sourceRoot, { 'box.model.ts': `import type { IModel } from '@exprtlabs/golem/model';\n${declaration}\nexport type TBox = IModel<{ box: Box<string> }>;\n` });
    assert.throws(() => generate({ root, sources: [path.join(sourceRoot, 'box.model.ts')], profile: { mobx: false, validation: false } }),
      /box\.model\.ts:\d+:\d+ RUNM1083: The generic type Box expands without end/);
  });
}
