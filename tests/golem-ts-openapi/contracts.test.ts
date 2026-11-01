// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import { linkProjectPackages, readFixture, writeGeneratedArtifacts } from '../fixture-project.js';
import { workspace } from '../support/process.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#controllers/generator';
import { generate as generateModels } from '#model/generator';
import { createContractAnalysis, createProgram } from '@exprtlabs/golem/internal/type-analysis';
import * as ts from '@exprtlabs/golem/internal/ts';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { contentSchema, diagnosticsOf, documentOf, expectSchema, expectValue, operationOf, propertySchema, responseOf, schemaOf, type OpenApiSchema } from './openapi-document.js';

interface FixtureOptions {
  readonly classValidator?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

function anyOfSchemas(schema: OpenApiSchema, label: string): readonly OpenApiSchema[] {
  return expectValue(schema.anyOf, `${label}.anyOf`).map((item, index) => expectSchema(item, `${label}.anyOf[${index}]`));
}

function fixture(t: TestContext, source: string, options: FixtureOptions = {}): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-contract-',
    packageName: 'golem-ts-openapi-contract-fixture',
    sourceFile: 'src/contracts.controller.ts',
    source,
    files: {
      ...options.files,
      ...(options.classValidator ? {
        'node_modules/class-validator/package.json': readFixture('controllers/contracts/ignores-class-validator-decorators-when-inferring-an-ordinary-dto/class-validator/package.json'),
        'node_modules/class-validator/index.d.ts': readFixture('controllers/contracts/ignores-class-validator-decorators-when-inferring-an-ordinary-dto/class-validator/index.d.ts'),
      } : {}),
    },
  });
}

async function generateFixture(
  root: string,
  openapiVersion: '3.2.0' | '3.1.2' = '3.2.0',
): Promise<Awaited<ReturnType<typeof generate>>> {
  return generate({
    root,
    output: path.join(root, `openapi-${openapiVersion}.json`),
    openapiVersion,
    info: { title: 'Contract fixture', version: '1' },
    profile: { validation: false },
  });
}

test('uses the IModel wire TSerde contract before any model companion exists', async t => {
  const root = fixture(t, readFixture("controllers/contracts/uses-the-imodel-wire-tserde-contract-before-any-model-companion-exists/controller.ts"));

  assert.equal(fs.existsSync(path.join(root, 'src/payment.model.generated.ts')), false);
  const document = documentOf(await generateFixture(root));
  const amount = propertySchema(schemaOf(document, 'TPayment'), 'amount');
  assert.equal(amount.type, 'string');
  assert.equal(amount.pattern, '^[0-9]+$');
  assert.equal(amount.allOf, undefined);
  assert.doesNotMatch(JSON.stringify(amount), /"minimum"/, 'model-side numeric bounds must not leak across the wire boundary');
});

test('retains a nullable IModel alias through a generic Maybe wrapper', async t => {
  const root = fixture(t, readFixture("controllers/contracts/retains-a-nullable-imodel-alias-through-a-generic-maybe-wrapper/controller.ts"));

  const document = documentOf(await generateFixture(root));
  const operation = operationOf(document, '/payments', 'post');
  const request = contentSchema(expectValue(operation.requestBody, 'nullable request body'), 'application/json', 'nullable request body');
  const response = contentSchema(responseOf(document, '/payments', 'post', '201'), 'application/json', 'nullable response');
  for (const [label, schema] of [['request', request], ['response', response]] as const) {
    const variants = anyOfSchemas(schema, `nullable ${label}`);
    assert.equal(variants.filter(item => item.type === 'null').length, 1, `${label} keeps its null branch`);
    assert.equal(variants.filter(item => item.$ref === '#/components/schemas/TPayment').length, 1, `${label} keeps its model reference`);
  }
});

