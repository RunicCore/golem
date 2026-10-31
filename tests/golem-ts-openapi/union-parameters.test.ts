// lane: typescript6 Checker guards: the rewrite scan reads the variants of a union parameter with the checker
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runPipeline } from '#golem/cli';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { startNestApp } from '../support/nest-app.js';
import { command, golem } from '../support/process.js';

const MODELS = `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
export type TCircle = IModel<{ kind: 'circle'; radius: number }>;
export type TRect = IModel<{ kind: 'rect'; width: number; height: number }>;
export type TByName = IObject<{ by: 'name'; name: string; limit?: number }>;
export type TById = IObject<{ by: 'id'; id: number }>;
export type TShape = (TCircle | TRect) & Discriminator<'kind'>;
`;

const CONTROLLER = `import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { TById, TByName, TCircle, TRect, TShape } from './shapes.model.js';
type Tagged<U> = U & Discriminator<'kind'>;
type TaggedBy<U> = U & Discriminator<'by'>;
@Controller('shapes')
export class ShapesController {
  @Post() draw(@Body() shape: (TCircle | TRect) & Discriminator<'kind'>) { return { received: shape }; }
  @Post('named') drawNamed(@Body() shape: TShape) { return { received: shape }; }
  @Get() find(@Query() search: (TByName | TById) & Discriminator<'by'>) { return { received: search }; }
  @Post('wrapped') drawWrapped(@Body() shape: Tagged<TCircle | TRect>) { return { received: shape }; }
  @Get('wrapped') findWrapped(@Query() search: TaggedBy<TByName | TById>) { return { received: search }; }
}
`;

const yaml = (openapiVersion: string) => `version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/shapes.controller.ts\n    output: generated/api.json\n    openapiVersion: "${openapiVersion}"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n`;

function project(t: Parameters<typeof createControllerFixture>[0], openapiVersion = '3.2.0') {
  return createControllerFixture(t, {
    prefix: 'golem-union-parameters-',
    links: 'workspace',
    tsconfig: { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, skipLibCheck: true, outDir: 'build', rootDir: 'src', types: ['node'] }, include: ['src/**/*.ts'] },
    files: { 'src/shapes.model.ts': MODELS, 'src/shapes.controller.ts': CONTROLLER, 'golem.yaml': yaml(openapiVersion) },
  });
}

