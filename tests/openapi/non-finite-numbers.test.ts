import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#openapi/generator';
import { createFixtureProject } from '../fixture-project.js';

const profile = { mobx: false, validation: false };

function write(directory: string, name: string, source: string): string {
  const filename = path.join(directory, name);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, source);
  return filename;
}

// protects: T-508 a YAML .inf gets a located error, not a TypeError from type emission
test('a YAML .inf in a schema value stops generation with the document and pointer', async (t) => {
  const directory = createFixtureProject(t, 'golem-non-finite-yaml-');
  const input = write(directory, 'api.yaml', [
    'openapi: 3.1.0',
    'info: { title: Bad, version: "1" }',
    'components:',
    '  schemas:',
    '    Rate: { type: number, enum: [1, .inf, -.inf, .nan] }',
    '',
  ].join('\n'));
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.constructor, Error);
      assert.equal(
        error.message,
        'OpenAPI validation failed with 3 error(s):\n'
          + 'no-non-finite-numbers: Infinity is not a JSON number; use a finite number (api.yaml#/components/schemas/Rate/enum/1)\n'
          + 'no-non-finite-numbers: -Infinity is not a JSON number; use a finite number (api.yaml#/components/schemas/Rate/enum/2)\n'
          + 'no-non-finite-numbers: NaN is not a JSON number; use a finite number (api.yaml#/components/schemas/Rate/enum/3)',
      );
      return true;
    },
  );
});

// protects: T-508 a JSON 1e999 gets a located error, not a TypeError from type emission
test('a JSON 1e999 in a schema value stops generation with the document and pointer', async (t) => {
  const directory = createFixtureProject(t, 'golem-non-finite-json-');
  const input = write(
    directory,
    'api.json',
    '{"openapi":"3.1.0","info":{"title":"Bad","version":"1"},"components":{"schemas":{"Size":{"type":"number","maximum":1e999,"default":1e999}}}}',
  );
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.constructor, Error);
      assert.equal(
        error.message,
        'OpenAPI validation failed with 2 error(s):\n'
          + 'no-non-finite-numbers: Infinity is not a JSON number; use a finite number (api.json#/components/schemas/Size/maximum)\n'
          + 'no-non-finite-numbers: Infinity is not a JSON number; use a finite number (api.json#/components/schemas/Size/default)',
      );
      return true;
    },
  );
});
