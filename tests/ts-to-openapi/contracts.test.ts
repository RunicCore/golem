import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#controllers/generator';
import { generate as generateModels } from '#model/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

interface FixtureOptions {
  readonly classValidator?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

type OpenApiSchemaValue = boolean | OpenApiSchema;

interface OpenApiSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly allOf?: readonly OpenApiSchemaValue[];
  readonly anyOf?: readonly OpenApiSchemaValue[];
  readonly properties?: Readonly<Record<string, OpenApiSchemaValue>>;
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
  readonly [keyword: string]: unknown;
}

interface OpenApiMediaType {
  readonly schema?: OpenApiSchemaValue;
}

interface OpenApiParameter {
  readonly in?: string;
  readonly name?: string;
  readonly schema?: OpenApiSchemaValue;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

interface OpenApiResponse {
  readonly description?: string;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

interface OpenApiRequestBody {
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

interface OpenApiOperation {
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

interface OpenApiPathItem {
  readonly get?: OpenApiOperation;
  readonly post?: OpenApiOperation;
  readonly delete?: OpenApiOperation;
}

interface OpenApiDocument {
  readonly components?: {
    readonly schemas?: Readonly<Record<string, OpenApiSchemaValue>>;
  };
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
}

interface DiagnosticLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

function expectValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}.`);
  return value;
}

function expectSchema(value: OpenApiSchemaValue | undefined, label: string): OpenApiSchema {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object schema for ${label}.`);
  }
  return value;
}

function schemaOf(document: OpenApiDocument, name: string): OpenApiSchema {
  const components = expectValue(document.components, 'OpenAPI components');
  const schemas = expectValue(components.schemas, 'OpenAPI component schemas');
  return expectSchema(schemas[name], `component schema ${name}`);
}

function propertySchema(schema: OpenApiSchema, name: string): OpenApiSchema {
  const properties = expectValue(schema.properties, `${name} properties`);
  return expectSchema(properties[name], `property ${name}`);
}

function allOfSchemas(schema: OpenApiSchema, label: string): readonly OpenApiSchema[] {
  return expectValue(schema.allOf, `${label}.allOf`).map((item, index) => expectSchema(item, `${label}.allOf[${index}]`));
}

function anyOfSchemas(schema: OpenApiSchema, label: string): readonly OpenApiSchema[] {
  return expectValue(schema.anyOf, `${label}.anyOf`).map((item, index) => expectSchema(item, `${label}.anyOf[${index}]`));
}

function operationOf(
  document: OpenApiDocument,
  route: string,
  method: 'get' | 'post' | 'delete',
): OpenApiOperation {
  return expectValue(expectValue(document.paths[route], `OpenAPI path ${route}`)[method], `${method.toUpperCase()} ${route}`);
}

function responseOf(
  document: OpenApiDocument,
  route: string,
  method: 'get' | 'post' | 'delete',
  status: string,
): OpenApiResponse {
  return expectValue(operationOf(document, route, method).responses[status], `response ${status} for ${method.toUpperCase()} ${route}`);
}

function contentSchema(value: OpenApiResponse | OpenApiParameter | OpenApiRequestBody, mediaType: string, label: string): OpenApiSchema {
  const content = expectValue(value.content, `${label}.content`);
  return expectSchema(expectValue(content[mediaType], `${label}.content.${mediaType}`).schema, `${label}.content.${mediaType}.schema`);
}

