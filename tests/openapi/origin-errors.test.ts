import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate, loadValidatedDocument, validate, writeSdk } from '#openapi/generator';
import { createFixtureProject } from '../fixture-project.js';
import { writeOpenApiDocument } from './helpers.js';

const profile = { mobx: false, validation: false };

function rootDocument(components: Record<string, unknown>): Record<string, unknown> {
  return { openapi: '3.1.0', info: { title: 'Origins', version: '1' }, components: { schemas: components } };
}

async function generationError(input: string, directory: string): Promise<string> {
  try {
    await generate({ input, output: path.join(directory, 'sdk'), profile });
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  throw new Error('generation succeeded');
}

const petsFile = {
  Pet: {
    oneOf: [{ $ref: '#/Dog' }],
    discriminator: { propertyName: 'kind', mapping: { dog: '#/Dog', cat: '#/Cat' } },
  },
  Dog: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
  Cat: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
};

test('a discriminator error names the file and pointer the schema came from', async (t) => {
  const directory = createFixtureProject(t, 'golem-origin-discriminator-');
  writeOpenApiDocument(directory, petsFile, 'pets.json');
  const input = writeOpenApiDocument(directory, rootDocument({ Pet: { $ref: './pets.json#/Pet' } }), 'api.json');
  assert.match(await generationError(input, directory), /^discriminator mapping "cat" of schema "[^"]+" \(pets\.json#\/Pet\) targets /);
});

test('a generated name collision names where each component is declared', async (t) => {
  const directory = createFixtureProject(t, 'golem-origin-collision-');
  const input = writeOpenApiDocument(directory, rootDocument({
    'Foo-Bar': { type: 'object', properties: { value: { type: 'string' } } },
    'Foo.Bar': { type: 'object', properties: { other: { type: 'string' } } },
  }), 'api.json');
  const message = await generationError(input, directory);
  assert.match(message, /component schema "Foo-Bar" \(api\.json#\/components\/schemas\/Foo-Bar\) and component schema "Foo\.Bar" \(api\.json#\/components\/schemas\/Foo\.Bar\)$/);
});

test('a field-name error names the file the schema came from', async (t) => {
  const directory = createFixtureProject(t, 'golem-origin-field-name-');
  writeOpenApiDocument(directory, { type: 'object', properties: { toString: { type: 'string' } } }, 'schemas/user.json');
  const input = writeOpenApiDocument(directory, rootDocument({ User: { $ref: './schemas/user.json' } }), 'api.json');
  assert.match(await generationError(input, directory), /\(at schemas\/user\.json#\)$/);
});

test('a single-file input names the root file, and calls without a locator keep the bundled-key messages', async (t) => {
  const directory = createFixtureProject(t, 'golem-origin-single-');
  const document = rootDocument({
    Pet: { oneOf: [{ $ref: '#/components/schemas/Dog' }], discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat' } } },
    Dog: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
    Cat: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
  });
  const input = writeOpenApiDocument(directory, document, 'api.json');
  assert.equal(
    await generationError(input, directory),
    'discriminator mapping "cat" of schema "Pet" (api.json#/components/schemas/Pet) targets "#/components/schemas/Cat", which is not one of its variants',
  );
  const loaded = await loadValidatedDocument(input);
  assert.throws(
    () => writeSdk(loaded, { output: path.join(directory, 'sdk'), profile }),
    { message: 'discriminator mapping "cat" of schema "Pet" targets "#/components/schemas/Cat", which is not one of its variants' },
  );
  assert.throws(
    () => validate(rootDocument({ User: { type: 'object', properties: { toString: { type: 'string' } } } })),
    /\(at #\/components\/schemas\/User\)$/,
  );
});
