// lane: typescript6 Checker guards: the controller generator runs the checker in this process
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { generate } from '#controllers/generator';
import { runPipeline } from '#golem/cli';
import { formatOpenApiProblems, validateOpenApiDocument } from '#openapi/openapi-validator';
import { NEST_INTERCEPTOR_SOURCE, createControllerFixture } from '../fixture-templates/controllers/project.js';
import { startNestApp } from '../support/nest-app.js';
import { command, golem } from '../support/process.js';

const MODEL = `import type { IModel, IObject } from '@exprtlabs/golem/model';
export type TPayment = IModel<{ id: string; amount: number }>;
export type TFilter = IObject<{ status: string; limit?: number; active?: boolean }>;
export type TPayments = TPayment[];
export type TOpen = IModel<{ id: string }, { exact: false }>;
export type TTagged = IObject<{ tags: string[] }>;
export type TNested = IObject<{ inner: { tags?: string[] } }>;
export type TOrder = IModel<{ id: string; mutable: TPayment[]; readonly: readonly TPayment[]; readonlyGeneric: ReadonlyArray<TPayment> }>;
`;

function project(t: TestContext, methods: string, openapiVersion = '3.2.0', preamble = ''): string {
  return createControllerFixture(t, {
    prefix: 'golem-one-field-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': MODEL,
      'src/a.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';\nimport type { TPayment, TPayments, TOpen, TFilter, TTagged, TNested, TOrder } from './payment.model.js';\n${preamble}@Controller('a')\nexport class AController {\n${methods}\n}\n`,
      'golem.yaml': `version: 1\nvalidation: true\nts-openapi:\n  docs:\n    - sources:\n        - src/a.controller.ts\n      output: generated/api.json\n      openapiVersion: "${openapiVersion}"\n      info: { title: T, version: "1" }\nmodel: {}\n`,
    },
  });
}

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** Generates the project, checks it against the rewrite unless told not to, and reads the controllers document. */
async function generatedDocument(root: string, check = true): Promise<{ paths: Record<string, Record<string, Operation>> }> {
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  if (check) await runPipeline(config, { check: true });
  return JSON.parse(read(root, 'generated/api.json')) as { paths: Record<string, Record<string, Operation>> };
}

interface Operation { readonly parameters?: readonly Record<string, unknown>[]; readonly requestBody?: { readonly required?: boolean; readonly content: Record<string, { readonly schema: Record<string, unknown> }> } }

test('the controllers job names a one-field parameter by a key written as a concatenation or a constant member', async (t) => {
  // protects: T-446 a key that the job folds to a string names the body property and the query parameter
  const root = project(t, [
    "  @Post() create(@Body('pay' + 'ment') payment: TPayment): void {}",
    '  @Get() list(@Query(KEYS.filter) filter: TFilter): void {}',
  ].join('\n'), '3.2.0', "const KEYS = { filter: 'filter' } as const;\n");
  const document = await generatedDocument(root);
  const bodySchema = document.paths['/a']!.post!.requestBody!.content['application/json']!.schema;
  assert.deepEqual(Object.keys(bodySchema.properties as object), ['payment']);
  assert.deepEqual(document.paths['/a']!.get!.parameters!.map(parameter => parameter.name), ['filter']);
});

for (const openapiVersion of ['3.2.0', '3.1.2']) {
  test(`a one-field model @Body and @Query reach the OpenAPI ${openapiVersion} document`, async (t) => {
    // protects: R-13 T-323 T-442 T-445 the one-field model parameter, or array of models (readonly too, a whole body, a model field), the interceptor converts is described by the controllers job
    const root = project(t, [
      "  @Post() create(@Body('payment') payment: TPayment): void {}",
      "  @Post('batch') createBatch(@Body('items') items: TPayment[]): void {}",
      "  @Post('generic') createGeneric(@Body('items') items: Array<TPayment>): void {}",
      "  @Post('readonly') createReadonly(@Body('items') items: readonly TPayment[]): void {}",
      "  @Post('readonly-generic') createReadonlyGeneric(@Body('items') items: ReadonlyArray<TPayment>): void {}",
      "  @Post('qualified') createQualified(@Body('items') items: globalThis.Array<TPayment>): void {}",
      "  @Post('whole') createWhole(@Body() items: TPayment[]): void {}",
      "  @Post('whole-readonly') createWholeReadonly(@Body() items: readonly TPayment[]): void {}",
      "  @Post('whole-readonly-generic') createWholeReadonlyGeneric(@Body() items: ReadonlyArray<TPayment>): void {}",
      "  @Post('order') createOrder(@Body('order') order: TOrder): void {}",
      "  @Get() list(@Query('filter') filter: TFilter): void {}",
    ].join('\n'), openapiVersion);
    const document = await generatedDocument(root);
    const post = document.paths['/a']!.post!;
    const bodySchema = post.requestBody!.content['application/json']!.schema;
    assert.equal(post.requestBody!.required, true);
    assert.deepEqual({ ...bodySchema, properties: Object.keys(bodySchema.properties as object) }, { type: 'object', properties: ['payment'], required: ['payment'] });
    assert.match(JSON.stringify((bodySchema.properties as Record<string, unknown>).payment), /TPayment/);
    assert.equal(post.parameters, undefined, 'a body field is no OpenAPI parameter');

    const batchSchema = document.paths['/a/batch']!.post!.requestBody!.content['application/json']!.schema;
    assert.deepEqual({ ...batchSchema, properties: Object.keys(batchSchema.properties as object) }, { type: 'object', properties: ['items'], required: ['items'] });
    for (const route of ['generic', 'qualified', 'readonly', 'readonly-generic']) {
      assert.deepEqual(document.paths[`/a/${route}`]!.post!.requestBody!.content['application/json']!.schema, batchSchema, route);
    }
    const wholeSchema = document.paths['/a/whole']!.post!.requestBody!.content['application/json']!.schema;
    assert.deepEqual(wholeSchema, { type: 'array', items: { $ref: '#/components/schemas/TPayment' } });
    for (const route of ['whole-readonly', 'whole-readonly-generic']) {
      assert.deepEqual(document.paths[`/a/${route}`]!.post!.requestBody!.content['application/json']!.schema, wholeSchema, route);
    }
    const order = (document as unknown as { components: { schemas: { TOrder: { properties: Record<string, unknown> } } } }).components.schemas.TOrder.properties;
    assert.deepEqual(order.mutable, { type: 'array', items: { $ref: '#/components/schemas/TPayment' } });
    assert.deepEqual([order.readonly, order.readonlyGeneric], [order.mutable, order.mutable]);
    const itemsSchema = (batchSchema.properties as Record<string, { type: string; items: unknown }>).items;
    assert.equal(itemsSchema.type, 'array');
    assert.deepEqual(itemsSchema.items, { $ref: '#/components/schemas/TPayment' });

    const filter = document.paths['/a']!.get!.parameters!.find(parameter => parameter.name === 'filter')!;
    assert.deepEqual({ in: filter.in, style: filter.style, explode: filter.explode, required: filter.required }, { in: 'query', style: 'deepObject', explode: true, required: true });
    assert.match(JSON.stringify(filter.schema), /TFilter/);
  });
}

const TPAYMENT = { $ref: '#/components/schemas/TPayment' };
const TOPEN = { $ref: '#/components/schemas/TOpen' };
const TFILTER = { $ref: '#/components/schemas/TFilter' };
/** The note field of the bodies that mix a whole body with a one-field body. */
const NOTE = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] };

// One row for each body the handler reads: the route, the handler parameters, the request body `required`, the schema, and the decorator before the handler.
const BODIES: readonly (readonly [string, string, boolean, unknown, string?])[] = [
  ['note', "@Body('note') note: string", true, NOTE],
  ['tags', "@Body('tags') tags: string[]", true, { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] }],
  ['optional', "@Body('payment') payment?: TPayment", false, { type: 'object', properties: { payment: TPAYMENT } }],
  ['optional-list', "@Body('items') items?: TPayment[]", false, { type: 'object', properties: { items: { type: 'array', items: TPAYMENT } } }],
  ['optional-and-required', "@Body('note') note: string, @Body('payment') payment?: TPayment", true, { type: 'object', properties: { note: { type: 'string' }, payment: TPAYMENT }, required: ['note'] }],
  ['two-same', '@Body() first: TPayment, @Body() second: TPayment', true, TPAYMENT],
  ['same-field', "@Body('payment') one: TPayment, @Body('payment') two: TPayment", true, { type: 'object', properties: { payment: TPAYMENT }, required: ['payment'] }],
  // A closed model (the default) cannot share the body with a part that adds a property; an open one (exact: false) can.
  ['whole-and-field', "@Body() whole: TOpen, @Body('note') note: string", true, { allOf: [TOPEN, NOTE] }],
  // A closed model beside an optional property is a valid body: only a required property it lacks makes the type empty.
  ['closed-whole-and-optional-field', "@Body() whole: TPayment, @Body('note') note?: string", true, { allOf: [TPAYMENT, { type: 'object', properties: { note: { type: 'string' } } }] }],
  ['field-and-whole', "@Body('note') note: string, @Body() whole: TOpen", true, { allOf: [TOPEN, NOTE] }],
  ['whole-optional', '@Body() whole?: TPayment', false, TPAYMENT],
  ['whole-undefined', '@Body() whole: TPayment | undefined', false, TPAYMENT],
  ['whole-default', "@Body() whole: TPayment = { id: 'a', amount: 1 }", false, TPAYMENT],
  ['whole-optional-and-field', "@Body() whole: TOpen | undefined, @Body('note') note: string", true, { allOf: [TOPEN, NOTE] }],
  // An @ApiBody type replaces the body the handler parameters give, as @nestjs/swagger does.
  ['api-body', "@Body('payment') payment: TPayment", true, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: true }, '@ApiBody({ type: NoteDto })'],
];

for (const openapiVersion of ['3.2.0', '3.1.2'] as const) {
  test(`the OpenAPI ${openapiVersion} document states the body and the query the handler reads, whatever NestModelInterceptor accepts`, async (t) => {
    // protects: T-756 the document a client reads states the real optionality and body shape; the interceptor limits are reported by the build tools, not by the controllers job
    const methods = [
      ...BODIES.map(([route, parameters, , , decorator = '']) => `  ${decorator} @Post('${route}') ${route.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())}(${parameters}): void {}`),
      "  @Get('filtered') filtered(@Query('filter') filter?: TFilter): void {}",
    ].join('\n');
    const root = createControllerFixture(t, {
      prefix: 'golem-one-field-shape-',
      source: `import { Body, Controller, Get, Post, Query } from '@nestjs/common';\nimport { ApiBody, ApiProperty } from '@nestjs/swagger';\n${MODEL}class NoteDto { @ApiProperty() text!: string; }\n@Controller('a')\nexport class AController {\n${methods}\n}\n`,
    });
    const result = await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion, info: { title: 'T', version: '1' }, profile: { mobx: false, validation: false } });
    const document = JSON.parse(result.artifacts[0]!.content) as { paths: Record<string, Record<string, Operation>> };
    const problems = validateOpenApiDocument(document);
    assert.deepEqual(problems, [], formatOpenApiProblems(problems, pointer => pointer));
    for (const [route, , required, schema] of BODIES) {
      assert.deepEqual(document.paths[`/a/${route}`]!.post!.requestBody, { required, content: { 'application/json': { schema } } }, route);
    }
    assert.deepEqual(document.paths['/a/filtered']!.get!.parameters, [{ name: 'filter', in: 'query', required: false, style: 'deepObject', explode: true, schema: TFILTER }]);
  });
}

test('OpenAPI 3.1 documents a named model query beside a whole query as a deepObject parameter and flat parameters', async (t) => {
  // protects: T-756 3.1 can describe both forms, so the controllers job no longer stops them; the build tools report the interceptor limit
  const root = createControllerFixture(t, {
    prefix: 'golem-one-field-mixed-',
    source: `import { Controller, Get, Query } from '@nestjs/common';\n${MODEL}@Controller('a')\nexport class AController {\n  @Get() list(@Query() whole: TFilter, @Query('filter') filter: TFilter): void {}\n}\n`,
  });
  const result = await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion: '3.1.2', info: { title: 'T', version: '1' }, profile: { mobx: false, validation: false } });
  const document = JSON.parse(result.artifacts[0]!.content) as { paths: Record<string, Record<string, Operation>> };
  const problems = validateOpenApiDocument(document);
  assert.deepEqual(problems, [], formatOpenApiProblems(problems, pointer => pointer));
  assert.deepEqual(document.paths['/a']!.get!.parameters, [
    { name: 'status', in: 'query', required: true, style: 'form', explode: true, schema: { type: 'string' } },
    { name: 'limit', in: 'query', required: false, style: 'form', explode: true, schema: { type: 'number' } },
    { name: 'active', in: 'query', required: false, style: 'form', explode: true, schema: { type: 'boolean' } },
    { name: 'filter', in: 'query', required: true, style: 'deepObject', explode: true, schema: TFILTER },
  ]);
});

test('the controllers job stops only what the OpenAPI format cannot describe in a one-field parameter', async (t) => {
  // protects: R-13 T-323 T-442 T-756 T-759 a parameter or body the format cannot hold stops generation with the reason; the interceptor limits do not; a closed model beside a part with a property it lacks is an empty type, named with both parts
  const cases: readonly (readonly [string, string, RegExp])[] = [
    ["  @Post() a(@Body('payment') one: TPayment, @Body('payment') two: TFilter): void {}", 'NEST1107', /@Body\("payment"\) is declared twice with different types, and a request body property has one schema/],
    ["  @Post() a(@Body() whole: TPayment, @Body('note') note: string): void {}", 'NEST1107', /the whole @Body\(\) .*TPayment is a closed model.*the one-field @Body\("note"\) requires the property "note" that it does not declare/],
    ["  @Post() a(@Body('note') note: string, @Body() whole: TPayment): void {}", 'NEST1107', /the whole @Body\(\) .*TPayment is a closed model.*the one-field @Body\("note"\) requires the property "note"/],
    ["  @Post() a(@Body() whole: TPayment, @Body() other: TFilter): void {}", 'NEST1107', /the whole @Body\(\) .* is a closed model.*the whole @Body\(\) .* requires the property/],
    ["  @Get() a(@Query('when') when: Date): void {}", 'NEST1107', /must be primitive/],
    ["  @Get() a(@Query('filter') filter: TFilter[]): void {}", 'NEST1107', /array of models.*does not define arrays in a deepObject.*Send the array in a @Body\./],
    ["  @Get() a(@Query('filter') filter: TTagged): void {}", 'NEST1107', /array field \(tags\).*@Body or in a whole @Query\(\) on OpenAPI 3\.2/],
    ["  @Get() a(@Query('filter') filter: TNested): void {}", 'NEST1107', /array field \(inner\.tags\)/],
    ["  @Get() a(@Query() whole: TFilter, @Query('filter') filter: TFilter): void {}", 'NEST1107', /sends a whole @Query\(\) object as one querystring parameter, which cannot be combined with another @Query\(\) object or with named query parameters/],
    ["  @Get() a(@Query('filter') filter: TFilter, @Query() whole: TFilter): void {}", 'NEST1107', /cannot be combined with another @Query\(\) object or with named query parameters/],
  ];
  for (const [methods, code, message] of cases) {
    await assert.rejects(runPipeline(path.join(project(t, methods, '3.2.0'), 'golem.yaml')), (error: Error) => error.message.includes(code) && message.test(error.message), methods);
  }
  // A named model whose name a flat parameter of the whole query also uses cannot share the one (name, in) key of the 3.1 document.
  await assert.rejects(
    runPipeline(path.join(project(t, "  @Get() a(@Query() whole: TFilter, @Query('limit') limit: TFilter): void {}", '3.1.2'), 'golem.yaml')),
    (error: Error) => error.message.includes('NEST1312') && /identifies a parameter by its name and location/.test(error.message),
  );
});

test('the generated client sends a one-field body model and a one-field query model, and NestModelInterceptor converts both', async (t) => {
  // protects: R-13 T-323 T-442 document, generated client and interceptor agree on the wire form of a one-field model and of a one-field array of models
  const root = createControllerFixture(t, {
    prefix: 'golem-one-field-e2e-',
    links: 'workspace',
    tsconfig: { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, skipLibCheck: true, outDir: 'build', rootDir: 'src', types: ['node'] }, include: ['src/**/*.ts'] },
    files: {
      'src/interceptor.ts': NEST_INTERCEPTOR_SOURCE,
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
      'golem.yaml': 'version: 1\nvalidation: true\nts-openapi:\n  docs:\n    - sources:\n        - src/a.controller.ts\n      output: generated/api.json\n      info: { title: T, version: "1" }\nopenapi-ts:\n  sdks:\n    - input: generated/api.json\n      output: src/sdk\n      name: Api\nmodel: {}\n',
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
  const application = await startNestApp([AController], { nestedQuery: true });
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
