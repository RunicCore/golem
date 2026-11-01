import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { documentOf, schemaOf } from './openapi-document.js';

interface DiagnosticLike {
  readonly code?: unknown;
  readonly severity?: unknown;
  readonly message?: unknown;
  readonly file?: unknown;
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
    profile: { validation: false },
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
  const item = schemaOf(document, 'TCatalogItem');
  const value = item.properties?.value;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.type, 'number');
  assert.equal('validations' in value, false);
});