test('resolves a nullable model class through an imported base chain before runtime generation', async t => {
  const root = fixture(t, readFixture("controllers/contracts/resolves-a-nullable-model-class-through-an-imported-base-chain-before-runtime/controller.ts"), {
    files: {
      'src/payment.model.ts': readFixture("controllers/contracts/resolves-a-nullable-model-class-through-an-imported-base-chain-before-runtime/payment.model.ts"),
      'src/payment.base.ts': readFixture('controllers/contracts/resolves-a-nullable-model-class-through-an-imported-base-chain-before-runtime/payment.base.ts'),
      'src/payment.model.generated.ts': readFixture('controllers/contracts/resolves-a-nullable-model-class-through-an-imported-base-chain-before-runtime/payment.model.generated.ts'),
    },
  });

  const document = documentOf(await generateFixture(root));
  const response = contentSchema(responseOf(document, '/payments/{id}', 'get', '200'), 'application/json', 'class response');
  const variants = anyOfSchemas(response, 'class nullable response');
  assert.equal(variants.filter(item => item.type === 'null').length, 1);
  assert.equal(variants.filter(item => item.$ref === '#/components/schemas/Payment').length, 1);
  assert.equal(schemaOf(document, 'Payment').type, 'object');
});

test('deduplicates equivalent nested model projections in the emitted components graph', async t => {
  const root = fixture(t, readFixture("controllers/contracts/deduplicates-equivalent-nested-model-projections-in-the-emitted-components-gra/controller.ts"));

  const document = documentOf(await generateFixture(root));
  const schemas = expectValue(expectValue(document.components, 'OpenAPI components').schemas, 'OpenAPI component schemas');
  assert.ok(schemas.TAddressOmitId, 'the smallest derived name survives deduplication');
  assert.equal(schemas.TAddressPickCity, undefined, 'the equivalent projection redirects to it');
  const envelope = schemaOf(document, 'TEnvelope');
  const omitted = propertySchema(envelope, 'omitted');
  const selected = propertySchema(envelope, 'selected');
  assert.equal(omitted.$ref, '#/components/schemas/TAddressOmitId');
  assert.equal(omitted.$ref, selected.$ref, 'all equivalent projection references redirect to one component');
  assert.equal(schemas.TAddress, undefined, 'unreferenced source model is not emitted');
});

test('emits a lossless whole querystring schema in 3.2 and rejects cross-field flattening in 3.1.2', async t => {
  const root = fixture(t, readFixture("controllers/contracts/emits-a-lossless-whole-querystring-schema-in-3-2-and-rejects-cross-field-flatt/controller.ts"));

  const document = documentOf(await generateFixture(root, '3.2.0'));
  const operation = operationOf(document, '/search', 'get');
  const querystring = expectValue(operation.parameters?.find(item => item.in === 'querystring'), 'OpenAPI 3.2 querystring parameter');
  assert.equal(querystring.name, 'query');
  const querySchema = contentSchema(querystring, 'application/x-www-form-urlencoded', 'querystring');
  assert.deepEqual(querySchema.dependentRequired, { min: ['max'] });
  const min = propertySchema(querySchema, 'min');
  assert.equal(min.type, 'string');
  assert.equal(min.pattern, '^[0-9]+$');
  assert.equal(min.allOf, undefined);

  await assert.rejects(
    generateFixture(root, '3.1.2'),
    (error: unknown) => diagnosticsOf(error).some(item => item.code === 'NEST1108'),
  );
});

test('reports a route path placeholder without a matching @Param declaration', async t => {
  const root = fixture(t, readFixture("controllers/contracts/reports-a-route-path-placeholder-without-a-matching-param-declaration/controller.ts"));

  await assert.rejects(
    generateFixture(root),
    (error: unknown) => diagnosticsOf(error).some(item => item.code === 'NEST1303')
      || /no matching @Param/i.test(String(error)),
  );
});

test('requires explicit Swagger content metadata for primitive responses', async t => {
  const root = fixture(t, readFixture("controllers/contracts/requires-explicit-swagger-content-metadata-for-primitive-responses/controller.ts"));

  await assert.rejects(
    generateFixture(root),
    (error: unknown) => diagnosticsOf(error).some(item => item.code === 'NEST1310'),
  );
});

