import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_OPENAPI_VERSION, OPENAPI_VERSIONS } from '#ts-openapi/openapi-version';
import { repoRoot } from '../openapi/helpers.js';

interface DocsSchema {
  readonly properties: { readonly docs: { readonly items: { readonly properties: { readonly openapiVersion: { readonly enum: readonly string[]; readonly default: string } } } } };
}

test('the editor schema lists the OpenAPI versions and the default that the docs job accepts', () => {
  // protects: T-939 / comment #2733, golem-schema.json holds a hand-written copy of the version list that the job reads
  const schema: DocsSchema = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'packages/golem-ts-openapi/golem-schema.json'), 'utf8'));

  const { openapiVersion } = schema.properties.docs.items.properties;

  assert.deepEqual(openapiVersion.enum, [...OPENAPI_VERSIONS]);
  assert.equal(openapiVersion.default, DEFAULT_OPENAPI_VERSION);
});