function fixture(t: TestContext, source: string, options: FixtureOptions = {}): string {
  return createControllerFixture(t, {
    prefix: 'runic-ts-to-openapi-contract-',
    packageName: 'ts-to-openapi-contract-fixture',
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

function documentOf(result: Awaited<ReturnType<typeof generate>>): OpenApiDocument {
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  const parsed: unknown = JSON.parse(artifact.content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Generated OpenAPI document is not an object.');
  }
  return parsed as OpenApiDocument;
}

function diagnosticsOf(error: unknown): readonly DiagnosticLike[] {
  if (error === null || typeof error !== 'object' || !('diagnostics' in error)) return [];
  const diagnostics = (error as { readonly diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.filter((item): item is DiagnosticLike => (
    item !== null && typeof item === 'object'
  ));
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
    profile: { mobx: false, validation: false },
  });
}

test('uses the IModel wire TSerde contract before any model companion exists', async t => {
  const root = fixture(t, readFixture("controllers/contracts/uses-the-imodel-wire-tserde-contract-before-any-model-companion-exists/controller.ts"));

  assert.equal(fs.existsSync(path.join(root, 'src/payment.model.generated.ts')), false);
  const document = documentOf(await generateFixture(root));
  const amount = propertySchema(schemaOf(document, 'Payment'), 'amount');
  const amountVariants = allOfSchemas(amount, 'Payment.amount');
  assert.equal(amountVariants[0]?.type, 'string');
  assert.equal(amountVariants[1]?.pattern, '^[0-9]+$');
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
    assert.equal(variants.filter(item => item.$ref === '#/components/schemas/Payment').length, 1, `${label} keeps its model reference`);
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
  assert.ok(schemas.AddressOmitId, 'the smallest derived name survives deduplication');
  assert.equal(schemas.AddressPickCity, undefined, 'the equivalent projection redirects to it');
  const envelope = schemaOf(document, 'Envelope');
  const omitted = propertySchema(envelope, 'omitted');
  const selected = propertySchema(envelope, 'selected');
  assert.equal(omitted.$ref, '#/components/schemas/AddressOmitId');
  assert.equal(omitted.$ref, selected.$ref, 'all equivalent projection references redirect to one component');
  assert.equal(schemas.Address, undefined, 'unreferenced source model is not emitted');
});

test('emits a lossless whole querystring schema in 3.2 and rejects cross-field flattening in 3.1.2', async t => {
  const root = fixture(t, readFixture("controllers/contracts/emits-a-lossless-whole-querystring-schema-in-3-2-and-rejects-cross-field-flatt/controller.ts"));

  const document = documentOf(await generateFixture(root, '3.2.0'));
  const operation = operationOf(document, '/search', 'get');
  const querystring = expectValue(operation.parameters?.find(item => item.in === 'querystring'), 'OpenAPI 3.2 querystring parameter');
  assert.equal(querystring.name, 'query');
  const querySchema = contentSchema(querystring, 'application/x-www-form-urlencoded', 'querystring');
  assert.deepEqual(querySchema.dependentRequired, { min: ['max'] });
  const min = allOfSchemas(propertySchema(querySchema, 'min'), 'querystring.min');
  assert.equal(min[0]?.type, 'string');
  assert.equal(min[1]?.pattern, '^[0-9]+$');

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
    (error: unknown) => /RUNM1052|Root IModel unions are unsupported/i.test(String(error)),
  );
});

test('unresolved controller contract types fail instead of becoming unrestricted schemas', async t => {
  const root = fixture(t, readFixture("controllers/contracts/unresolved-controller-contract-types-fail-instead-of-becoming-unrestricted-sch/controller.ts"));
  await assert.rejects(generateFixture(root), /RUNM1058.*could not be resolved/);
});

test('same-name same-shape class and plain models keep their own codec ids in the operation registry', async t => {
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
    `import type { ${declaration} } from '@exprtlabs/codegen/model';`,
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
  const registry = contracts.artifacts.find(artifact => artifact.path.endsWith('operation-codecs.ts'))?.content ?? '';
  const models = await generateModels({ root, profile: { mobx: false, validation: true } });
  const keys = models.artifacts.find(artifact => artifact.path.endsWith('iobject-plugin-keys.ts'))?.content ?? '';
  const keyOf = (directory: string): string => {
    const id = keys.match(new RegExp(`src/${directory}/payment\\.model\\.ts#Payment": "([^"]+)"`))?.[1];
    assert.ok(id, `${directory} model has a plugin key`);
    return id;
  };
  const routeId = (route: string): string => {
    const id = registry.match(new RegExp(`"POST /${route}": "([^"]+)"`))?.[1];
    assert.ok(id, `${route} route has an operation codec`);
    return id;
  };
  assert.notEqual(keyOf('billing'), keyOf('payout'));
  assert.equal(routeId('billing'), keyOf('billing'), 'the class model route uses the class codec');
  assert.equal(routeId('payout'), keyOf('payout'), 'the plain model route uses the plain codec');
});
