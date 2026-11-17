import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { recordOrUndefined } from '@exprtlabs/golem/internal/generator-support';
import { DEFAULT_OPENAPI_VERSION, OPENAPI_VERSIONS } from '#ts-openapi/openapi-version';
import { URI_VERSIONING_TYPES } from '#ts-openapi/uri-versioning';
import { repoRoot } from '../openapi/helpers.js';

/** The value at `keys` below `value`, or `undefined` where a step is no record or has no such key. */
function valueAt(value: unknown, ...keys: readonly string[]): unknown {
  return keys.reduce<unknown>((current, key) => recordOrUndefined(current)?.[key], value);
}

test('the editor schema lists the OpenAPI versions and the default that the docs job accepts', () => {
  // protects: T-939 / comment #2733, golem-schema.json holds a hand-written copy of the version list that the job reads
  const schema: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'packages/golem-ts-openapi/golem-schema.json'), 'utf8'));
  const versionKeys = ['properties', 'docs', 'items', 'properties', 'openapiVersion'];

  assert.deepEqual(valueAt(schema, ...versionKeys, 'enum'), [...OPENAPI_VERSIONS]);
  assert.equal(valueAt(schema, ...versionKeys, 'default'), DEFAULT_OPENAPI_VERSION);
});

test('the editor schema and the config reference list the URI versioning spellings that the docs job accepts', () => {
  // protects: E-106, golem-schema.json and docs/reference/config.md hold hand-written copies of the spelling list
  const schema: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'packages/golem-ts-openapi/golem-schema.json'), 'utf8'));
  const reference = fs.readFileSync(path.join(repoRoot(), 'docs/reference/config.md'), 'utf8');
  const spellings = URI_VERSIONING_TYPES.map(spelling => `\`${spelling}\``);

  assert.deepEqual(valueAt(schema, 'properties', 'docs', 'items', 'properties', 'uriVersioning', 'properties', 'type', 'enum'), [...URI_VERSIONING_TYPES]);
  assert.ok(reference.includes(`optional \`type\` (${spellings.slice(0, -1).join(', ')} or ${spellings.at(-1)})`));
});
