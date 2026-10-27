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
  // The nested row spreads a union inside the variants of the first, so the shift happens twice.
  const closed = { type: 'object', additionalProperties: false, properties: { a: text } };
  const rows = [
    { union: { type: 'object', properties: { b: text }, oneOf: [tagged('k'), tagged('l')] } },
    { union: { type: 'object', properties: { b: text }, oneOf: [{ type: 'object', properties: { c: text }, oneOf: [tagged('k'), tagged('l')] }, tagged('m')] } },
  ];
  for (const { union } of rows) {
    await assert.rejects(generated(t, { Visit: { type: 'object', properties: { m: { allOf: [union, closed] } } } }), /because allOf member 1 sets additionalProperties: false/);
  }
});