test('keeps void success status at 200 unless Nest explicitly sets 204', async t => {
  const root = fixture(t, readFixture("controllers/contracts/keeps-void-success-status-at-200-unless-nest-explicitly-sets-204/controller.ts"));

  const document = documentOf(await generateFixture(root));
  assert.ok(responseOf(document, '/status/default', 'get', '200'));
  assert.equal(operationOf(document, '/status/default', 'get').responses['204'], undefined);
  assert.ok(responseOf(document, '/status/explicit', 'delete', '204'));
  assert.equal(operationOf(document, '/status/explicit', 'delete').responses['200'], undefined);
});

test('reads actual Swagger response aliases and preserves their statuses', async t => {
  const root = fixture(t, readFixture("controllers/contracts/reads-actual-swagger-response-aliases-and-preserves-their-statuses/controller.ts"));

  const document = documentOf(await generateFixture(root));
  assert.equal(responseOf(document, '/aliases/ok', 'get', '200').description, 'ok');
  assert.equal(responseOf(document, '/aliases/created', 'post', '201').description, 'created');
  assert.equal(contentSchema(responseOf(document, '/aliases/text', 'get', '200'), 'application/json', 'text response').type, 'string');
  assert.equal(contentSchema(responseOf(document, '/aliases/primitive', 'get', '200'), 'application/json', 'primitive constructor response').type, 'string');
  assert.equal(responseOf(document, '/aliases/empty', 'delete', '204').description, 'empty');
});

test('ignores class-validator decorators when inferring an ordinary DTO', async t => {
  const root = fixture(t, readFixture("controllers/contracts/ignores-class-validator-decorators-when-inferring-an-ordinary-dto/controller.ts"), { classValidator: true });

  const document = documentOf(await generateFixture(root));
  const schema = contentSchema(responseOf(document, '/ordinary', 'get', '200'), 'application/json', 'ordinary response');
  const email = propertySchema(schema, 'email');
  assert.equal(email.type, 'string');
  assert.equal(email.format, undefined);
  assert.equal(email.minimum, undefined);
});

test('rejects a root IModel union before emitting a controller artifact', async t => {
  const root = fixture(t, readFixture("controllers/contracts/rejects-a-root-imodel-union-before-emitting-a-controller-artifact/controller.ts"));

  await assert.rejects(
    generateFixture(root),
    (error: unknown) => /RUNM1052.*must be an object type, but .* has a union/.test(String(error)),
  );
});

test('unresolved controller contract types fail instead of becoming unrestricted schemas', async t => {
  const root = fixture(t, readFixture("controllers/contracts/unresolved-controller-contract-types-fail-instead-of-becoming-unrestricted-sch/controller.ts"));
  await assert.rejects(generateFixture(root), /RUNM1058.*could not be resolved/);
});

test('same-name same-shape class and plain models share one component', async t => {
  const controller = (directory: string, route: string): string => [
    "import { Body, Controller, Post } from '@nestjs/common';",
    `import { type TPayment } from './${directory}/payment.model.js';`,
    `@Controller('${route}')`,
    `export class ${route[0]?.toUpperCase()}${route.slice(1)}Controller {`,
    '  @Post()',
    '  create(@Body() input: TPayment): TPayment { return input; }',
    '}',
    '',
  ].join('\n');
  const model = (declaration: 'IModel' | 'IObject'): string => [
    `import type { ${declaration} } from '@exprtlabs/golem/model';`,
    `export type TPayment = ${declaration}<{ amount: string }>;`,
    '',
  ].join('\n');
  const root = fixture(t, controller('billing', 'billing'), {
    files: {
      'src/billing/payment.model.ts': model('IModel'),
      'src/payout/payment.model.ts': model('IObject'),
      'src/payout.controller.ts': controller('payout', 'payout'),
    },
  });
  const contracts = await generateFixture(root);
  const document = documentOf(contracts);
  assert.deepEqual(Object.keys(expectValue(document.components, 'OpenAPI components').schemas ?? {}), ['TPayment'], 'one shared component');
});

