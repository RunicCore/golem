import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';

import { generatedCodecIdFromRoot } from './support/consumer.js';
import { fileFixtureScope, onceShared } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';

const SOURCE = `import type { IModel } from '@exprtlabs/golem/model';
import type { AdditionalProperties } from '@exprtlabs/golem/tags';
import { TLeafBaseModel, TTreeBaseModel, TStampedBaseModel, TKeeperBaseModel, type TTreeFields } from './nested.model.generated.js';
export type TLeaf = IModel<{ id: string; when?: Date }>;
export type TTree = IModel<{ leaf: TLeaf; leaves: TLeaf[]; maybe: TLeaf | null }>;
export type TStamped = IModel<{ id: string } & AdditionalProperties<Date>>;
export type TKeeper = IModel<{ stamped: TStamped }>;
export class Tree extends TTreeBaseModel { constructor(values: Partial<TTreeFields> = {}) { super(values); } }
export { TLeafBaseModel, TStampedBaseModel, TKeeperBaseModel };
`;

const LEAF = { id: 'a' };
const TREE = { leaf: LEAF, leaves: [LEAF, LEAF], maybe: null };
type Models = Record<string, new (values?: object) => object>;

const buildFor = (validation: boolean) => onceShared(async () => {
  const { root, sourceRoot } = createModelProject(fileFixtureScope(), { prefix: 'golem-nested-non-object-', name: 'nested-non-object', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'nested.model.ts'), SOURCE);
  writeModelGolemYaml(root, { mobx: false, validation, exact: false });
  await buildModelProject(root);
  const models = await import(pathToFileURL(path.join(root, 'build/nested.model.js')).href) as Models;
  const codec = (name: string) => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return { models, tree: codec('TTree'), keeper: codec('TKeeper') };
});

const builds = new Map([[true, buildFor(true)], [false, buildFor(false)]]);

/** The message, issue paths and input flag of the rejection, or the decoded value. */
function outcome(decode: () => unknown): string {
  try {
    return `decoded ${JSON.stringify(decode())}`;
  } catch (error) {
    if (!(error instanceof LibError)) return `not a LibError: ${String(error)}`;
    assert.equal(error.kind, LibErrorKind.Deserialization);
    return `${error.message} @${JSON.stringify(error.issues.map((issue) => [...issue.path]))} input=${error.causedByInput}`;
  }
}

test('with validation on, the validator rejects a nested value that is no object before the conversion runs', async () => {
  // protects: T-646 the validated call keeps the validator's error; only an unvalidated decode reaches the class guard
  const { models, tree } = await builds.get(true)!();
  assert.throws(() => tree.fromWireFormat({ ...TREE, leaf: 'text' }, { construct: models.Tree as never }), (error) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

for (const validation of [true, false]) {
  test(`a class field given a value that is no object is rejected, not built empty (validation ${validation})`, async () => {
    // protects: T-646 fromWireFormat and parse built an empty model from 'text' or null in a nested class field; golem rejects bad input and never coerces it (F-39)
    const { models, tree, keeper } = await builds.get(validation)!();
    const options = { validate: false, construct: models.Tree as never };
    const keeperOptions = { validate: false, construct: models.TKeeperBaseModel as never };
    const rows: [string, () => unknown, string][] = [
      ['text', () => tree.fromWireFormat({ ...TREE, leaf: 'text' }, options), 'TLeafBaseModel expected an object. @[["leaf"]] input=true'],
      ['null', () => tree.fromWireFormat({ ...TREE, leaf: null }, options), 'TLeafBaseModel expected an object. @[["leaf"]] input=true'],
      ['item', () => tree.fromWireFormat({ ...TREE, leaves: [LEAF, 5] }, options), 'TLeafBaseModel expected an object. @[["leaves",1]] input=true'],
      ['maybe text', () => tree.fromWireFormat({ ...TREE, maybe: 'text' }, options), 'TLeafBaseModel expected an object. @[["maybe"]] input=true'],
      ['map text', () => keeper.fromWireFormat({ stamped: 'text' }, keeperOptions), 'TStampedBaseModel expected an object. @[["stamped"]] input=true'],
      ['parse text', () => tree.parse(JSON.stringify({ ...TREE, leaf: 'text' }), options), 'TLeafBaseModel expected an object. @[["leaf"]] input=true'],
      ['parse null', () => tree.parse(JSON.stringify({ ...TREE, leaf: null }), options), 'TLeafBaseModel expected an object. @[["leaf"]] input=true'],
      ['parse item', () => tree.parse(JSON.stringify({ ...TREE, leaves: [LEAF, 5] }), options), 'TLeafBaseModel expected an object. @[["leaves",1]] input=true'],
      ['parse map text', () => keeper.parse(JSON.stringify({ stamped: 'text' }), keeperOptions), 'TStampedBaseModel expected an object. @[["stamped"]] input=true'],
    ];
    const actual = Object.fromEntries(rows.map(([name, decode]) => [name, outcome(decode)]));
    assert.deepEqual(actual, Object.fromEntries(rows.map(([name, , expected]) => [name, expected])));
    // A nullable field still takes null.
    assert.match(outcome(() => tree.fromWireFormat(TREE, options)), /^decoded \{"leaf":\{"id":"a"\},"leaves":\[\{"id":"a"\},\{"id":"a"\}\],"maybe":null\}$/);
  });
}
