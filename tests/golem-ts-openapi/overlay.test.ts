// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { compileSchema } from '../support/compiled-validators.js';

interface OpenApiSchema {
  readonly $ref?: string;
  readonly nullable?: boolean;
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly OpenApiSchema[];
  readonly allOf?: readonly OpenApiSchema[];
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly [key: string]: unknown;
}

interface OpenApiMediaType {
  readonly schema?: OpenApiSchema;
  readonly example?: unknown;
}

interface OpenApiResponse {
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

interface OpenApiParameter {
  readonly in?: string;
  readonly name?: string;
  readonly required?: boolean;
}

interface OpenApiOperation {
  readonly parameters?: readonly OpenApiParameter[];
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components?: {
    readonly schemas?: Readonly<Record<string, OpenApiSchema>>;
  };
}

function fixture(t: TestContext, source: string): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-overlay-',
    packageName: 'golem-ts-openapi-overlay-fixture',
    source,
  });
}

function documentOf(result: Awaited<ReturnType<typeof generate>>): OpenApiDocument {
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  return JSON.parse(artifact.content) as OpenApiDocument;
}

function rewriteComponentRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteComponentRefs);
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      return value.replace('#/components/schemas/', '#/$defs/');
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteComponentRefs(item)]));
}

function standardSchema(document: OpenApiDocument, schema: OpenApiSchema): Record<string, unknown> {
  const schemas = document.components?.schemas ?? {};
  return {
    ...(rewriteComponentRefs(schema) as Record<string, unknown>),
    $defs: rewriteComponentRefs(schemas),
  };
}

function assertNoLegacyNullable(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoLegacyNullable(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.hasOwn(value, 'nullable'), false, 'OpenAPI 3.1/3.2 output must use JSON Schema null branches');
  for (const item of Object.values(value)) assertNoLegacyNullable(item);
}

function diagnosticsOf(error: unknown): readonly { readonly code?: unknown }[] {
  if (error === null || typeof error !== 'object' || !('diagnostics' in error)) return [];
  const diagnostics = (error as { readonly diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics)
    ? diagnostics.filter((item): item is { readonly code?: unknown } => item !== null && typeof item === 'object')
    : [];
}

function expectCode(error: unknown, code: string): boolean {
  return diagnosticsOf(error).some(item => item.code === code);
}

test('fills a response media schema from the declared contract while preserving examples', async t => {
  const root = fixture(t, readFixture("controllers/overlay/fills-a-response-media-schema-from-the-declared-contract-while-preserving-exam/controller.ts"));
  const result = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Response overlay', version: '1' },
    profile: { mobx: false, validation: false },
  });
  const document = documentOf(result);
  const media = document.paths['/payments']?.get?.responses['200']?.content?.['application/json'];
  assert.deepEqual(media?.example, { id: 'p-1' });
  assert.equal(media?.schema?.$ref, '#/components/schemas/TPayment');
});

test('normalizes ordinary DTO nullable properties, enums, and response overlays', async t => {
  const root = fixture(t, readFixture("controllers/overlay/normalizes-ordinary-dto-nullable-properties-enums-and-response-overlays-for-bo/controller.ts"));
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    openapiVersion: '3.1.2',
    info: { title: 'Nullable DTO overlay', version: '1' },
    profile: { mobx: false, validation: false },
  }));
  assertNoLegacyNullable(document);
  const response = document.paths['/results']?.get?.responses['200']?.content?.['application/json']?.schema;
  assert.ok(response);
  const result = response;
  const label = result.properties?.label;
  const kind = result.properties?.kind;
  assert.ok(label);
  assert.ok(kind);
  const validateLabel = await compileSchema(standardSchema(document, label));
  const validateKind = await compileSchema(standardSchema(document, kind));
  const validateResponse = await compileSchema(standardSchema(document, response));
  assert.deepEqual(validateLabel('ok', true), []);
  assert.deepEqual(validateLabel(null, true), []);
  assert.notDeepEqual(validateLabel(42, true), []);
  assert.deepEqual(validateKind('cat', true), []);
  assert.deepEqual(validateKind('dog', true), []);
  assert.deepEqual(validateKind(null, true), []);
  assert.notDeepEqual(validateKind('bird', true), []);
  assert.deepEqual(validateResponse({ label: 'ok', kind: 'cat' }, true), []);
  assert.deepEqual(validateResponse(null, true), []);
  assert.notDeepEqual(validateResponse({ label: 42, kind: 'cat' }, true), []);
});