test('exact: false gives a model with no exact option an open schema', async t => {
  const root = fixture(t, [
    "import { Body, Controller, Post } from '@nestjs/common';",
    "import { type TPayment } from './payment.model.js';",
    "@Controller('payments')",
    'export class PaymentController {',
    '  @Post()',
    '  create(@Body() input: TPayment): TPayment { return input; }',
    '}',
    '',
  ].join('\n'), {
    files: { 'src/payment.model.ts': "import type { IObject } from '@exprtlabs/golem/model';\nexport type TPayment = IObject<{ amount: string }>;\n" },
  });
  const contracts = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Contract fixture', version: '1' },
    profile: { validation: false },
    exact: false,
  });
  assert.equal(schemaOf(documentOf(contracts), 'TPayment').additionalProperties, true);
});

/** One route per model file; every model is `TPayment` and `field` makes its schema differ. */
async function clashComponents(t: TestContext, models: Record<string, string>): Promise<string[]> {
  const files: Record<string, string> = {};
  const imports: string[] = [];
  const routes: string[] = [];
  Object.entries(models).forEach(([file, field], index) => {
    files[`src/${file}`] = `import type { IObject } from '@exprtlabs/golem/model';\nexport type TPayment = IObject<{ ${field}: string }>;\n`;
    imports.push(`import { type TPayment as TPayment${index} } from './${file.replace(/\.ts$/, '.js')}';`);
    routes.push(`  @Post('r${index}') create${index}(@Body() input: TPayment${index}): TPayment${index} { return input; }`);
  });
  const controller = ["import { Body, Controller, Post } from '@nestjs/common';", ...imports, "@Controller('payments')", 'export class PaymentController {', ...routes, '}', ''].join('\n');
  const root = fixture(t, controller, { files });
  const document = documentOf(await generateFixture(root));
  return Object.keys(expectValue(document.components, 'OpenAPI components').schemas ?? {}).sort();
}

test('models with one name and different schemas in different directories are qualified by directory', async t => {
  assert.deepEqual(
    await clashComponents(t, { 'orders/payment.model.ts': 'amount', 'billing/payment.model.ts': 'destination' }),
    ['billing.TPayment', 'orders.TPayment'],
  );
});

test('models with one name and different schemas in one directory are qualified by file', async t => {
  assert.deepEqual(
    await clashComponents(t, { 'shared/payment.model.ts': 'amount', 'shared/refund.model.ts': 'destination' }),
    ['shared.payment.TPayment', 'shared.refund.TPayment'],
  );
});

test('a three-way name clash qualifies by the shortest distinguishing directory run and then by file', async t => {
  assert.deepEqual(
    await clashComponents(t, { 'orders/payment.model.ts': 'amount', 'billing/payment.model.ts': 'destination', 'billing/refund.model.ts': 'reason' }),
    ['billing.payment.TPayment', 'billing.refund.TPayment', 'orders.TPayment'],
  );
});

test('directory qualification adds parent segments only when the last segment does not distinguish', async t => {
  assert.deepEqual(
    await clashComponents(t, { 'eu/billing/payment.model.ts': 'amount', 'us/billing/payment.model.ts': 'destination' }),
    ['eu.billing.TPayment', 'us.billing.TPayment'],
  );
});

test('a model with a class is the component named by the class; a model without one keeps its alias', async t => {
  const root = fixture(t, [
    "import { Body, Controller, Post } from '@nestjs/common';",
    "import { type TOrder, PurchaseOrder, type TInvoice } from './order.model.js';",
    "@Controller('orders')",
    'export class OrderController {',
    '  @Post()',
    '  create(@Body() input: PurchaseOrder): TInvoice { return input as never; }',
    '}',
    '',
  ].join('\n'), {
    files: {
      'src/order.model.ts': [
        "import type { IModel } from '@exprtlabs/golem/model';",
        "import { TOrderBaseModel } from './order.model.generated.js';",
        'export type TOrder = IModel<{ id: string; total: number }>;',
        'export type TInvoice = IModel<{ id: string }>;',
        'export class PurchaseOrder extends TOrderBaseModel {}',
        '',
      ].join('\n'),
    },
  });
  const document = documentOf(await generateFixture(root));
  const schemas = expectValue(expectValue(document.components, 'OpenAPI components').schemas, 'OpenAPI component schemas');
  assert.ok(schemas.PurchaseOrder, 'the class names its model');
  assert.equal(schemas.TOrder, undefined, 'the alias of a model with a class is not a component');
  assert.ok(schemas.TInvoice, 'a model without a class keeps its alias');
});

