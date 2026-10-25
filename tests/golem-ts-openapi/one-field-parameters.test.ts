// lane: typescript6 Checker guards: the controller generator runs the checker in this process
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
import { runPipeline } from '#golem/cli';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { command, golem } from '../support/process.js';

const MODEL = `import type { IModel, IObject } from '@exprtlabs/golem/model';
export type TPayment = IModel<{ id: string; amount: number }>;
export type TFilter = IObject<{ status: string; limit?: number; active?: boolean }>;
export type TTagged = IObject<{ tags: string[] }>;
export type TNested = IObject<{ inner: { tags?: string[] } }>;
`;

function project(t: TestContext, methods: string, openapiVersion = '3.2.0'): string {
  return createControllerFixture(t, {
    prefix: 'golem-one-field-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': MODEL,
      'src/a.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';\nimport type { TPayment, TFilter, TTagged, TNested } from './payment.model.js';\n@Controller('a')\nexport class AController {\n${methods}\n}\n`,
      'golem.yaml': `version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    openapiVersion: "${openapiVersion}"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n`,
    },
  });
}

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

interface Operation { readonly parameters?: readonly Record<string, unknown>[]; readonly requestBody?: { readonly required?: boolean; readonly content: Record<string, { readonly schema: Record<string, unknown> }> } }

for (const openapiVersion of ['3.2.0', '3.1.2']) {
  test(`a one-field model @Body and @Query reach the OpenAPI ${openapiVersion} document and the operation codecs, and golem check agrees with the rewrite`, async (t) => {
    // protects: R-13 T-323 the one-field model parameter the interceptor converts is described by the controllers job
    const root = project(t, [
      "  @Post() create(@Body('payment') payment: TPayment): void {}",
      "  @Get() list(@Query('filter') filter: TFilter): void {}",
    ].join('\n'), openapiVersion);
    const config = path.join(root, 'golem.yaml');
    await runPipeline(config);
    await runPipeline(config, { check: true });

    const document = JSON.parse(read(root, 'generated/api.json')) as { paths: Record<string, Record<string, Operation>> };
    const post = document.paths['/a']!.post!;
    const bodySchema = post.requestBody!.content['application/json']!.schema;
    assert.equal(post.requestBody!.required, true);
    assert.deepEqual({ ...bodySchema, properties: Object.keys(bodySchema.properties as object) }, { type: 'object', properties: ['payment'], required: ['payment'] });
    assert.match(JSON.stringify((bodySchema.properties as Record<string, unknown>).payment), /TPayment/);
    assert.equal(post.parameters, undefined, 'a body field is no OpenAPI parameter');

    const filter = document.paths['/a']!.get!.parameters!.find(parameter => parameter.name === 'filter')!;
    assert.deepEqual({ in: filter.in, style: filter.style, explode: filter.explode, required: filter.required }, { in: 'query', style: 'deepObject', explode: true, required: true });
    assert.match(JSON.stringify(filter.schema), /TFilter/);

    const registry = read(root, 'src/generated/operation-codecs.ts');
    assert.match(registry, /"AController\.create": \{\s*"fields": \{\s*"body:payment": "TPayment_[0-9a-f]{8}"/);
    assert.match(registry, /"AController\.list": \{\s*"fields": \{\s*"query:filter": "TFilter_[0-9a-f]{8}"/);
  });
}

test('the controllers job refuses what NestModelInterceptor throws for, or cannot convert, in a one-field parameter', async (t) => {
  // protects: R-13 T-323 a one-field parameter the interceptor cannot convert, or that the client would send wrong, stops generation
  const cases: readonly (readonly [string, string, RegExp])[] = [
    ["  @Post() a(@Body('note') note: string): void {}", 'NEST1103', /must be an IModel or IObject/],
    ["  @Post() a(@Body() whole: TPayment, @Body('payment') payment: TPayment): void {}", 'NEST1103', /cannot share an operation with a whole @Body\(\)/],
    ["  @Post() a(@Body('payment') payment: TPayment, @Body() whole: TPayment): void {}", 'NEST1103', /cannot share an operation with a one-field @Body\("field"\)/],
    ["  @Post() a(@Body('payment') one: TPayment, @Body('payment') two: TPayment): void {}", 'NEST1312', /declared more than once/],
    ["  @Post() a(@Body('payment') payment?: TPayment): void {}", 'NEST1103', /optional one-field model.*Make the parameter required/],
    ["  @Get() a(@Query('filter') filter?: TFilter): void {}", 'NEST1107', /optional one-field model.*Make the parameter required/],
    ["  @Get() a(@Query('when') when: Date): void {}", 'NEST1107', /must be primitive/],
    ["  @Get() a(@Query('filter') filter: TTagged): void {}", 'NEST1107', /array field \(tags\).*@Body or in a whole @Query\(\) on OpenAPI 3\.2/],
    ["  @Get() a(@Query('filter') filter: TNested): void {}", 'NEST1107', /array field \(inner\.tags\)/],
  ];
  for (const openapiVersion of ['3.2.0', '3.1.2']) {
    const mixed: readonly (readonly [string, string, RegExp])[] = [
      ["  @Get() a(@Query() whole: TFilter, @Query('filter') filter: TFilter): void {}", 'NEST1107', /cannot share an operation with a whole @Query\(\)/],
      ["  @Get() a(@Query('filter') filter: TFilter, @Query() whole: TFilter): void {}", 'NEST1107', /cannot share an operation with a one-field model/],
    ];
    for (const [methods, code, message] of [...mixed, ...(openapiVersion === '3.2.0' ? cases : [])]) {
      await assert.rejects(runPipeline(path.join(project(t, methods, openapiVersion), 'golem.yaml')), (error: Error) => error.message.includes(code) && message.test(error.message), `${openapiVersion} ${methods}`);
    }
  }
});

test('the generated client sends a one-field body model and a one-field query model, and NestModelInterceptor converts both', async (t) => {
  // protects: R-13 T-323 document, generated client and interceptor agree on the wire form of a one-field model
  const root = createControllerFixture(t, {
    prefix: 'golem-one-field-e2e-',
    links: 'workspace',
    tsconfig: { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, skipLibCheck: true, outDir: 'build', rootDir: 'src', types: ['node'] }, include: ['src/**/*.ts'] },
    files: {
      'src/payment.model.ts': `${MODEL}export type TReceipt = IModel<{ amount: number }>;\n`,
      'src/a.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { TPayment, TFilter, TReceipt } from './payment.model.js';
@Controller('a')
export class AController {
  @Post() create(@Body('payment') payment: TPayment): TReceipt { return { amount: payment.amount }; }
  @Get() list(@Query('filter') filter: TFilter): TFilter { return filter; }
}
`,
      'golem.yaml': 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    info: { title: T, version: "1" }\nopenapi:\n  - input: generated/api.json\n    output: src/sdk\n    name: Api\nmodels:\n  root: .\n',
    },
  });
  const built = await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const { AController } = await import(pathToFileURL(path.join(root, 'build/a.controller.js')).href) as { AController: new () => object };
  const { ApiClient } = await import(pathToFileURL(path.join(root, 'build/sdk/index.js')).href) as { ApiClient: new (options: { baseUrl: string }) => {
    aController_create(): { execute(input: unknown): Promise<{ body: unknown }> };
    aController_list(): { execute(input: unknown): Promise<{ body: unknown }> };
  } };
  class AppModule {}
  Module({ controllers: [AController] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  // Express 5 reads `filter[status]` as one flat key unless the app opts in to nested query keys.
  application.getHttpAdapter().getInstance().set('query parser', 'extended');
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
  try {
    const client = new ApiClient({ baseUrl: await application.getUrl() });
    assert.deepEqual((await client.aController_create().execute({ body: { payment: { id: 'p1', amount: 12 } } })).body, { amount: 12 });
    assert.deepEqual((await client.aController_list().execute({ query: { filter: { status: 'paid', limit: 10, active: true } } })).body, { status: 'paid', limit: 10, active: true });
  } finally {
    await application.close();
  }
});
