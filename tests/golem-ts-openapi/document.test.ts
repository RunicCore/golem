import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#ts-openapi/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

function fixture(t: TestContext, source: string): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-document-',
    packageName: 'golem-ts-openapi-document-fixture',
    source,
  });
}

function diagnosticsOf(error: unknown): readonly { readonly code?: unknown; readonly message?: unknown }[] {
  if (error === null || typeof error !== 'object' || !('diagnostics' in error)) return [];
  const diagnostics = (error as { readonly diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics)
    ? diagnostics.filter((item): item is { readonly code?: unknown; readonly message?: unknown } => item !== null && typeof item === 'object')
    : [];
}

async function expectDiagnostic(
  operation: Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    const diagnostics = diagnosticsOf(error);
    assert.ok(diagnostics.some(item => item.code === code), `expected diagnostic ${code}`);
    assert.match(String(error), message);
    return true;
  });
}

const controller = readFixture("controllers/document/project/controller.ts");

test('rejects a server entry without the required URL', async t => {
  const root = fixture(t, controller);
  await expectDiagnostic(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Catalog', version: '1' },
      servers: [{}],
      profile: { validation: false },
    }),
    'NEST1403',
    /servers\[0\]\.url must be a non-empty string/,
  );
});

test('validates server variables as OpenAPI server objects', async t => {
  const root = fixture(t, controller);
  const result = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Catalog', version: '1' },
    servers: [{
      url: 'https://{region}.example.test',
      variables: { region: { default: 'us', enum: ['us', 'eu'] } },
    }],
    profile: { validation: false },
  });
  const document = JSON.parse(result.artifacts[0]!.content) as { readonly servers?: readonly Record<string, unknown>[] };
  assert.equal(document.servers?.[0]?.url, 'https://{region}.example.test');
  assert.deepEqual(document.servers?.[0]?.variables, { region: { default: 'us', enum: ['us', 'eu'] } });
});

test('rejects malformed security scheme metadata with a typed diagnostic', async t => {
  const root = fixture(t, controller);
  await expectDiagnostic(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Catalog', version: '1' },
      securitySchemes: { bearer: { type: 'http' } },
      profile: { validation: false },
    }),
    'NEST1404',
    /components\.securitySchemes\.bearer\.scheme must be a non-empty string/,
  );
});

test('keeps valid security schemes and static ApiSecurity requirements', async t => {
  const root = fixture(t, readFixture("controllers/document/keeps-valid-security-schemes-and-static-apisecurity-requirements/controller.ts"));
  const result = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Catalog', version: '1' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    profile: { validation: false },
  });
  const document = JSON.parse(result.artifacts[0]!.content) as {
    readonly components?: { readonly securitySchemes?: Record<string, unknown> };
    readonly paths: Record<string, Record<string, { readonly security?: readonly Record<string, readonly string[]>[] }>>;
  };
  assert.deepEqual(document.components?.securitySchemes?.bearer, { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  assert.deepEqual(document.paths['/catalog']?.get?.security, [{ bearer: ['catalog:read'] }]);
});

test('rejects a security decorator that references an unconfigured scheme', async t => {
  const root = fixture(t, readFixture("controllers/document/rejects-a-security-decorator-that-references-an-unconfigured-scheme/controller.ts"));
  await expectDiagnostic(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Catalog', version: '1' },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      profile: { validation: false },
    }),
    'NEST1405',
    /references security scheme "missing"/,
  );
});