test('a controller field that nests a model alias stops with RUNM1074 when no job of the golem.yaml reads model files', async t => {
  // protects: T-786 with no job that provides the model contract, the reason names no file ending
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { TPkgMoney } from '@acme/money';

class OrderDto {
  total!: TPkgMoney;
}

@Controller('orders')
export class OrdersController {
  @Get()
  @ApiOkResponse({ type: OrderDto })
  value(): OrderDto { return { total: { currency: 'USD' } }; }
}
`, {
    files: {
      'node_modules/@acme/money/package.json': JSON.stringify({ name: '@acme/money', version: '1.0.0', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }),
      'node_modules/@acme/money/index.d.ts': "import type { IObject } from '@exprtlabs/golem/model';\nexport type TPkgMoney = IObject<{ currency: string }>;\n",
    },
  });
  const declaration = fs.realpathSync(path.join(root, 'node_modules/@acme/money/index.d.ts'));

  await assert.rejects(
    generateFixture(root),
    (error: unknown) => String(error).includes(`RUNM1074: ${path.relative(process.cwd(), declaration)}#TPkgMoney is a model alias, but no job of this golem.yaml reads model files, so golem has no codec for it.`),
  );
});

test('a controller field that nests a model of an installed package whose file has no model suffix stops with RUNM1074 and names the suffixes of the provider', async t => {
  // protects: R-20 RUNM1074 keeps one reason in the controllers job: the model file has no model suffix
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { TPkgMoney } from '@acme/money';

class OrderDto {
  total!: TPkgMoney;
}

@Controller('orders')
export class OrdersController {
  @Get()
  @ApiOkResponse({ type: OrderDto })
  value(): OrderDto { return { total: { currency: 'USD' } }; }
}
`, {
    files: {
      'node_modules/@acme/money/package.json': JSON.stringify({ name: '@acme/money', version: '1.0.0', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }),
      'node_modules/@acme/money/index.d.ts': "import type { IObject } from '@exprtlabs/golem/model';\nexport type TPkgMoney = IObject<{ currency: string }>;\n",
    },
  });
  const declaration = fs.realpathSync(path.join(root, 'node_modules/@acme/money/index.d.ts'));

  await assert.rejects(
    generate({ root, output: path.join(root, 'openapi.json'), info: { title: 'Contract fixture', version: '1' }, profile: { validation: false }, models: { root, directory: root, output: path.join(root, 'src/generated/models'), suffixes: ['.entity.ts', '.record.ts'] } }),
    (error: unknown) => String(error).includes(`RUNM1074: ${path.relative(process.cwd(), declaration)}#TPkgMoney is declared in a file whose name has no model suffix. Golem reads a model from a file whose name ends in .entity.ts or .record.ts. Move the model into such a file.`),
  );
});

test('a named query parameter keeps a golem tag member as a brand, and a user property called tag makes it non-primitive', async t => {
  // protects: F-213 a brand is found by the golem tag symbol, not by a property name
  const controller = (parameterType: string): string => `import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { MinLength } from '@exprtlabs/golem/tags';

class ItemDto {
  name!: string;
}

@Controller('items')
export class ItemsController {
  @Get()
  @ApiOkResponse({ type: ItemDto })
  list(@Query('filter') filter: ${parameterType}): ItemDto { return { name: filter as string }; }
}
`;
  const branded = await generateFixture(fixture(t, controller('string & MinLength<3>')));
  const parameter = expectValue(operationOf(documentOf(branded), '/items', 'get').parameters?.[0], 'filter parameter');
  assert.equal(parameter.name, 'filter');

  await assert.rejects(
    generateFixture(fixture(t, controller('string & { tag: string }'))),
    (error: unknown) => String(error).includes('NEST1107'),
  );
});

