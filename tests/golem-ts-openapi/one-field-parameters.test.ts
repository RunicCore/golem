// lane: typescript6 Checker guards: the controller generator runs the checker in this process
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#ts-openapi/generator';
import { runPipeline } from '#golem/cli';
import { formatOpenApiProblems, validateOpenApiDocument } from '#openapi/openapi-validator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { loadClass, loadClientClass } from '../support/generated-module.js';
import { expectJsonArray, expectJsonObject } from '../support/json.js';
import { startNestApp } from '../support/nest-app.js';
import { command, golem } from '../support/process.js';
import { contentSchema, documentFrom, documentOf, operationOf, parameterOf, propertySchema, refusedWith, requestBodyOf, schemaOf, type OpenApiDocument, type OpenApiSchema } from './openapi-document.js';

const MODEL = `import type { IModel, IObject } from '@exprtlabs/golem/model';
export type TPayment = IModel<{ id: string; amount: number }>;
export type TFilter = IObject<{ status: string; limit?: number; active?: boolean }>;
export type TPayments = TPayment[];
export type TOpen = IModel<{ id: string }, { exact: false }>;
export type TTagged = IObject<{ tags: string[] }>;
export type TNested = IObject<{ inner: { tags?: string[] } }>;
export type TOrder = IModel<{ id: string; mutable: TPayment[]; readonly: readonly TPayment[]; readonlyGeneric: ReadonlyArray<TPayment> }>;
`;

/** The controller `AController` of the project, with `methods` as its body and `preamble` before it. */
const controllerSource = (methods: string, preamble = ''): string => `import { Body, Controller, Get, Post, Query } from '@nestjs/common';\nimport type { TPayment, TPayments, TOpen, TFilter, TTagged, TNested, TOrder } from './payment.model.js';\n${preamble}@Controller('a')\nexport class AController {\n${methods}\n}\n`;

function project(t: TestContext, methods: string, openapiVersion = '3.2.0', preamble = ''): string {
  return createControllerFixture(t, {
    prefix: 'golem-one-field-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': MODEL,
      'src/a.controller.ts': controllerSource(methods, preamble),
      'golem.yaml': `version: 1\nvalidation: true\nts-openapi:\n  docs:\n    - sources:\n        - src/a.controller.ts\n      output: generated/api.json\n      openapiVersion: "${openapiVersion}"\n      info: { title: T, version: "1" }\nmodel: {}\n`,
    },
  });
}

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** Generates the project, checks it against the rewrite, and reads the controllers document. */
async function generatedDocument(root: string): Promise<OpenApiDocument> {
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });
  return documentFrom(JSON.parse(read(root, 'generated/api.json')));
}

const TPAYMENT = { $ref: '#/components/schemas/TPayment' };
const TOPEN = { $ref: '#/components/schemas/TOpen' };
const TFILTER = { $ref: '#/components/schemas/TFilter' };

/** The schema of the JSON request body of the POST at `route`. */
const bodySchema = (document: OpenApiDocument, route: string): OpenApiSchema => contentSchema(requestBodyOf(document, route, 'post'), 'application/json', `request body of POST ${route}`);

for (const openapiVersion of ['3.2.0', '3.1.2']) {
  test(`a one-field model @Body and @Query reach the OpenAPI ${openapiVersion} document`, async (t) => {
    // protects: R-13 T-323 T-442 T-445 T-446 the one-field model parameter, or array of models (readonly too, a whole body, a model field), the interceptor converts is described by the controllers job; a key that the job folds to a string (a concatenation, a constant member) names the body property and the query parameter
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
      // A key that the job folds to a string names the body property and the query parameter.
      "  @Post('folded') folded(@Body('pay' + 'ment') payment: TPayment): void {}",
      "  @Get('folded') foldedList(@Query(KEYS.filter) filter: TFilter): void {}",
    ].join('\n'), openapiVersion, "const KEYS = { filter: 'filter' } as const;\n");
    const document = await generatedDocument(root);
    const payment = { type: 'object', properties: { payment: TPAYMENT }, required: ['payment'] };
    assert.deepEqual(bodySchema(document, '/a'), payment);
    assert.equal(requestBodyOf(document, '/a', 'post').required, true);
    assert.equal(operationOf(document, '/a', 'post').parameters, undefined, 'a body field is no OpenAPI parameter');

    const batch = { type: 'object', properties: { items: { type: 'array', items: TPAYMENT } }, required: ['items'] };
    assert.deepEqual(bodySchema(document, '/a/batch'), batch);
    for (const route of ['generic', 'qualified', 'readonly', 'readonly-generic']) {
      assert.deepEqual(bodySchema(document, `/a/${route}`), batch, route);
    }
    const whole = { type: 'array', items: TPAYMENT };
    assert.deepEqual(bodySchema(document, '/a/whole'), whole);
    for (const route of ['whole-readonly', 'whole-readonly-generic']) {
      assert.deepEqual(bodySchema(document, `/a/${route}`), whole, route);
    }
    const order = schemaOf(document, 'TOrder');
    assert.deepEqual(['mutable', 'readonly', 'readonlyGeneric'].map(name => propertySchema(order, name)), [whole, whole, whole]);

    assert.deepEqual(parameterOf(document, '/a', 'get'), { name: 'filter', in: 'query', required: true, style: 'deepObject', explode: true, schema: TFILTER });

    assert.deepEqual(Object.keys(bodySchema(document, '/a/folded').properties ?? {}), ['payment']);
    assert.deepEqual((operationOf(document, '/a/folded', 'get').parameters ?? []).map(parameter => parameter.name), ['filter']);
  });
}

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
    const document = documentOf(await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion, info: { title: 'T', version: '1' }, profile: { validation: false } }));
    const problems = validateOpenApiDocument(document);
    assert.deepEqual(problems, [], formatOpenApiProblems(problems, pointer => pointer));
    for (const [route, , required, schema] of BODIES) {
      assert.deepEqual(requestBodyOf(document, `/a/${route}`, 'post'), { required, content: { 'application/json': { schema } } }, route);
    }
    assert.deepEqual(operationOf(document, '/a/filtered', 'get').parameters, [{ name: 'filter', in: 'query', required: false, style: 'deepObject', explode: true, schema: TFILTER }]);
  });
}

