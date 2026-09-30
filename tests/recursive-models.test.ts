import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { generate } from '#model/generator';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject, writeModelSources } from './model-project.js';
import { ttscEnv } from './support/process.js';

const sources = {
  'tree.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { NodeBase, LeftBase, RightBase } from './tree.model.generated.js';
export type TNode = IModel<{ at: Date; children: TNode[] }>;
export type TLeft = IModel<{ at: Date; right?: TRight }>;
export type TRight = IModel<{ at: Date; lefts: TLeft[] }>;
export class Node extends NodeBase {}
export class Left extends LeftBase {}
export class Right extends RightBase {}
`,
};

type Codec = (value: unknown, options?: object) => unknown;
type Codecs = Record<string, Codec>;

/** Compare wire values as JSON data; prototype and absent-field details belong to the wire-format suite. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const profiles: readonly (readonly [string, GolemProfile])[] = [
  ['validation off', { mobx: false, validation: false }],
  ['runtime Ajv', { mobx: false, validation: true }],
  ['standalone', { mobx: false, validation: true, ajvStandalone: true }],
];

for (const [label, profile] of profiles) {
  test(`self- and mutually recursive models generate and round-trip (${label})`, async (t: TestContext) => {
    const { root, sourceRoot } = createModelProject(t, {
      prefix: 'golem-recursive-models-', linkTypescript: true, linkTtsc: true, allowJs: profile.ajvStandalone === true,
    });
    writeModelSources(sourceRoot, sources);
    writeGeneratedArtifacts(generate({ root, profile }).artifacts);
    await compileModelProject(root, [], { env: ttscEnv });
    const codecs = await import(pathToFileURL(path.join(root, 'build/tree.model.generated.js')).href) as Codecs;

    const nodeWire = { at: '2024-01-01T00:00:00.000Z', children: [{ at: '2024-01-02T00:00:00.000Z', children: [{ at: '2024-01-03T00:00:00.000Z', children: [] }] }] };
    const node = codecs.fromWireFormatNode(nodeWire) as { children: { children: { at: unknown }[] }[] };
    assert.ok(node.children[0].children[0].at instanceof Date, 'nested dates decode at every depth');
    assert.deepEqual(json(codecs.toWireFormatNode(node)), nodeWire);
    assert.equal(codecs.stringifyNode(node), JSON.stringify(nodeWire));
    assert.deepEqual(json(codecs.toWireFormatNode(codecs.parseNode(JSON.stringify(nodeWire)))), nodeWire);

    const leftWire = { at: '2024-01-01T00:00:00.000Z', right: { at: '2024-01-02T00:00:00.000Z', lefts: [{ at: '2024-01-03T00:00:00.000Z' }] } };
    const left = codecs.fromWireFormatLeft(leftWire) as { right: { lefts: { at: unknown }[] } };
    assert.ok(left.right.lefts[0].at instanceof Date);
    assert.equal(codecs.stringifyLeft(left), JSON.stringify(leftWire));
    assert.deepEqual(json(codecs.toWireFormatLeft(left)), leftWire);

    if (profile.validation) {
      assert.equal(codecs.validateNode(node), true);
      const invalid = { at: new Date(), children: [{ at: new Date(), children: [{ at: 'not a date', children: [] }] }] };
      assert.equal(codecs.validateNode(invalid), false, 'validation reaches recursive children');
      assert.throws(() => codecs.fromWireFormatNode({ at: '2024-01-01T00:00:00.000Z', children: [{ at: 5, children: [] }] }));
    }
    const generated = fs.readFileSync(path.join(root, 'src/tree.model.generated.ts'), 'utf8');
    assert.ok(generated.length < 400_000, `recursive models do not expand inline (${generated.length} bytes)`);
  });
}