test('a model with a model-level tag flattens into header parameters without its tag key', async t => {
  // protects: F-213 a golem tag key is found by its symbol; the old wide filter dropped it from a tagged model's parameters
  const root = fixture(t, `import { Controller, Get, Headers } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { TFilter } from './filter.model.js';

@Controller('items')
export class ItemsController {
  @Get()
  @ApiOkResponse({ description: 'ok' })
  list(@Headers() filter: TFilter): void {}
}
`, {
    files: {
      'src/filter.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { MinProperties } from '@exprtlabs/golem/tags';
export type TFilter = IModel<{ term: string; page?: number } & MinProperties<1>>;
`,
    },
  });
  const document = documentOf(await generateFixture(root));
  assert.deepEqual(operationOf(document, '/items', 'get').parameters?.map(parameter => `${parameter.in}:${parameter.name}`), ['header:term', 'header:page']);
});

test('a generated model class as a @Headers() parameter flattens into its fields without its brand keys', async t => {
  // protects: F-213 a generated-model brand key is found by its symbol, so the erased brands are no header parameters
  const root = fixture(t, `import { Controller, Get, Headers } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { Filter } from './filter.model.js';

@Controller('items')
export class ItemsController {
  @Get()
  @ApiOkResponse({ description: 'ok' })
  list(@Headers() filter: Filter): void {}
}
`, {
    files: {
      'src/filter.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TFilterBaseModel } from './filter.model.generated.js';
export type TFilter = IModel<{ term: string; page?: number }>;
export class Filter extends TFilterBaseModel {}
`,
    },
  });
  writeGeneratedArtifacts((await generateModels({ root, profile: { validation: true } })).artifacts);
  const document = documentOf(await generateFixture(root));
  assert.deepEqual(operationOf(document, '/items', 'get').parameters?.map(parameter => `${parameter.in}:${parameter.name}`), ['header:term', 'header:page']);
});

test('a symbol-keyed property of a flattened @Query() parameter type stops generation with RUNM1070', async t => {
  // protects: F-39 golem rejects a property that JSON cannot carry; a symbol key once became a query parameter named __@sym@N
  const root = fixture(t, `import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

declare const sym: unique symbol;
class SearchDto {
  term!: string;
  [sym]!: string;
}

@Controller('items')
export class ItemsController {
  @Get()
  @ApiOkResponse({ description: 'ok' })
  list(@Query() filter: SearchDto): void {}
}
`);
  await assert.rejects(
    generateFixture(root),
    /RUNM1070: Model SearchDto has the property \[sym\] with a symbol key\. JSON cannot carry a symbol key\. Use a string key, or remove the property\./,
  );
});

