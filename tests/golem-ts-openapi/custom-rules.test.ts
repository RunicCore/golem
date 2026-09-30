import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

type OpenApiSchemaValue = boolean | OpenApiSchema;

interface OpenApiSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly properties?: Readonly<Record<string, OpenApiSchemaValue>>;
  readonly [keyword: string]: unknown;
}

interface OpenApiDocument {
  readonly components?: {
    readonly schemas?: Readonly<Record<string, OpenApiSchemaValue>>;
  };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
}

interface OpenApiOperation {
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

interface OpenApiResponse {
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

interface OpenApiMediaType {
  readonly schema?: OpenApiSchemaValue;
}

interface DiagnosticLike {
  readonly code?: unknown;
  readonly severity?: unknown;
  readonly message?: unknown;
  readonly file?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fixture(t: TestContext): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-custom-rules-',
    packageName: 'golem-ts-openapi-custom-rules-fixture',
    files: {
      'src/predicates.ts': readFixture('controllers/custom-rules/project/predicates.ts'),
      'src/catalog.controller.ts': readFixture('controllers/custom-rules/project/catalog.controller.ts'),
    },
  });
}

function documentOf(result: Awaited<ReturnType<typeof generate>>): OpenApiDocument {
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  const value: unknown = JSON.parse(artifact.content);
  if (!record(value) || !record(value.paths)) throw new Error('Generated OpenAPI document is invalid.');
  return value as unknown as OpenApiDocument;
}

function schemaOf(document: OpenApiDocument, name: string): OpenApiSchema {
  const schemas = document.components?.schemas;
  const value = schemas?.[name];
  if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected component schema ${name}.`);
  }
  return value;
}

function diagnosticsOf(result: Awaited<ReturnType<typeof generate>>): readonly DiagnosticLike[] {
  return (result.diagnostics ?? []).map(item => ({
    code: item.code,
    severity: item.severity,
    message: item.message,
    file: item.file,
  }));
}

test('keeps custom TValidation server-side with a typed warning and no executable OpenAPI metadata', async t => {
  const root = fixture(t);
  const result = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Custom rules', version: '1' },
    profile: { mobx: false, validation: false },
  });
  const diagnostics = diagnosticsOf(result);
  const warning = diagnostics.find(item => item.code === 'NEST1502');
  assert.ok(warning, 'custom executable validation must produce a nonportable-schema warning');
  assert.equal(warning.severity, 'warning');
  assert.equal(typeof warning.message, 'string');
  assert.match(warning.message as string, /not included in OpenAPI/i);

  const artifact = result.artifacts[0];
  assert.ok(artifact);
  const documentText = artifact.content;
  assert.doesNotMatch(documentText, /positive/);
  assert.doesNotMatch(documentText, /predicates\.ts/);
  assert.doesNotMatch(documentText, /function|=>/);

  const document = documentOf(result);
  const operation = document.paths['/catalog']?.get;
  assert.ok(operation);
  const responseSchema = operation.responses['200']?.content?.['application/json']?.schema;
  assert.ok(responseSchema && typeof responseSchema === 'object' && '$ref' in responseSchema);
  const item = schemaOf(document, 'CatalogItem');
  const value = item.properties?.value;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.type, 'number');
  assert.equal('validations' in value, false);
});
