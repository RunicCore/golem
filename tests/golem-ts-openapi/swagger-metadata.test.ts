import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

type OpenApiSchemaValue = boolean | OpenApiSchema;

interface OpenApiSchema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly items?: OpenApiSchemaValue;
  readonly anyOf?: readonly OpenApiSchemaValue[];
  readonly allOf?: readonly OpenApiSchemaValue[];
  readonly oneOf?: readonly OpenApiSchemaValue[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, OpenApiSchemaValue>>;
  readonly [keyword: string]: unknown;
}

interface OpenApiMediaType {
  readonly schema?: OpenApiSchemaValue;
}

interface OpenApiParameter {
  readonly in?: string;
  readonly name?: string;
  readonly required?: boolean;
  readonly schema?: OpenApiSchemaValue;
}

interface OpenApiOperation {
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: { readonly content?: Readonly<Record<string, OpenApiMediaType>> };
  readonly responses: Readonly<Record<string, { readonly content?: Readonly<Record<string, OpenApiMediaType>> }>>;
}

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, OpenApiSchemaValue>> };
}

const FIXTURES = 'controllers/swagger-metadata';

function fixture(t: TestContext, name: string, files: Readonly<Record<string, string>> = {}): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-swagger-metadata-',
    packageName: 'golem-ts-openapi-swagger-metadata-fixture',
    source: readFixture(`${FIXTURES}/${name}/controller.ts`),
    files: Object.fromEntries(Object.entries(files).map(([target, source]) => [target, readFixture(`${FIXTURES}/${name}/${source}`)])),
    links: 'workspace',
  });
}

function inlineFixture(t: TestContext, source: string): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-swagger-metadata-',
    packageName: 'golem-ts-openapi-swagger-metadata-fixture',
    source,
    links: 'workspace',
  });
}

function generateAt(root: string): ReturnType<typeof generate> {
  return generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Swagger metadata', version: '1' },
    profile: { mobx: false, validation: false },
  });
}

async function generated(
  t: TestContext,
  name: string,
  files: Readonly<Record<string, string>> = {},
  allowAny = false,
): Promise<Awaited<ReturnType<typeof generate>>> {
  const root = fixture(t, name, files);
  return generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Swagger metadata', version: '1' },
    profile: { mobx: false, validation: false, allowAny },
  });
}

function documentOf(result: Awaited<ReturnType<typeof generate>>): OpenApiDocument {
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  return JSON.parse(artifact.content) as OpenApiDocument;
}

function objectSchema(document: OpenApiDocument, value: OpenApiSchemaValue | undefined): OpenApiSchema {
  assert.ok(value !== undefined && typeof value !== 'boolean', 'expected an object schema');
  const reference = value.$ref;
  if (typeof reference === 'string') {
    const name = reference.replace('#/components/schemas/', '');
    return objectSchema(document, document.components?.schemas?.[name]);
  }
  return value;
}

/** The object-valued branch of a schema, looking through a nullable/optional `anyOf`. */
function objectBranch(document: OpenApiDocument, value: OpenApiSchemaValue | undefined): OpenApiSchema {
  const schema = objectSchema(document, value);
  if (schema.properties) return schema;
  const branch = schema.anyOf?.map(item => objectSchema(document, item)).find(item => item.properties !== undefined);
  assert.ok(branch, 'expected an object branch');
  return branch;
}

function property(document: OpenApiDocument, schema: OpenApiSchema, name: string): OpenApiSchema {
  return objectSchema(document, schema.properties?.[name]);
}

function jsonSchema(operation: OpenApiOperation | undefined, status: string): OpenApiSchemaValue | undefined {
  return operation?.responses[status]?.content?.['application/json']?.schema;
}

interface DiagnosticShape {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly line?: unknown;
  readonly column?: unknown;
}