test('a DTO field typed with a built-in type keeps its schema and gains no field from the type\'s symbol keys', async t => {
  // protects: F-39 RUNM1070 is for symbol keys the user wrote; the [Symbol.toStringTag] of a library type is no field and no error; T-457 a Map field keeps the additionalProperties the user wrote
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';

class BlobDto {
  @ApiProperty({ type: 'string', format: 'binary' })
  file!: Uint8Array;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: Date;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  tags!: Map<string, string>;
}

@Controller('blobs')
export class BlobsController {
  @Get()
  @ApiOkResponse({ type: BlobDto })
  get(): BlobDto { throw new Error('not implemented'); }
}
`);
  const document = documentOf(await generateFixture(root));
  const schema = expectSchema(responseOf(document, '/blobs', 'get', '200').content?.['application/json']?.schema, 'BlobDto');
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['at', 'file', 'tags']);
  assert.deepEqual(schema.properties?.file, { format: 'binary', type: 'string' });
  assert.deepEqual(expectSchema(schema.properties?.tags, 'tags').additionalProperties, { type: 'string' });
  // T-553: a Map has no field of its own; JSON.stringify(new Map()) is {}, so no `size` property is written
  assert.equal(expectSchema(schema.properties?.tags, 'tags').properties?.size, undefined);
});

// protects: T-553 a Map or Set DTO field with no explicit @ApiProperty schema once got a required `size` property the server never sends; it now stops with RUNM1086
const mapOrSetFields = [
  { name: 'a Map field', declaration: 'tags!: Map<string, number>;', kind: 'Map', field: 'tags', advice: true },
  { name: 'a Set field', declaration: 'tags!: Set<string>;', kind: 'Set', field: 'tags', advice: true },
  { name: 'a ReadonlyMap field', declaration: 'tags!: ReadonlyMap<string, number>;', kind: 'ReadonlyMap', field: 'tags', advice: true },
  { name: 'a ReadonlySet field', declaration: 'tags!: ReadonlySet<string>;', kind: 'ReadonlySet', field: 'tags', advice: true },
  { name: 'an optional Map field', declaration: 'tags?: Map<string, number>;', kind: 'Map', field: 'tags', advice: true },
  { name: 'a Map field with a bare @ApiProperty()', declaration: '@ApiProperty()\n  tags!: Map<string, number>;', kind: 'Map', field: 'tags', advice: true },
  { name: 'a Map field with only a description', declaration: "@ApiProperty({ description: 'labels' })\n  tags!: Map<string, number>;", kind: 'Map', field: 'tags', advice: true },
  { name: 'a Map field in an inline object', declaration: 'inner!: { tags: Map<string, number> };', kind: 'Map', field: 'tags', advice: false },
  { name: 'a Map in an array', declaration: 'tags!: Map<string, number>[];', kind: 'Map', field: 'tags', advice: false },
] as const;
for (const { name, declaration, kind, field, advice } of mapOrSetFields) {
  test(`${name} with no explicit schema stops generation with RUNM1086`, async t => {
    const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';

class LabelsDto {
  ${declaration}
}

@Controller('labels')
export class LabelsController {
  @Get()
  @ApiOkResponse({ type: LabelsDto })
  get(): LabelsDto { throw new Error('not implemented'); }
}
`);
    await assert.rejects(
      generateFixture(root),
      new RegExp(`RUNM1086: Field "${field}" is a ${kind}\\. JSON writes a ${kind} as \\{\\}, so no schema describes it\\. ${advice ? 'Give the field an @ApiProperty with type, schema or additionalProperties, or use a Record or an array\\.' : 'Use a Record or an array\\.'}`),
    );
  });
}

