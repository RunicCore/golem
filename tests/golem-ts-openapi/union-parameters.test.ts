// lane: typescript6 Checker guards: the rewrite scan reads the variants of a union parameter with the checker
import 'reflect-metadata';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { command, golem } from '../support/process.js';

const MODELS = `import type { IModel, IObject } from '@exprtlabs/golem/model';
export type TCircle = IModel<{ kind: 'circle'; radius: number }>;
export type TRect = IModel<{ kind: 'rect'; width: number; height: number }>;
export type TByName = IObject<{ by: 'name'; name: string; limit?: number }>;
export type TById = IObject<{ by: 'id'; id: number }>;
export type TShape = TCircle | TRect;
`;

const CONTROLLER = `import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { TById, TByName, TCircle, TRect, TShape } from './shapes.model.js';
@Controller('shapes')
export class ShapesController {
  @Post() draw(@Body() shape: TCircle | TRect) { return { received: shape }; }
  @Post('named') drawNamed(@Body() shape: TShape) { return { received: shape }; }
  @Get() find(@Query() search: TByName | TById) { return { received: search }; }
}
`;

const YAML = 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/shapes.controller.ts\n    output: generated/api.json\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n';

function project(t: Parameters<typeof createControllerFixture>[0], controller: string, prefix = 'golem-union-parameters-') {
  return createControllerFixture(t, {
    prefix,
    links: 'workspace',
    tsconfig: { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, skipLibCheck: true, outDir: 'build', rootDir: 'src', types: ['node'] }, include: ['src/**/*.ts'] },
    files: { 'src/shapes.model.ts': MODELS, 'src/shapes.controller.ts': controller, 'golem.yaml': YAML },
  });
}

test('NestModelInterceptor converts each variant of a tagged object union in a whole @Body() and @Query() and answers 400 for an unknown tag', async (t) => {
  // protects: T-390 E-50 a tagged object union parameter gets a codec the interceptor binds, so each variant converts
  const root = project(t, CONTROLLER);
  const built = await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const { ShapesController } = await import(pathToFileURL(path.join(root, 'build/shapes.controller.js')).href) as { ShapesController: new () => object };
  class AppModule {}
  Module({ controllers: [ShapesController] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
  try {
    const url = await application.getUrl();
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`${url}/shapes${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { received?: unknown; issues?: { path: unknown[] }[] } };
    };
    for (const route of ['', '/named']) {
      assert.deepEqual(await post(route, { kind: 'circle', radius: 2 }), { status: 201, body: { received: { kind: 'circle', radius: 2 } } }, route);
      assert.deepEqual(await post(route, { kind: 'rect', width: 3, height: 4 }), { status: 201, body: { received: { kind: 'rect', width: 3, height: 4 } } }, route);
    }
    const wrongField = await post('', { kind: 'rect', width: 3, height: 'x' });
    assert.equal(wrongField.status, 400);
    assert.deepEqual(wrongField.body.issues!.map(issue => issue.path), [['height']]);
    assert.equal((await post('', { kind: 'triangle', width: 3 })).status, 400);
    assert.equal((await post('', { radius: 2 })).status, 400);

    const get = async (query: string) => {
      const response = await fetch(`${url}/shapes?${query}`);
      return { status: response.status, body: await response.json() as { received?: unknown } };
    };
    assert.deepEqual(await get('by=name&name=7&limit=3'), { status: 200, body: { received: { by: 'name', name: '7', limit: 3 } } });
    assert.deepEqual(await get('by=id&id=7'), { status: 200, body: { received: { by: 'id', id: 7 } } });
    assert.equal((await get('by=id&id=x')).status, 400);
    assert.equal((await get('by=other')).status, 400);
  } finally {
    await application.close();
  }
});
