import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { generate } from '#controllers/generator';
import { validateOpenApiDocument } from '#openapi/openapi-validator';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

const MODELS = `import type { IModel } from '@exprtlabs/golem/model';
import { TTreeBaseModel, TForestBaseModel, TGenericBaseModel } from './tree.model.generated.js';
export interface Tree { name: string; kids: Tree[] }
export interface Page<T> { items: T[]; next?: Page<T> }
export type TTree = IModel<Tree>;
export type TForest = IModel<{ root: Tree }>;
export type TGeneric = IModel<{ page: Page<string> }>;
export class TreeModel extends TTreeBaseModel {}
export class ForestModel extends TForestBaseModel {}
export class GenericModel extends TGenericBaseModel {}
`;

const CONTROLLER = `import { Body, Controller, Post } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/golem/model';
export class Node {
  @ApiProperty() id!: string;
  @ApiProperty({ type: () => [Node] }) children!: Node[];
  @ApiProperty({ type: () => Node, required: false }) parent?: Node;
}
export interface Leaf { name: string; next?: Leaf }
export type TLeafBox = IModel<{ leaf: Leaf }>;
@Controller('nodes')
export class NodesController {
  @Post() create(@Body() body: Node): Node { return body; }
  @Post('leaf') leaf(@Body() body: TLeafBox): TLeafBox { return body; }
}
`;

const loop = (name: string) => ({ $ref: `#/components/schemas/${name}` });

for (const [label, profile] of [['validation off', { mobx: false, validation: false }], ['validation on', { mobx: false, validation: true }]] as readonly (readonly [string, GolemProfile])[]) {
  test(`a self-referencing interface as a model round-trips (${label})`, async (t: TestContext) => {
    // protects: T-418 a recursive interface named as an IModel field type no longer overflows the stack
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-interface-', linkTypescript: true });
    writeModelSources(sourceRoot, { 'tree.model.ts': MODELS });
    writeModelGolemYaml(root, profile);
    const built = await buildModelProject(root);
    assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
    const codecs = await import(pathToFileURL(path.join(root, 'build/tree.model.generated.js')).href) as Record<string, (value: unknown) => unknown>;
    const wire = (name: string, value: unknown): unknown => JSON.parse(JSON.stringify(codecs[`toWireFormat${name}`]!(codecs[`fromWireFormat${name}`]!(value))));
    const tree = { name: 'a', kids: [{ name: 'b', kids: [{ name: 'c', kids: [] }] }] };
    assert.deepEqual(wire('TTree', tree), tree);
    assert.deepEqual(wire('TForest', { root: tree }), { root: tree });
    assert.deepEqual(wire('TGeneric', { page: { items: ['a'], next: { items: ['b'] } } }), { page: { items: ['a'], next: { items: ['b'] } } });
  });

  test(`a controller with a self-referencing class DTO and interface documents a reference loop (${label})`, async (t: TestContext) => {
    // protects: T-418 a recursive class DTO or interface no longer overflows the stack; the document keeps a $ref loop
    const root = createControllerFixture(t, { prefix: 'golem-ts-openapi-recursive-class-', packageName: 'golem-ts-openapi-recursive-class-fixture', sourceFile: 'src/nodes.controller.ts', source: CONTROLLER });
    const result = await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion: '3.1.2', info: { title: 'Nodes', version: '1' }, profile });
    const document = JSON.parse(result.artifacts[0]!.content) as { components: { schemas: unknown } };
    assert.deepEqual(validateOpenApiDocument(document), []);
    assert.deepEqual(document.components.schemas, {
      NodeLoose: {
        type: 'object', additionalProperties: true, required: ['children', 'id'],
        properties: { id: { type: 'string' }, children: { type: 'array', items: loop('NodeLoose') }, parent: { anyOf: [loop('NodeLoose')] } },
      },
      Leaf: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, next: { anyOf: [loop('Leaf')] } } },
      TLeafBox: { type: 'object', additionalProperties: false, required: ['leaf'], properties: { leaf: loop('Leaf') } },
    });
  });
}