function diagnosticsOf(error: unknown): readonly DiagnosticShape[] {
  if (error === null || typeof error !== 'object' || !('diagnostics' in error)) return [];
  const diagnostics = (error as { readonly diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics)
    ? diagnostics.filter((item): item is DiagnosticShape => item !== null && typeof item === 'object')
    : [];
}

async function rejectsWith(root: string, code: string, message: RegExp): Promise<void> {
  await assert.rejects(
    () => generateAt(root),
    (error: unknown) => diagnosticsOf(error).some(item => item.code === code && message.test(String(item.message))),
  );
}

function assertUserOverlays(document: OpenApiDocument, user: OpenApiSchema): void {
  const home = property(document, user, 'home');
  assert.equal(home.description, 'Home address');
  assert.equal(property(document, home, 'street').description, 'Street line');
  const contact = property(document, user, 'contact');
  assert.equal(contact.description, 'Primary contact');
  assert.equal(property(document, contact, 'email').description, 'Email address');
  const backup = property(document, user, 'backup');
  assert.equal(backup.description, 'Backup contact');
  assert.equal(property(document, objectBranch(document, backup), 'email').description, 'Email address');
}

test('applies every nested DTO overlay, including arrays, Promise and optional members', async t => {
  const document = documentOf(await generated(t, 'nested-dto-overlays'));
  const single = objectSchema(document, jsonSchema(document.paths['/users/{id}']?.get, '200'));
  assertUserOverlays(document, single);
  const list = objectSchema(document, jsonSchema(document.paths['/users']?.get, '200'));
  assert.equal(list.type, 'array');
  assertUserOverlays(document, objectSchema(document, list.items));
});

test('maps Swagger integer, Date, enum member arrays and whole enums on properties and query parameters', async t => {
  const result = await generated(t, 'swagger-type-and-enum-metadata');
  const document = documentOf(result);
  const operation = document.paths['/reports']?.get;
  const report = objectSchema(document, jsonSchema(operation, '200'));
  const count = property(document, report, 'count');
  assert.equal(count.type, 'integer');
  assert.equal(count.description, 'Row count');
  const createdAt = property(document, report, 'createdAt');
  assert.equal(createdAt.type, 'string');
  assert.equal(createdAt.description, 'Creation time');
  assert.deepEqual(property(document, report, 'order').enum, ['asc', 'desc']);
  assert.deepEqual(property(document, report, 'wholeOrder').enum, ['asc', 'desc']);
  assert.deepEqual(property(document, report, 'level').enum, [1, 2]);
  assert.deepEqual(property(document, report, 'levels').enum, [1, 2]);
  assert.deepEqual(property(document, report, 'kind').enum, ['a', 'b']);
  assert.equal(property(document, report, 'note').description, 'Free text');
  assert.ok(
    (result.diagnostics ?? []).some(item => item.code === 'NEST1504' && item.severity === 'warning' && /custom-scalar/.test(item.message)),
    'an unrecognized Swagger type is reported as a warning',
  );
  const parameter = (name: string): OpenApiParameter | undefined => operation?.parameters?.find(item => item.in === 'query' && item.name === name);
  assert.deepEqual(objectSchema(document, parameter('order')?.schema).enum, ['asc', 'desc']);
  assert.deepEqual(objectSchema(document, parameter('level')?.schema).enum, [1, 2]);
  const direction = parameter('direction');
  assert.equal(direction?.required, false);
  assert.deepEqual(objectSchema(document, direction?.schema).enum, ['asc', 'desc']);
});

test('rejects Swagger enum metadata that is not a compile-time constant', async t => {
  await assert.rejects(
    () => generated(t, 'rejects-non-constant-enum-metadata'),
    (error: unknown) => diagnosticsOf(error).some(item => item.code === 'NEST1504'
      && /\{ enum \}/.test(String(item.message))
      && /dynamicValues is not declared with const/.test(String(item.message))
      // The diagnostic points at `dynamicValues` inside `@ApiProperty({ enum: dynamicValues })`.
      && item.line === 8
      && item.column === 24),
  );
});

test('resolves generic base controller methods with the derived type argument', async t => {
  const document = documentOf(await generated(t, 'generic-base-controller'));
  const assertUser = (value: OpenApiSchemaValue | undefined): void => {
    const user = objectSchema(document, value);
    assert.equal(property(document, user, 'id').description, 'User identifier');
    assert.equal(property(document, user, 'name').type, 'string');
  };
  assertUser(jsonSchema(document.paths['/users/{id}']?.get, '200'));
  const create = document.paths['/users']?.post;
  assertUser(create?.requestBody?.content?.['application/json']?.schema);
  assertUser(jsonSchema(create, '201'));
});

test('unwraps Observable controller returns like Promise returns', async t => {
  const document = documentOf(await generated(t, 'observable-response'));
  const event = objectSchema(document, jsonSchema(document.paths['/events']?.get, '200'));
  assert.equal(property(document, event, 'name').description, 'Event name');
});

test('evaluates getSchemaPath() and refs() and emits the named components', async t => {
  const result = await generated(t, 'schema-path-intrinsics', { 'src/docs.ts': 'docs.ts' });
  const document = documentOf(result);
  const schema = objectSchema(document, jsonSchema(document.paths['/pets']?.get, '200'));
  const [page, list] = (schema.allOf ?? []) as readonly OpenApiSchema[];
  assert.equal(page?.$ref, '#/components/schemas/PageMeta');
  const items = objectSchema(document, objectSchema(document, list?.properties?.items).items);
  assert.deepEqual(items.oneOf, [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }]);
  const components = document.components?.schemas ?? {};
  assert.equal(property(document, objectSchema(document, components.PageMeta), 'total').description, 'Page total');
  assert.equal(property(document, objectSchema(document, components.Cat), 'name').description, 'Pet name');
  const bark = property(document, objectSchema(document, components.Dog), 'bark');
  assert.equal(bark.type, 'boolean');
  assert.equal(bark.description, undefined);
  assert.equal(bark.example, undefined);
  const warnings = (result.diagnostics ?? []).filter(item => item.code === 'NEST1504' && item.severity === 'warning');
  assert.ok(warnings.some(item => /\{ description \}/.test(item.message)), 'a runtime description is a warning');
  assert.ok(warnings.some(item => /\{ example \}/.test(item.message)), 'a runtime example is a warning');
});