test('a Map DTO field with an explicit @ApiProperty schema is an object with that schema and no size property', async t => {
  // protects: T-553 a Map field documented with @ApiProperty had a required `size` property beside the written schema
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';

class LabelsDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts!: Map<string, number>;

  @ApiProperty({ type: 'object' })
  names!: Set<string>;
}

@Controller('labels')
export class LabelsController {
  @Get()
  @ApiOkResponse({ type: LabelsDto })
  get(): LabelsDto { throw new Error('not implemented'); }
}
`);
  const document = documentOf(await generateFixture(root));
  const schema = expectSchema(responseOf(document, '/labels', 'get', '200').content?.['application/json']?.schema, 'LabelsDto');
  assert.deepEqual(schema.properties?.counts, { type: 'object', properties: {}, additionalProperties: { type: 'number' } });
  assert.equal(expectSchema(schema.properties?.names, 'names').properties?.size, undefined);
});

test('an @ApiProperty imported under another name documents a Map field, and a local decorator of that name does not', async t => {
  // protects: T-757 the Swagger schema of a DTO field is found by the decorator's resolved symbol and package
  const dto = (header: string, decorator: string): string => `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
${header}

class LabelsDto {
  @${decorator}({ type: 'object', additionalProperties: { type: 'number' } })
  counts!: Map<string, number>;
}

@Controller('labels')
export class LabelsController {
  @Get()
  @ApiOkResponse({ type: LabelsDto })
  get(): LabelsDto { throw new Error('not implemented'); }
}
`;
  const aliased = fixture(t, dto("import { ApiProperty as Prop } from '@nestjs/swagger';", 'Prop'));
  const schema = expectSchema(responseOf(documentOf(await generateFixture(aliased)), '/labels', 'get', '200').content?.['application/json']?.schema, 'LabelsDto');
  assert.deepEqual(schema.properties?.counts, { type: 'object', properties: {}, additionalProperties: { type: 'number' } });
  const local = fixture(t, dto('declare function ApiProperty(options: object): PropertyDecorator;', 'ApiProperty'));
  await assert.rejects(generateFixture(local), /RUNM1086: Field "counts" is a Map/);
});

test('isModel is false for a model class with a whole-value TSerde and true for the model class itself', async t => {
  // protects: T-448 asking whether a type is a model gives the answer describe gives: a TSerde over a class value converts the whole value, so it is no model
  const root = fixture(t, `import { Money, encodeMoney, decodeMoney } from './money.model.js';
import type { TSerde } from '@exprtlabs/golem/tags';

export class OrderDto {
  price!: Money & TSerde<typeof encodeMoney, typeof decodeMoney>;
  plain!: Money;
}
`, {
    files: {
      'src/money.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TMoneyBaseModel } from './money.model.generated.js';
export type TMoney = IModel<{ cents: number }>;
export class Money extends TMoneyBaseModel { format(): string { return String(this.cents); } }
export function encodeMoney(value: Money): string { return value.format(); }
export function decodeMoney(value: string): Money { throw new Error(value); }
`,
    },
  });
  writeGeneratedArtifacts((await generateModels({ root, profile: { validation: true } })).artifacts);
  const { program } = createProgram([path.join(root, 'src/contracts.controller.ts'), path.join(root, 'src/money.model.ts')], root);
  const analysis = createContractAnalysis(program, { root });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path.join(root, 'src/contracts.controller.ts'))!;
  const dto = source.statements.find(ts.isClassDeclaration) as ts.ClassDeclaration;
  const typeOf = (name: string): { readonly type: ts.Type; readonly node: ts.Node } => {
    const member = dto.members.find(item => (item as ts.PropertyDeclaration).name?.getText() === name)!;
    return { type: checker.getTypeAtLocation(member), node: member };
  };
  assert.equal(analysis.isModel(typeOf('plain').type, typeOf('plain').node), true);
  assert.equal(analysis.isModel(typeOf('price').type, typeOf('price').node), false);
});

test('a docs job with no model block stops on a syntax error in a file its controller imports', async t => {
  // protects: T-786 one rule for the controllers job: a syntax error in any file of the project stops it, with or without a models job
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { OrderDto } from './order.js';

@Controller('orders')
export class OrdersController {
  @Get()
  @ApiOkResponse({ type: Object })
  value(): OrderDto { return { id: '1' }; }
}
`, {
    files: { 'src/order.ts': 'export interface OrderDto { id: string;\n' },
  });

  await assert.rejects(generateFixture(root), /order\.ts.*'\}' expected/s);
});

test('a docs job does not stop on a syntax error in the output of a later job', async t => {
  // protects: T-786 the later job writes its output again, so a broken file there must not stop the job before it
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

export class OrderDto { id!: string; }

@Controller('orders')
export class OrdersController {
  @Get()
  @ApiOkResponse({ type: OrderDto })
  value(): OrderDto { return { id: '1' }; }
}
`, {
    files: { 'src/sdk/client.ts': 'export interface Broken { id: string;\n' },
  });

  const result = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    openapiVersion: '3.2.0',
    info: { title: 'Contract fixture', version: '1' },
    profile: { validation: false },
    programView: { laterOutputs: [path.join(root, 'src/sdk')] },
  });
  assert.equal(result.artifacts.length, 1);
});
