import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

const HEAD = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { DependentRequired } from '@exprtlabs/golem/tags';\n";
// An unnamed object type with a rule of its own gets a codec of its own (`Anonymous_<hash>`), shared by every model that holds the shape.
const SHARED = "({ card?: string; address?: string } & DependentRequired<{ card: ['address'] }>)";
const OFF = `export type TOff = IModel<{ shared: ${SHARED} }, { validation: false }>;\n`;
const FULL = `export type TFull = IModel<{ shared: ${SHARED} }>;\n`;
// The same shape one level down, in an array item.
const FULL_NESTED = `export type TFull = IModel<{ list: ${SHARED}[] }>;\n`;
const OTHER_OFF = `export type TOtherOff = IModel<{ shared: ${SHARED} }, { validation: false }>;\n`;

type Layout = readonly [name: string, files: Readonly<Record<string, string>>, hold: (shared: object) => object];
const direct = (shared: object): object => ({ shared });
const inList = (shared: object): object => ({ list: [shared] });

/** The model files of each layout, in declaration or file-name order: the off model before the full one, or after it. */
const LAYOUTS: readonly Layout[] = [
  ['one file, off model first', { 'models.model.ts': HEAD + OFF + FULL }, direct],
  ['one file, full model first', { 'models.model.ts': HEAD + FULL + OFF }, direct],
  ['two files, off model first', { 'a-off.model.ts': HEAD + OFF, 'b-full.model.ts': HEAD + FULL }, direct],
  ['two files, full model first', { 'a-full.model.ts': HEAD + FULL, 'b-off.model.ts': HEAD + OFF }, direct],
  ['the full model holds the shape in an array, off model first', { 'models.model.ts': HEAD + OFF + FULL_NESTED }, inList],
  ['the full model holds the shape in an array, off model second', { 'models.model.ts': HEAD + FULL_NESTED + OFF }, inList],
];
const unavailable = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable;

async function load(t: TestContext, files: Readonly<Record<string, string>>) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-shared-anonymous-', name: 'shared-anonymous', linkWorkspaceNodeModules: true });
  writeGeneratedArtifacts(Object.entries(files).map(([name, content]) => ({ path: path.join(sourceRoot, name), content })));
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  for (const name of Object.keys(files)) await import(pathToFileURL(path.join(root, 'build', name.replace(/\.ts$/, '.generated.js'))).href);
  return root;
}

for (const [layout, files, hold] of LAYOUTS) {
  test(`a full model keeps the rule of an object type that an off model holds too (${layout})`, async (t: TestContext) => {
    // protects: T-678 bug: a node first interned by an off model made a full model that shares the shape leave it open
    const root = await load(t, files);
    const full = requireObjectCodec(generatedCodecIdFromRoot(root, 'TFull'));
    const off = requireObjectCodec(generatedCodecIdFromRoot(root, 'TOff'));
    const anonymous = requireObjectCodec(generatedCodecIdFromRoot(root, 'Anonymous'));
    assert.equal(anonymous.validate({ card: 'c' }), false, 'the shared codec validates');
    assert.equal(full.validate(hold({ card: 'c', address: 'a' })), true);
    assert.equal(full.validate(hold({ card: 'c' })), false, 'the shared object keeps its rule');
    assert.throws(() => off.validate(direct({ card: 'c' })), unavailable, 'the off model still has no validate');
  });
}

test('an object type that only off models hold stays unvalidated', async (t: TestContext) => {
  // protects: T-678 shared unnamed types validate only when some validating model holds them
  const root = await load(t, { 'models.model.ts': HEAD + OFF + OTHER_OFF });
  for (const name of ['TOff', 'TOtherOff', 'Anonymous']) {
    assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, name)).validate({ shared: { card: 'c' } }), unavailable, name);
  }
});