test('NestModelInterceptor converts each variant of a tagged object union in a whole @Body() and @Query() and answers 400 for an unknown tag', async (t) => {
  // protects: T-390 E-50 a tagged object union parameter gets a codec the interceptor binds, so each variant converts
  // protects: T-619 the generic wrapper Tagged<A | B> on @Body() and @Query() binds like the written form
  const root = project(t);
  const built = await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  await runPipeline(path.join(root, 'golem.yaml'), { check: true });
  const { ShapesController } = await import(pathToFileURL(path.join(root, 'build/shapes.controller.js')).href) as { ShapesController: new () => object };
  const application = await startNestApp([ShapesController]);
  try {
    const url = await application.getUrl();
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`${url}/shapes${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { received?: unknown; issues?: { path: unknown[] }[] } };
    };
    for (const route of ['', '/named', '/wrapped']) {
      assert.deepEqual(await post(route, { kind: 'circle', radius: 2 }), { status: 201, body: { received: { kind: 'circle', radius: 2 } } }, route);
      assert.deepEqual(await post(route, { kind: 'rect', width: 3, height: 4 }), { status: 201, body: { received: { kind: 'rect', width: 3, height: 4 } } }, route);
    }
    const wrongField = await post('', { kind: 'rect', width: 3, height: 'x' });
    assert.equal(wrongField.status, 400);
    assert.deepEqual(wrongField.body.issues!.map(issue => issue.path), [['height']]);
    assert.equal((await post('', { kind: 'triangle', width: 3 })).status, 400);
    assert.equal((await post('', { radius: 2 })).status, 400);
    assert.equal((await post('/wrapped', { kind: 'triangle', width: 3 })).status, 400);
    // Input the model cannot be picked from is a 400 with the issues of the input, never a 500: a request can send any JSON.
    const faults: readonly (readonly [string, string | undefined])[] = [
      ['no body', undefined],
      ['an array body', '[]'],
      ['a string body', '"circle"'],
      ['a null body', 'null'],
      ['a tag of the wrong type', '{"kind":1,"radius":2}'],
      ['an object tag whose toString is not a function', '{"kind":{"toString":1},"radius":2}'],
      ['a tag that only a prototype holds', '{"__proto__":{"kind":"circle"},"radius":2}'],
    ];
    for (const [name, text] of faults) {
      const response = await fetch(`${url}/shapes`, { method: 'POST', ...(text === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: text }) });
      assert.equal(response.status, 400, name);
      if (name === 'an array body' || name.includes('tag')) assert.ok(((await response.json()) as { issues?: unknown[] }).issues?.length, `${name} reports its issues`);
    }

    const get = async (query: string, route = '') => {
      const response = await fetch(`${url}/shapes${route}?${query}`);
      return { status: response.status, body: await response.json() as { received?: unknown } };
    };
    assert.deepEqual(await get('by=name&name=7&limit=3'), { status: 200, body: { received: { by: 'name', name: '7', limit: 3 } } });
    assert.deepEqual(await get('by=id&id=7'), { status: 200, body: { received: { by: 'id', id: 7 } } });
    assert.equal((await get('by=id&id=x')).status, 400);
    assert.equal((await get('by=other')).status, 400);
    assert.deepEqual(await get('by=id&id=7', '/wrapped'), { status: 200, body: { received: { by: 'id', id: 7 } } });
    assert.deepEqual(await get('by=name&name=7&limit=3', '/wrapped'), { status: 200, body: { received: { by: 'name', name: '7', limit: 3 } } });
    assert.equal((await get('by=other', '/wrapped')).status, 400);
  } finally {
    await application.close();
  }
});

interface Operation { readonly parameters?: readonly { readonly in: string; readonly content: Record<string, { readonly schema: unknown }> }[]; readonly requestBody?: { readonly content: Record<string, { readonly schema: unknown }> } }

test('the controllers job documents a union of models as oneOf with a discriminator and records the variant ids for golem check only', async (t) => {
  // protects: T-390 E-50 the document and the operation codecs describe the union that the interceptor converts
  const root = project(t);
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });
  const document = JSON.parse(fs.readFileSync(path.join(root, 'generated/api.json'), 'utf8')) as { paths: Record<string, Record<string, Operation>> };
  assert.deepEqual(document.paths['/shapes']!.post!.requestBody!.content['application/json']!.schema, {
    discriminator: { propertyName: 'kind', mapping: { circle: '#/components/schemas/TCircle', rect: '#/components/schemas/TRect' } },
    oneOf: [{ $ref: '#/components/schemas/TCircle' }, { $ref: '#/components/schemas/TRect' }],
  });
  assert.deepEqual(document.paths['/shapes']!.get!.parameters![0]!.content['application/x-www-form-urlencoded']!.schema, {
    discriminator: { propertyName: 'by', mapping: { id: '#/components/schemas/TById', name: '#/components/schemas/TByName' } },
    oneOf: [{ $ref: '#/components/schemas/TById' }, { $ref: '#/components/schemas/TByName' }],
  });
  // protects: T-619 the generic wrapper documents the same discriminator and variants as the written form
  const bodyOf = (route: string) => document.paths[route]!.post!.requestBody!.content['application/json']!.schema;
  const queryOf = (route: string) => document.paths[route]!.get!.parameters![0]!.content['application/x-www-form-urlencoded']!.schema;
  assert.deepEqual(bodyOf('/shapes/wrapped'), bodyOf('/shapes'));
  assert.deepEqual(queryOf('/shapes/wrapped'), queryOf('/shapes'));
  const registry = fs.readFileSync(path.join(root, 'src/generated/operation-codecs.ts'), 'utf8');
  assert.match(registry, /"ShapesController\.draw": \{\s*"input": \[\s*"TCircle_[0-9a-f]{8}",\s*"TRect_[0-9a-f]{8}"\s*\]/);
  assert.match(registry, /"ShapesController\.find": \{\s*"query": \[\s*"TByName_[0-9a-f]{8}",\s*"TById_[0-9a-f]{8}"\s*\]/);
  assert.match(registry, /export const OPERATION_CODECS = \{\} as const;/, 'no route key reads a union as one model');
  assert.match(registry, /export const OPERATION_QUERY_CODECS = \{\} as const;/);
});

test('the controllers job stops a whole @Query() union on OpenAPI 3.1, which has no querystring to hold it', async (t) => {
  // protects: T-390 a union the 3.1 format cannot express is refused at generation
  await assert.rejects(runPipeline(path.join(project(t, '3.1.2'), 'golem.yaml')), (error: Error) => error.message.includes('NEST1108') && /cannot express a union of models/.test(error.message));
});

test('the controllers job documents a one-field union of models as a property of the request body', async (t) => {
  // protects: T-756 the document a client reads describes the one-field union the handler reads; the build tools report the interceptor limit
  const oneField = createControllerFixture(t, {
    prefix: 'golem-union-field-',
    links: 'workspace',
    files: {
      'src/shapes.model.ts': MODELS,
      'src/shapes.controller.ts': `import { Body, Controller, Post } from '@nestjs/common';\nimport type { TShape } from './shapes.model.js';\n@Controller('shapes')\nexport class ShapesController {\n  @Post() draw(@Body('shape') shape: TShape) { return shape; }\n}\n`,
      'golem.yaml': yaml('3.2.0'),
    },
  });
  await runPipeline(path.join(oneField, 'golem.yaml'));
  const document = JSON.parse(fs.readFileSync(path.join(oneField, 'generated/api.json'), 'utf8')) as { paths: Record<string, Record<string, Operation>> };
  assert.deepEqual(document.paths['/shapes']!.post!.requestBody, {
    required: true,
    content: { 'application/json': { schema: { type: 'object', properties: { shape: {
      discriminator: { propertyName: 'kind', mapping: { circle: '#/components/schemas/TCircle', rect: '#/components/schemas/TRect' } },
      oneOf: [{ $ref: '#/components/schemas/TCircle' }, { $ref: '#/components/schemas/TRect' }],
    } }, required: ['shape'] } } },
  });
});
