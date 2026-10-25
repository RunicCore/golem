// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

const CONTROLLER = `import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';

export type TCircle = IModel<{ kind: 'circle'; radius: number }>;
export type TRect = IModel<{ kind: 'rect'; width: number }>;
export type TDrawing = IModel<{ shape: TCircle | TRect; mixed: TCircle | { kind: 'label'; text: string } }>;

@Controller('drawings')
export class DrawingsController {
  @Post()
  create(@Body() body: TDrawing): TDrawing { return body; }
}
`;

interface Schema { readonly properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>> }

test('a union of model references documents a discriminator that maps each tag to its component, and a mixed union keeps anyOf', async t => {
  const root = createControllerFixture(t, {
    prefix: 'golem-ts-openapi-union-',
    packageName: 'golem-ts-openapi-union-fixture',
    sourceFile: 'src/drawings.controller.ts',
    source: CONTROLLER,
  });
  const result = await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion: '3.2.0', info: { title: 'Drawings', version: '1' }, profile: { mobx: false, validation: false } });
  const document = JSON.parse(result.artifacts[0]!.content) as { components: { schemas: Record<string, Schema> } };
  const drawing = document.components.schemas.TDrawing;
  assert.ok(drawing, 'TDrawing component');
  assert.deepEqual(drawing.properties?.shape, {
    discriminator: { propertyName: 'kind', mapping: { circle: '#/components/schemas/TCircle', rect: '#/components/schemas/TRect' } },
    oneOf: [{ $ref: '#/components/schemas/TCircle' }, { $ref: '#/components/schemas/TRect' }],
  });
  assert.equal(drawing.properties?.mixed?.discriminator, undefined);
  assert.ok(Array.isArray(drawing.properties?.mixed?.anyOf), 'a union of a reference and an inline object keeps anyOf');
});
