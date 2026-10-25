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
export type TPayments = TPayment[];
export type TTagged = IObject<{ tags: string[] }>;
export type TNested = IObject<{ inner: { tags?: string[] } }>;
`;

function project(t: TestContext, methods: string, openapiVersion = '3.2.0', preamble = ''): string {
  return createControllerFixture(t, {
    prefix: 'golem-one-field-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': MODEL,
      'src/a.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';\nimport type { TPayment, TPayments, TFilter, TTagged, TNested } from './payment.model.js';\n${preamble}@Controller('a')\nexport class AController {\n${methods}\n}\n`,
      'golem.yaml': `version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    openapiVersion: "${openapiVersion}"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n`,
    },
  });
}

test('golem check agrees with the controllers job on a field key written as a concatenation or a constant member', async (t) => {
  // protects: T-446 the check names a one-field parameter the way the controllers job does, so a key the job folds to a string is not reported
  const root = project(t, [
    "  @Post() create(@Body('pay' + 'ment') payment: TPayment): void {}",
    '  @Get() list(@Query(KEYS.filter) filter: TFilter): void {}',
  ].join('\n'), '3.2.0', "const KEYS = { filter: 'filter' } as const;\n");
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });
  const registry = read(root, 'src/generated/operation-codecs.ts');
  assert.match(registry, /"AController\.create": \{\s*"fields": \{\s*"body:payment": "TPayment_[0-9a-f]{8}"/);
  assert.match(registry, /"AController\.list": \{\s*"fields": \{\s*"query:filter": "TFilter_[0-9a-f]{8}"/);
});

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

interface Operation { readonly parameters?: readonly Record<string, unknown>[]; readonly requestBody?: { readonly required?: boolean; readonly content: Record<string, { readonly schema: Record<string, unknown> }> } }

for (const openapiVersion of ['3.2.0', '3.1.2']) {
  test(`a one-field model @Body and @Query reach the OpenAPI ${openapiVersion} document and the operation codecs, and golem check agrees with the rewrite`, async (t) => {
    // protects: R-13 T-323 T-442 the one-field model parameter, or array of models, the interceptor converts is described by the controllers job
    const root = project(t, [
      "  @Post() create(@Body('payment') payment: TPayment): void {}",
      "  @Post('batch') createBatch(@Body('items') items: TPayment[]): void {}",
      "  @Post('generic') createGeneric(@Body('items') items: Array<TPayment>): void {}",
      "  @Post('readonly') createReadonly(@Body('items') items: readonly TPayment[]): void {}",
      "  @Post('readonly-generic') createReadonlyGeneric(@Body('items') items: ReadonlyArray<TPayment>): void {}",
      "  @Post('qualified') createQualified(@Body('items') items: globalThis.Array<TPayment>): void {}",
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

    const batchSchema = document.paths['/a/batch']!.post!.requestBody!.content['application/json']!.schema;
    assert.deepEqual({ ...batchSchema, properties: Object.keys(batchSchema.properties as object) }, { type: 'object', properties: ['items'], required: ['items'] });
    for (const route of ['generic', 'qualified']) {
      assert.deepEqual(document.paths[`/a/${route}`]!.post!.requestBody!.content['application/json']!.schema, batchSchema, route);
    }
    for (const route of ['readonly', 'readonly-generic']) {
      const schema = document.paths[`/a/${route}`]!.post!.requestBody!.content['application/json']!.schema;
      assert.equal((schema.properties as Record<string, { type: string }>).items.type, 'array', route);
    }
    const itemsSchema = (batchSchema.properties as Record<string, { type: string; items: unknown }>).items;
    assert.equal(itemsSchema.type, 'array');
    assert.match(JSON.stringify(itemsSchema.items), /TPayment/);

    const filter = document.paths['/a']!.get!.parameters!.find(parameter => parameter.name === 'filter')!;
    assert.deepEqual({ in: filter.in, style: filter.style, explode: filter.explode, required: filter.required }, { in: 'query', style: 'deepObject', explode: true, required: true });
    assert.match(JSON.stringify(filter.schema), /TFilter/);

    const registry = read(root, 'src/generated/operation-codecs.ts');
    assert.match(registry, /"AController\.create": \{\s*"fields": \{\s*"body:payment": "TPayment_[0-9a-f]{8}"/);
    assert.match(registry, /"AController\.createBatch": \{\s*"fields": \{\s*"body:items": "TPayment_[0-9a-f]{8}"/);
    for (const method of ['createGeneric', 'createReadonly', 'createReadonlyGeneric', 'createQualified']) {
      assert.match(registry, new RegExp(`"AController\\.${method}": \\{\\s*"fields": \\{\\s*"body:items": "TPayment_[0-9a-f]{8}"`), method);
    }
    assert.match(registry, /"AController\.list": \{\s*"fields": \{\s*"query:filter": "TFilter_[0-9a-f]{8}"/);
  });
}

test('the controllers job refuses what NestModelInterceptor throws for, or cannot convert, in a one-field parameter', async (t) => {
  // protects: R-13 T-323 T-442 a one-field parameter the interceptor cannot convert, or that the client would send wrong, stops generation
  const cases: readonly (readonly [string, string, RegExp])[] = [
    ["  @Post() a(@Body('note') note: string): void {}", 'NEST1103', /must be an IModel or IObject/],
    ["  @Post() a(@Body() whole: TPayment, @Body('payment') payment: TPayment): void {}", 'NEST1103', /cannot share an operation with a whole @Body\(\)/],
    ["  @Post() a(@Body('payment') payment: TPayment, @Body() whole: TPayment): void {}", 'NEST1103', /cannot share an operation with a one-field @Body\("field"\)/],
    ["  @Post() a(@Body('payment') one: TPayment, @Body('payment') two: TPayment): void {}", 'NEST1312', /declared more than once/],
    ["  @Post() a(@Body('payment') payment?: TPayment): void {}", 'NEST1103', /optional one-field model.*Make the parameter required/],
    ["  @Get() a(@Query('filter') filter?: TFilter): void {}", 'NEST1107', /optional one-field model.*Make the parameter required/],
    ["  @Get() a(@Query('when') when: Date): void {}", 'NEST1107', /must be primitive/],
    ["  @Post() a(@Body('items') items?: TPayment[]): void {}", 'NEST1103', /optional one-field model.*Make the parameter required/],
    ["  @Post() a(@Body('items') items: string[]): void {}", 'NEST1103', /must be an IModel or IObject/],
    ["  @Post() a(@Body('items') items: TPayments): void {}", 'NEST1103', /an array of one written as a type, such as TPayment\[\]/],
    ["  @Post() a(@Body('items') items: TPayment[][]): void {}", 'NEST1103', /must be an IModel or IObject/],
    ["  @Get() a(@Query('filter') filter: TFilter[]): void {}", 'NEST1107', /array of models.*does not define arrays in a deepObject.*Send the array in a @Body\./],
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
  // protects: R-13 T-323 T-442 document, generated client and interceptor agree on the wire form of a one-field model and of a one-field array of models
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
  @Post('batch') createBatch(@Body('items') items: TPayment[]): TReceipt { return { amount: items.reduce((total, item) => total + item.amount, 0) }; }
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
    aController_createBatch(): { execute(input: unknown): Promise<{ body: unknown }> };
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
    assert.deepEqual((await client.aController_createBatch().execute({ body: { items: [{ id: 'p1', amount: 12 }, { id: 'p2', amount: 30 }] } })).body, { amount: 42 });
    const rejected = await fetch(`${await application.getUrl()}/a/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: 'p1', amount: 1 }, { id: 'p2', amount: 'x' }] }) });
    assert.equal(rejected.status, 400);
    assert.deepEqual(((await rejected.json()) as { issues: { path: unknown[] }[] }).issues.map(issue => issue.path), [['items', 1, 'amount']]);
    assert.deepEqual((await client.aController_list().execute({ query: { filter: { status: 'paid', limit: 10, active: true } } })).body, { status: 'paid', limit: 10, active: true });
  } finally {
    await application.close();
  }
});
