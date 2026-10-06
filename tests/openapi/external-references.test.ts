import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generate, loadValidatedDocument } from '#openapi/generator';
import { createFixtureProject } from '../fixture-project.js';

function write(directory: string, name: string, value: unknown): string {
  const filename = path.join(directory, name);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
  return filename;
}

const profile = { mobx: false, validation: false };

test('multi-file documents generate with path-based model names and watch every file', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-generate-');
  write(directory, 'paths/users.yaml', [
    'get:',
    '  operationId: listUsers',
    '  responses:',
    "    '200':",
    '      description: ok',
    '      content:',
    '        application/json:',
    "          schema: { type: array, items: { $ref: '../schemas/user.json' } }",
    '',
  ].join('\n'));
  write(directory, 'schemas/user.json', { type: 'object', required: ['id'], properties: { id: { type: 'string' } } });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'External', version: '1' },
    paths: { '/users': { $ref: './paths/users.yaml' } },
  });
  const result = await generate({ input, output: path.join(directory, 'sdk'), name: 'External', profile });
  const types = result.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
  assert.match(types, /SchemasUser/);
  const client = result.artifacts.find((artifact) => artifact.path.endsWith('/client.ts'))?.content ?? '';
  assert.match(client, /listUsers/);
  assert.deepEqual(result.watchInputs, [input, path.join(directory, 'paths/users.yaml'), path.join(directory, 'schemas/user.json')].sort());
});

test('validation errors point at the file that contains the problem', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-location-');
  write(directory, 'schemas/bad.json', { type: 'strng' });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Bad', version: '1' },
    components: { schemas: { Bad: { $ref: './schemas/bad.json' } } },
  });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /^OpenAPI validation failed with 1 error\(s\):\nschema: Does not match any of the allowed alternatives \(schemas\/bad\.json#\/type\)$/,
      );
      return true;
    },
  );
});

test('an unresolved pointer into another file is reported at the ref', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-unresolved-');
  write(directory, 'params.json', { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Missing', version: '1' },
    paths: { '/a': { get: { parameters: [{ $ref: './params.json#/Nope' }], responses: { 200: { description: 'ok' } } } } },
  });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'OpenAPI validation failed with 1 error(s):\n'
          + "no-unresolved-refs: Can't resolve $ref ./params.json#/Nope (api.json#/paths/~1a/get/parameters/0/$ref)",
      );
      return true;
    },
  );
});

test('a root ref to an $id declared in a local file resolves without remote access', async (t) => {
  for (const id of ['https://schemas.example/money', 'urn:example:money']) {
    const directory = createFixtureProject(t, 'golem-external-id-');
    write(directory, 'money.json', {
      $id: id,
      type: 'object',
      required: ['currency'],
      properties: { currency: { type: 'string' } },
    });
    const input = write(directory, 'api.json', {
      openapi: '3.1.0',
      info: { title: 'Identity', version: '1' },
      components: {
        schemas: {
          Money: { $ref: './money.json' },
          Price: { type: 'object', properties: { amount: { $ref: id } } },
        },
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
    try {
      const result = await generate({ input, output: path.join(directory, 'sdk'), profile });
      const types = result.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
      assert.match(types, /amount\?: Money/, id);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('a problem that names a second location reports it in the file that contains it', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-related-');
  write(directory, 'a.json', { get: { operationId: 'dup', responses: { 200: { description: 'ok' } } } });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Related', version: '1' },
    paths: {
      '/a': { $ref: './a.json' },
      '/b': { get: { operationId: 'dup', responses: { 200: { description: 'ok' } } } },
    },
  });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'OpenAPI validation failed with 1 error(s):\n'
          + 'operation-operationId-unique: operationId "dup" is used more than once (also at a.json#/get/operationId) (api.json#/paths/~1b/get/operationId)',
      );
      return true;
    },
  );
});

test('a 3.2 media type in another file is expanded in place in the loaded document', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-media-type-');
  write(directory, 'media.json', { schema: { type: 'string' } });
  const input = write(directory, 'api.json', {
    openapi: '3.2.0',
    info: { title: 'Media', version: '1' },
    paths: { '/a': { get: { operationId: 'getA', responses: { 200: { description: 'ok', content: { 'application/json': { $ref: './media.json' } } } } } } },
  });
  const document = await loadValidatedDocument(input);
  assert.deepEqual(Reflect.get(Object(document), 'paths'), {
    '/a': { get: { operationId: 'getA', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } } } },
  });
  assert.deepEqual(Reflect.get(Object(document), 'components'), { mediaTypes: { media: { schema: { type: 'string' } } } });
  const result = await generate({ input, output: path.join(directory, 'sdk'), profile });
  const client = result.artifacts.find((artifact) => artifact.path.endsWith('/client.ts'))?.content ?? '';
  assert.match(client, /getA/);
});

