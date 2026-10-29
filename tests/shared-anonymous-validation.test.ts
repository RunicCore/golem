import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

const HEAD = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { DependentRequired } from '@exprtlabs/golem/tags';\n";
// An unnamed object type with a rule of its own gets a codec of its own (`Anonymous_<hash>`), shared by every model that holds the shape.
const SHARED = "({ card?: string; address?: string } & DependentRequired<{ card: ['address'] }>)";
const OFF = `export type TOff = IModel<{ shared: ${SHARED} }, { validation: false }>;\n`;
const FULL = `export type TFull = IModel<{ shared: ${SHARED} }>;\n`;

/** The model files of each layout, in declaration or file-name order: the off model before the full one, or after it. */
const LAYOUTS: readonly (readonly [name: string, files: Readonly<Record<string, string>>])[] = [
  ['one file, off model first', { 'models.model.ts': HEAD + OFF + FULL }],
  ['one file, full model first', { 'models.model.ts': HEAD + FULL + OFF }],
  ['two files, off model first', { 'a-off.model.ts': HEAD + OFF, 'b-full.model.ts': HEAD + FULL }],
  ['two files, full model first', { 'a-full.model.ts': HEAD + FULL, 'b-off.model.ts': HEAD + OFF }],
];

for (const [layout, files] of LAYOUTS) {
  test(`a full model keeps the rule of an object type that an off model holds too (${layout})`, async (t: TestContext) => {
    // protects: T-678 bug: a node first interned by an off model made a full model that shares the shape leave it open
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-shared-anonymous-', name: 'shared-anonymous', linkWorkspaceNodeModules: true });
    writeGeneratedArtifacts(Object.entries(files).map(([name, content]) => ({ path: path.join(sourceRoot, name), content })));
    writeModelGolemYaml(root, { mobx: false, validation: true });
    await buildModelProject(root);
    for (const name of Object.keys(files)) await import(pathToFileURL(path.join(root, 'build', name.replace(/\.ts$/, '.generated.js'))).href);
    const full = requireObjectCodec(generatedCodecIdFromRoot(root, 'TFull'));
    const anonymous = requireObjectCodec(generatedCodecIdFromRoot(root, 'Anonymous'));
    assert.equal(anonymous.validate({ card: 'c' }), false, 'the shared codec validates');
    assert.equal(full.validate({ shared: { card: 'c', address: 'a' } }), true);
    assert.equal(full.validate({ shared: { card: 'c' } }), false, 'the shared object keeps its rule');
  });
}
