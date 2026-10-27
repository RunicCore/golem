import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#openapi/generator';
import { createFixtureProject } from '../fixture-project.js';
import { writeOpenApiDocument } from './helpers.js';

const text = { type: 'string' };
const tag = (value: string) => ({ type: 'string', const: value });
const tagged = (value: string) => ({ type: 'object', required: ['kind'], properties: { kind: tag(value) } });
const profile = { mobx: false, validation: false };

async function generated(t: test.TestContext, schemas: Record<string, unknown>) {
  const directory = createFixtureProject(t, 'golem-openapi-emission-guards-');
  const input = writeOpenApiDocument(directory, { openapi: '3.1.0', info: { title: 'Guards', version: '1' }, components: { schemas } });
  return generate({ input, output: path.join(directory, 'sdk'), profile });
}

test('a composition error names the allOf member by its place in the schema, also after a union is spread', async (t) => {
  // protects: T-492 messages keep the original allOf member index
  // The union member holds keywords beside its oneOf, so the spread allOf has one more member before the closed one.
  await assert.rejects(generated(t, {
    Visit: {
      type: 'object',
      properties: {
        m: {
          allOf: [
            { type: 'object', properties: { b: text }, oneOf: [tagged('k'), tagged('l')] },
            { type: 'object', additionalProperties: false, properties: { a: text } },
          ],
        },
      },
    },
  }), /because allOf member 1 sets additionalProperties: false/);
});

test('a schema group file is named by a 16-digit hash that is stable and differs for each group', async (t) => {
  // protects: T-492 group ids come from a long hash; a repeated id stops generation
  const cycle = (other: string) => ({ type: 'object', properties: { next: { $ref: `#/components/schemas/${other}` } } });
  const schemas = { A: cycle('B'), B: cycle('A'), C: cycle('D'), D: cycle('C') };
  const groupFiles = async () => (await generated(t, schemas)).artifacts.map(({ path: file }) => path.join('models', path.basename(file))).filter((file) => /_group-/.test(file)).sort();
  const first = await groupFiles();
  assert.equal(first.length, 2);
  for (const file of first) assert.match(file, /^models\/_group-[0-9a-f]{16}\.ts$/);
  assert.notEqual(first[0], first[1]);
  assert.deepEqual(await groupFiles(), first);
});