test('the root document is reported to the input observer once, also when it fails to parse', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-observer-');
  write(directory, 'schemas/user.json', { type: 'object' });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Observed', version: '1' },
    components: { schemas: { User: { $ref: './schemas/user.json' } } },
  });
  const observed: string[] = [];
  await generate({ input, output: path.join(directory, 'sdk'), profile, onInput: (file) => { observed.push(file); } });
  assert.deepEqual(observed.filter((file) => file === input), [input]);
  assert.ok(observed.includes(path.join(directory, 'schemas/user.json')));

  const broken = write(directory, 'broken.json', '{ not json');
  const observedBroken: string[] = [];
  await assert.rejects(
    () => generate({ input: broken, output: path.join(directory, 'sdk'), profile, onInput: (file) => { observedBroken.push(file); } }),
  );
  assert.deepEqual(observedBroken, [broken]);
});

function petsInput(directory: string, mapping: Record<string, string>): string {
  write(directory, 'pets.json', {
    Pet: { oneOf: [{ $ref: '#/Dog' }], discriminator: { propertyName: 'kind', mapping } },
    Dog: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
  });
  return write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1' },
    paths: { '/pets': { get: { operationId: 'listPets', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './pets.json#/Pet' } } } } } } } },
  });
}

test('a bare-name discriminator mapping in another file is reported with the mapping, the file and the fix', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-bare-mapping-');
  const input = petsInput(directory, { dog: 'Dog' });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'unsupported discriminator mapping "Dog" at pets.json#/Pet/discriminator/mapping/dog: a bare name in another file names a root component, '
          + 'and the root document declares no component "Dog". Use \'#/components/schemas/Dog\' or a root alias.',
      );
      return true;
    },
  );
});

test('an unresolvable discriminator mapping pointer in another file is reported at the mapping in that file', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-missing-mapping-');
  const input = petsInput(directory, { dog: '#/Dog', cat: './pets.json#/Cat' });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "OpenAPI validation failed with 1 error(s):\nno-unresolved-refs: Can't resolve discriminator mapping ./pets.json#/Cat (pets.json#/Pet/discriminator/mapping/cat)",
      );
      return true;
    },
  );
});

test('a JSON Schema $id declared in two files is reported with both files', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-duplicate-id-');
  write(directory, 'a.json', { $id: 'https://schemas.example/dup', type: 'string' });
  write(directory, 'b.json', { $id: 'https://schemas.example/dup', type: 'number' });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Duplicate', version: '1' },
    components: { schemas: { A: { $ref: './a.json' }, B: { $ref: './b.json' } } },
  });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'OpenAPI validation failed with 1 error(s):\n'
          + 'schema-id-unique: JSON Schema $id "https://schemas.example/dup" is declared more than once (also at a.json#/$id) (b.json#/$id)',
      );
      return true;
    },
  );
});

test('a format golem does not check is reported at the file and pointer that declare it', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-format-');
  write(directory, 'schemas/money.json', { type: 'object', properties: { amount: { type: 'string', format: 'money' } } });
  const money = { $ref: './schemas/money.json' };
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Ledger', version: '1' },
    paths: {
      '/credit': { post: { operationId: 'credit', requestBody: { required: true, content: { 'application/json': { schema: money } } }, responses: { 200: { description: 'ok' } } } },
      '/debit': { post: { operationId: 'debit', requestBody: { required: true, content: { 'application/json': { schema: money } } }, responses: { 200: { description: 'ok' } } } },
    },
  });
  const result = await generate({ input, output: path.join(directory, 'sdk'), name: 'Ledger', profile: { mobx: false, validation: true } });
  const warnings = result.diagnostics?.filter(entry => entry.code === 'VALIDATE_UNKNOWN_FORMAT') ?? [];
  // The operation validators name the exact pointer; the model names the component, which is the whole file.
  assert.deepEqual(warnings.map(entry => [entry.file, entry.path]).sort(), [
    ['schemas/money.json', '#'],
    ['schemas/money.json', '#/properties/amount/format'],
  ]);
});
