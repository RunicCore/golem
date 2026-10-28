import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import { assertGenerationRejected, writeOpenApiDocument } from './helpers.js';

// protects: T-508 a YAML .inf gets a located error, not a TypeError from type emission
test('a YAML .inf in a schema value stops generation with the document and pointer', async (t) => {
  const directory = createFixtureProject(t, 'golem-non-finite-yaml-');
  const input = writeOpenApiDocument(directory, [
    'openapi: 3.1.0',
    'info: { title: Bad, version: "1" }',
    'components:',
    '  schemas:',
    '    Rate: { type: number, enum: [1, .inf, -.inf, .nan] }',
    '',
  ].join('\n'), 'api.yaml');
  await assertGenerationRejected(
    input,
    'OpenAPI validation failed with 3 error(s):\n'
      + 'no-non-finite-numbers: Infinity is not a JSON number; use a finite number (api.yaml#/components/schemas/Rate/enum/1)\n'
      + 'no-non-finite-numbers: -Infinity is not a JSON number; use a finite number (api.yaml#/components/schemas/Rate/enum/2)\n'
      + 'no-non-finite-numbers: NaN is not a JSON number; use a finite number (api.yaml#/components/schemas/Rate/enum/3)',
    { errorClass: Error },
  );
});

// protects: T-508 a JSON 1e999 gets a located error, not a TypeError from type emission
test('a JSON 1e999 in a schema value stops generation with the document and pointer', async (t) => {
  const directory = createFixtureProject(t, 'golem-non-finite-json-');
  const input = writeOpenApiDocument(
    directory,
    '{"openapi":"3.1.0","info":{"title":"Bad","version":"1"},"components":{"schemas":{"Size":{"type":"number","maximum":1e999,"default":1e999}}}}',
    'api.json',
  );
  await assertGenerationRejected(
    input,
    'OpenAPI validation failed with 2 error(s):\n'
      + 'no-non-finite-numbers: Infinity is not a JSON number; use a finite number (api.json#/components/schemas/Size/maximum)\n'
      + 'no-non-finite-numbers: Infinity is not a JSON number; use a finite number (api.json#/components/schemas/Size/default)',
    { errorClass: Error },
  );
});