test('OpenAPI 3.1 documents a named model query beside a whole query as a deepObject parameter and flat parameters', async (t) => {
  // protects: T-756 3.1 can describe both forms, so the controllers job no longer stops them; the build tools report the interceptor limit
  const root = createControllerFixture(t, {
    prefix: 'golem-one-field-mixed-',
    source: `import { Controller, Get, Query } from '@nestjs/common';\n${MODEL}@Controller('a')\nexport class AController {\n  @Get() list(@Query() whole: TFilter, @Query('filter') filter: TFilter): void {}\n}\n`,
  });
  const document = documentOf(await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion: '3.1.2', info: { title: 'T', version: '1' }, profile: { validation: false } }));
  const problems = validateOpenApiDocument(document);
  assert.deepEqual(problems, [], formatOpenApiProblems(problems, pointer => pointer));
  assert.deepEqual(operationOf(document, '/a', 'get').parameters, [
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
  // One project, whose controller each case rewrites: the refusal is the controllers job's, so the job runs, not the pipeline around it.
  const root = project(t, '');
  const refused = (methods: string, openapiVersion: '3.2.0' | '3.1.2'): Promise<unknown> => {
    fs.writeFileSync(path.join(root, 'src/a.controller.ts'), controllerSource(methods));
    return generate({ root, output: path.join(root, 'openapi.json'), openapiVersion, info: { title: 'T', version: '1' }, profile: { validation: false } });
  };
  for (const [methods, code, message] of cases) {
    await assert.rejects(refused(methods, '3.2.0'), refusedWith(code, message), methods);
  }
  // A named model whose name a flat parameter of the whole query also uses cannot share the one (name, in) key of the 3.1 document.
  await assert.rejects(
    refused("  @Get() a(@Query() whole: TFilter, @Query('limit') limit: TFilter): void {}", '3.1.2'),
    refusedWith('NEST1312', /identifies a parameter by its name and location/),
  );
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
      'golem.yaml': 'version: 1\nvalidation: true\nts-openapi:\n  docs:\n    - sources:\n        - src/a.controller.ts\n      output: generated/api.json\n      info: { title: T, version: "1" }\n  extensions:\n    nest: {}\nopenapi-ts:\n  sdks:\n    - input: generated/api.json\n      output: src/sdk\n      name: Api\nmodel: {}\n',
    },
  });
  const built = await command(root, process.execPath, [golem, 'build', '--config', path.join(root, 'golem.yaml')]);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const AController = await loadClass(path.join(root, 'build/a.controller.js'), 'AController');
  const ApiClient = await loadClientClass(path.join(root, 'build/sdk/index.js'), 'ApiClient');
  const application = await startNestApp([AController], { nestedQuery: true });
  try {
    const client = new ApiClient({ baseUrl: await application.getUrl() });
    assert.deepEqual((await client.aController_create().execute({ body: { payment: { id: 'p1', amount: 12 } } })).body, { amount: 12 });
    assert.deepEqual((await client.aController_createBatch().execute({ body: { items: [{ id: 'p1', amount: 12 }, { id: 'p2', amount: 30 }] } })).body, { amount: 42 });
    const rejected = await fetch(`${await application.getUrl()}/a/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: 'p1', amount: 1 }, { id: 'p2', amount: 'x' }] }) });
    assert.equal(rejected.status, 400);
    const { issues } = expectJsonObject(await rejected.json(), 'the 400 body');
    assert.deepEqual(expectJsonArray(issues, 'the 400 issues').map(issue => expectJsonObject(issue, 'an issue').path), [['items', 1, 'amount']]);
    assert.deepEqual((await client.aController_list().execute({ query: { filter: { status: 'paid', limit: 10, active: true } } })).body, { status: 'paid', limit: 10, active: true });
  } finally {
    await application.close();
  }
});