for (const openapiVersion of ['3.2.0', '3.1.2'] as const) {
  test(`keeps the TypeScript schema under a nullable type or Record overlay on ${openapiVersion}`, async t => {
    // protects: T-419 nullable and additionalProperties overlays keep the TypeScript schema, as Nest Swagger keeps them
    const root = fixture(t, readFixture('controllers/overlay/keeps-the-typescript-schema-under-a-nullable-type-or-record-overlay/controller.ts'));
    const document = documentOf(await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion, info: { title: 'Overlay', version: '1' }, profile: { mobx: false, validation: false } }));
    const properties = document.paths['/widgets']?.get?.responses['200']?.content?.['application/json']?.schema?.properties;
    assert.ok(properties?.middle && properties.scores);
    const middle = await compileSchema(standardSchema(document, properties.middle));
    const scores = await compileSchema(standardSchema(document, properties.scores));
    assert.deepEqual([middle('a', true), middle(null, true)], [[], []]);
    assert.notDeepEqual(middle(3, true), []);
    assert.deepEqual(scores({ a: 1 }, true), []);
    assert.notDeepEqual(scores({ a: 'x' }, true), []);
  });
}

test('allows nullable:false narrowing for ordinary DTOs while keeping the standard schema nonnullable', async t => {
  const root = fixture(t, readFixture("controllers/overlay/allows-nullable-false-narrowing-for-ordinary-dtos-while-keeping-the-standard-s/controller.ts"));
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    openapiVersion: '3.1.2',
    info: { title: 'Nonnullable DTO overlay', version: '1' },
    profile: { mobx: false, validation: false },
  }));
  assertNoLegacyNullable(document);
  const propertyResponse = document.paths['/narrow/property']?.get?.responses['200']?.content?.['application/json']?.schema;
  const responseResponse = document.paths['/narrow/response']?.get?.responses['200']?.content?.['application/json']?.schema;
  assert.ok(propertyResponse);
  assert.ok(responseResponse);
  const propertyObject = propertyResponse.anyOf?.find(item => item.type === 'object') ?? propertyResponse;
  const label = propertyObject.properties?.label;
  const kind = propertyObject.properties?.kind;
  assert.ok(label);
  assert.ok(kind);
  const validateLabel = await compileSchema(standardSchema(document, label));
  const validateKind = await compileSchema(standardSchema(document, kind));
  const validateResponse = await compileSchema(standardSchema(document, responseResponse));
  assert.deepEqual(validateLabel('ok', true), []);
  assert.notDeepEqual(validateLabel(null, true), []);
  assert.deepEqual(validateKind('cat', true), []);
  assert.notDeepEqual(validateKind(null, true), []);
  assert.deepEqual(validateResponse({ label: 'ok', kind: 'cat' }, true), []);
  assert.notDeepEqual(validateResponse(null, true), []);
});

test('rejects nullable Swagger overlays that widen a nonnullable IModel response', async t => {
  const root = fixture(t, readFixture("controllers/overlay/rejects-nullable-swagger-overlays-that-widen-a-nonnullable-imodel-response/controller.ts"));
  await assert.rejects(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      openapiVersion: '3.1.2',
      info: { title: 'Nullable overlay', version: '1' },
      profile: { mobx: false, validation: false },
    }),
    error => expectCode(error, 'NEST1503'),
    'nullable widening is rejected',
  );
});

test('rejects Swagger required:false for required IModel querystring contracts and paths', async t => {
  const cases = [
    readFixture("controllers/overlay/rejects-swagger-required-false-for-required-imodel-querystring-contracts-and-p/controller.ts"),
    readFixture("controllers/overlay/rejects-swagger-required-false-for-required-imodel-querystring-contracts-and-p/controller-2.ts"),
  ];
  for (const source of cases) {
    const root = fixture(t, source);
    await assert.rejects(
      generate({
        root,
        output: path.join(root, 'openapi.json'),
        info: { title: 'Required overlay', version: '1' },
        profile: { mobx: false, validation: false },
      }),
      error => expectCode(error, 'NEST1503'),
    );
  }
});

test('rejects an @ApiProperty additionalProperties that conflicts with a Record property type', async t => {
  // protects: T-457 additionalProperties on @ApiProperty was dropped, so a conflict with Record<string, number> went unreported
  const root = fixture(t, readFixture('controllers/overlay/rejects-an-apiproperty-additionalproperties-that-conflicts-with-a-record/controller.ts'));
  await assert.rejects(
    generate({ root, output: path.join(root, 'openapi.json'), info: { title: 'Overlay', version: '1' }, profile: { mobx: false, validation: false } }),
    error => expectCode(error, 'NEST1503'),
  );
});

test('writes an @ApiProperty additionalProperties that matches a Record property type', async t => {
  // protects: T-457 a matching additionalProperties on @ApiProperty is accepted and written to the document
  const root = fixture(t, readFixture('controllers/overlay/accepts-an-apiproperty-additionalproperties-that-matches-a-record/controller.ts'));
  const document = documentOf(await generate({ root, output: path.join(root, 'openapi.json'), info: { title: 'Overlay', version: '1' }, profile: { mobx: false, validation: false } }));
  const properties = document.paths['/widgets']?.get?.responses['200']?.content?.['application/json']?.schema?.properties;
  const scores = properties?.scores?.$ref?.replace('#/components/schemas/', '');
  assert.deepEqual(scores && document.components?.schemas?.[scores], { type: 'object', properties: {}, additionalProperties: { type: 'number' } });
});