test('accepts compatible Swagger types: formatted strings, base classes, nullable array items and unknown', async t => {
  const result = await generated(t, 'swagger-type-compatibility', {}, true);
  const document = documentOf(result);
  const upload = objectSchema(document, jsonSchema(document.paths['/uploads']?.get, '200'));
  const file = property(document, upload, 'file');
  assert.deepEqual(file, { description: 'Uploaded file', format: 'binary', type: 'string' });
  const createdAt = property(document, upload, 'createdAt');
  assert.equal(createdAt.type, 'string');
  assert.equal(createdAt.format, 'date-time');
  assert.ok(property(document, property(document, upload, 'owner'), 'extra'));
  const items = property(document, upload, 'items');
  assert.equal(items.type, 'array');
  assert.equal(property(document, objectBranch(document, items.items), 'id').description, 'Item id');
  const payload = property(document, upload, 'payload');
  assert.equal(payload.type, 'number');
  assert.equal(payload.description, 'Opaque payload');
});

test('a controller DTO field typed unknown is rejected with RUNM1011 under the default allowAny', async t => {
  await assert.rejects(
    () => generated(t, 'swagger-type-compatibility'),
    (error: unknown) => /RUNM1011.*contains unknown/.test(String(error)),
  );
});

test('reads decorator options supplied by constants and spreads in source order', async t => {
  const document = documentOf(await generated(t, 'options-from-constants-and-spreads'));
  const operation = document.paths['/things/{id}']?.get;
  const thing = objectSchema(document, jsonSchema(operation, '200'));
  assert.equal(property(document, thing, 'name').description, 'Shared description');
  assert.equal(property(document, thing, 'code').description, 'Overridden description');
  assert.deepEqual(thing.required ?? [], []);
  assert.equal((operation?.responses['404'] as { readonly description?: string } | undefined)?.description, 'Not found error');
});

test('rejects non-constant structural options, spread type thunks and malformed security requirements', async t => {
  const header = "import { Controller, Get } from '@nestjs/common';\nimport { ApiOkResponse, ApiProperty, ApiResponse, ApiSecurity } from '@nestjs/swagger';\nclass ItemDto { @ApiProperty() id!: string; }\n";
  await rejectsWith(
    inlineFixture(t, `${header}let many = true;\n@Controller('dynamic-array') export class DynamicArrayController { @Get() @ApiOkResponse({ type: ItemDto, isArray: many }) get(): ItemDto[] { return []; } }`),
    'NEST1504',
    /\{ isArray \}.*many is not declared with const/,
  );
  await rejectsWith(
    inlineFixture(t, `${header}const WITH_TYPE = { type: () => ItemDto };\n@Controller('spread-type') export class SpreadTypeController { @Get() @ApiResponse({ ...WITH_TYPE, status: 200 }) get(): ItemDto { return { id: 'x' }; } }`),
    'NEST1504',
    /options spread must be a compile-time constant/,
  );
  await rejectsWith(
    inlineFixture(t, `${header}@Controller('bad-security') export class BadSecurityController { @Get() @ApiSecurity(['api-key']) get(): ItemDto { return { id: 'x' }; } }`),
    'NEST1405',
    /scheme name or a record/,
  );
});

test('keeps an aliased Promise return and does not unwrap a project class named Observable', async t => {
  const document = documentOf(await generated(t, 'async-alias-and-local-observable'));
  const list = objectSchema(document, jsonSchema(document.paths['/items']?.get, '200'));
  assert.equal(list.type, 'array');
  assert.equal(property(document, objectSchema(document, list.items), 'id').description, 'Item id');
  const wrapped = objectSchema(document, jsonSchema(document.paths['/items/wrapped']?.get, '200'));
  assert.equal(property(document, wrapped, 'total').description, 'Wrapped total');
  assert.equal(property(document, property(document, wrapped, 'data'), 'id').description, 'Item id');
  const latest = objectSchema(document, jsonSchema(document.paths['/items/latest']?.get, '200'));
  assert.equal(property(document, property(document, latest, 'current'), 'id').description, 'Item id');
});

test('emits routes inherited from plain and mixin base controllers', async t => {
  const document = documentOf(await generated(t, 'inherited-and-mixin-controllers'));
  const reply = (route: string): unknown => property(document, objectSchema(document, jsonSchema(document.paths[route]?.get, '200')), 'reply').description;
  assert.equal(reply('/plain/ping'), 'Ping reply');
  assert.equal(reply('/mixed/ping'), 'Ping reply');
  const time = objectSchema(document, jsonSchema(document.paths['/mixed/time']?.get, '200'));
  assert.equal(property(document, time, 'at').description, 'Epoch millis');
});

test('names getSchemaPath() components by @ApiSchema and rejects a clash with a different contract', async t => {
  const document = documentOf(await generated(t, 'schema-path-component-names'));
  const page = document.paths['/payments']?.get?.responses['200']?.content?.['application/json']?.schema;
  assert.deepEqual(page, { $ref: '#/components/schemas/PageMetadata' });
  const components = document.components?.schemas ?? {};
  assert.equal(property(document, objectSchema(document, components.PageMetadata), 'total').description, 'Total rows');
  assert.equal(components.PageMeta, undefined);
  assert.ok(components.TPayment, 'the IModel component keeps its own name');
  await rejectsWith(
    inlineFixture(t, readFixture(`${FIXTURES}/schema-path-component-names/conflict.controller.ts`)),
    'NEST1504',
    /components\.schemas\.TPayment, but that component is a different contract/,
  );
});

test('emits an explicit getSchemaPath() response as references only and honors enumName', async t => {
  const document = documentOf(await generated(t, 'schema-path-union-response'));
  const schema = document.paths['/issues/any']?.get?.responses['200']?.content?.['application/json']?.schema;
  assert.deepEqual(schema, { oneOf: [{ $ref: '#/components/schemas/BugDto' }, { $ref: '#/components/schemas/FeatureDto' }] });
  const components = document.components?.schemas ?? {};
  assert.deepEqual(components.Kind, { enum: ['bug', 'feature'], type: 'string' });
  const bug = objectSchema(document, components.BugDto);
  assert.deepEqual(bug.properties?.kind, { $ref: '#/components/schemas/Kind', description: 'Issue kind' });
  const feature = objectSchema(document, components.FeatureDto);
  assert.deepEqual(feature.properties?.kind, { $ref: '#/components/schemas/Kind' });
  assert.equal(property(document, feature, 'votes').type, 'integer');
});
