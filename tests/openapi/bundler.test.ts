import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { bundleReferenceGraph, componentNameFor, type BundledDocument } from '#openapi/bundler';
import { loadReferenceGraph } from '#openapi/reference-loader';
import { createFixtureProject } from '../fixture-project.js';

function write(directory: string, name: string, value: unknown): string {
  const filename = path.join(directory, name);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
  return filename;
}

async function bundle(t: TestContext, files: Record<string, unknown>, document: unknown, rootName = 'api.json'): Promise<BundledDocument> {
  const directory = createFixtureProject(t, 'golem-bundler-');
  for (const [name, value] of Object.entries(files)) write(directory, name, value);
  const filename = write(directory, rootName, document);
  return bundleReferenceGraph(await loadReferenceGraph(filename, document));
}

function root(extra: Record<string, unknown>): Record<string, unknown> {
  return { openapi: '3.1.0', info: { title: 'Bundle', version: '1' }, ...extra };
}

test('componentNameFor builds path-based names', () => {
  const directory = '/work/api';
  const name = (file: string, pointer = ''): string =>
    componentNameFor({ uri: pathToFileURL(path.join(directory, file)).href, pointer }, directory);
  assert.equal(name('schemas/user.json'), 'schemas.user');
  assert.equal(name('other/user.json'), 'other.user');
  assert.equal(name('params.json', '/Defs/Money'), 'params.Defs.Money');
  assert.equal(name('common.yaml', '/components/schemas/Money'), 'common.Money');
  assert.equal(name('defs.json', '/$defs/Tag'), 'defs.Tag');
  assert.equal(name('defs.json', '/definitions/Tag'), 'defs.Tag');
  assert.equal(componentNameFor({ uri: 'https://schemas.example/money.json', pointer: '' }, directory), 'schemas.example.money');
  assert.equal(name('defs.json', '/a~1b'), 'defs.a_b');
  assert.equal(name('defs.json', '/with space'), 'defs.with_space');
});

test('external targets are hoisted and every ref is rewritten', async (t) => {
  const result = await bundle(t, {
    'schemas/user.json': { type: 'object', properties: { address: { $ref: './address.json' } } },
    'schemas/address.json': { type: 'object', properties: { city: { type: 'string' } } },
    'params.json': { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
  }, root({
    paths: {
      '/u': {
        get: {
          parameters: [{ $ref: './params.json#/Limit' }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './schemas/user.json' } } } } },
        },
      },
    },
    components: { schemas: { Local: { $ref: '#/components/schemas/Other' }, Other: { type: 'string' } } },
  }));
  const { document } = result;
  assert.deepEqual(document.paths, {
    '/u': {
      get: {
        parameters: [{ $ref: '#/components/parameters/params.Limit' }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/schemas.user' } } } } },
      },
    },
  });
  assert.deepEqual(document.components, {
    schemas: {
      Local: { $ref: '#/components/schemas/Other' },
      Other: { type: 'string' },
      'schemas.address': { type: 'object', properties: { city: { type: 'string' } } },
      'schemas.user': { type: 'object', properties: { address: { $ref: '#/components/schemas/schemas.address' } } },
    },
    parameters: { 'params.Limit': { name: 'limit', in: 'query', schema: { type: 'integer' } } },
  });
  const userOrigin = result.originOf('/components/schemas/schemas.user/properties/address');
  assert.match(userOrigin.uri, /schemas\/user\.json$/);
  assert.equal(userOrigin.pointer, '/properties/address');
  assert.match(result.originOf('/paths/~1u').uri, /api\.json$/);
  assert.equal(result.originOf('/paths/~1u').pointer, '/paths/~1u');
});

test('cross-file cycles become component refs', async (t) => {
  const result = await bundle(t, {
    'a.json': { type: 'object', properties: { b: { $ref: './b.json' } } },
    'b.json': { type: 'object', properties: { a: { $ref: './a.json' } } },
  }, root({ components: { schemas: { Start: { $ref: './a.json' } } } }));
  const { document } = result;
  assert.deepEqual(document.components, {
    schemas: {
      Start: { type: 'object', properties: { b: { $ref: '#/components/schemas/b' } } },
      b: { type: 'object', properties: { a: { $ref: '#/components/schemas/Start' } } },
    },
  });
  const origin = result.originOf('/components/schemas/Start/properties/b');
  assert.match(origin.uri, /a\.json$/);
  assert.equal(origin.pointer, '/properties/b');
});

test('a ref from an external file back into the root becomes a root pointer', async (t) => {
  const { document } = await bundle(t, {
    'x.json': {
      type: 'object',
      properties: {
        shared: { $ref: './api.json#/components/schemas/Shared' },
        // A root name needing percent-encoding is written back as a URI fragment.
        named: { $ref: './api.json#/components/schemas/My%20Type' },
      },
    },
  }, root({ components: { schemas: { Shared: { type: 'string' }, 'My Type': { type: 'string' }, X: { $ref: './x.json' } } } }));
  assert.deepEqual(document.components, {
    schemas: {
      Shared: { type: 'string' },
      'My Type': { type: 'string' },
      X: {
        type: 'object',
        properties: {
          shared: { $ref: '#/components/schemas/Shared' },
          named: { $ref: '#/components/schemas/My%20Type' },
        },
      },
    },
  });
});

test('refs to an absolute $id are kept and the $id schema is hoisted', async (t) => {
  const { document } = await bundle(t, {
    'money.json': { $id: 'https://schemas.example/money', type: 'number' },
    'order.json': { type: 'object', properties: { total: { $ref: 'https://schemas.example/money' } } },
  }, root({ components: { schemas: { Money: { $ref: './money.json' }, Order: { $ref: './order.json' } } } }));
  assert.deepEqual(document.components, {
    schemas: {
      Money: { $id: 'https://schemas.example/money', type: 'number' },
      Order: { type: 'object', properties: { total: { $ref: 'https://schemas.example/money' } } },
    },
  });
});

test('two root aliases to the same external target: the first name in code-unit order wins, the other becomes a ref to it', async (t) => {
  const { document } = await bundle(t, { 'shared.json': { type: 'string' } },
    // Declared out of code-unit order (B before A) to prove the winner is chosen by name, not by declaration order.
    root({ components: { schemas: { B: { $ref: './shared.json' }, A: { $ref: './shared.json' } } } }));
  assert.deepEqual(document.components, {
    schemas: {
      B: { $ref: '#/components/schemas/A' },
      A: { type: 'string' },
    },
  });
});

test('identifier collisions fail with both origins named', async (t) => {
  const cases = [
    {
      label: 'case-differing root aliases to the same external target',
      files: { 'shared.json': { type: 'string' } },
      components: { schemas: { Foo: { $ref: './shared.json' }, foo: { $ref: './shared.json' } } },
      pattern: /components\/schemas name collision: api\.json#\/components\/schemas\/foo and shared\.json# both map to identifier Foo/,
    },
    {
      label: 'external files whose names differ only in case',
      files: { 'models/User.json': { type: 'string' }, 'models/user.yaml': 'type: number' },
      components: {
        schemas: {
          Container: {
            type: 'object',
            properties: { a: { $ref: './models/User.json' }, b: { $ref: './models/user.yaml' } },
          },
        },
      },
      pattern: /components\/schemas name collision: models\/User\.json# and models\/user\.yaml# both map to identifier ModelsUser/,
    },
    {
      label: 'a hoisted name that collides with a root component',
      files: { 'schemas/user.json': { type: 'string' } },
      components: {
        schemas: {
          SchemasUser: { type: 'number' },
          Container: { type: 'object', properties: { a: { $ref: './schemas/user.json' } } },
        },
      },
      pattern: /components\/schemas name collision: api\.json#\/components\/schemas\/SchemasUser and schemas\/user\.json# both map to identifier SchemasUser/,
    },
  ];
  for (const { label, files, components, pattern } of cases) {
    await assert.rejects(() => bundle(t, files, root({ components })), pattern, label);
  }
});

test('one target used as two component kinds fails', async (t) => {
  await assert.rejects(
    () => bundle(t, { 'shared.json': { schema: { type: 'string' } } }, root({
      paths: {
        '/a': {
          get: {
            parameters: [{ $ref: './shared.json' }],
            responses: { 200: { description: 'ok', headers: { 'X-A': { $ref: './shared.json' } } } },
          },
        },
      },
    })),
    /shared\.json# is referenced as components\/(parameters|headers) at .* and as components\/(parameters|headers) at /,
  );
});

test('a YAML alias shared by two locations is rewritten in both', async (t) => {
  const yaml = [
    'openapi: 3.1.0',
    'info: { title: Alias, version: "1" }',
    'components:',
    '  schemas:',
    '    A:',
    '      type: object',
    '      properties:',
    '        first: &shared { $ref: "./x.json" }',
    '        second: *shared',
    '',
  ].join('\n');
  const directory = createFixtureProject(t, 'golem-bundler-alias-');
  write(directory, 'x.json', { type: 'string' });
  const filename = write(directory, 'api.yaml', yaml);
  const document: unknown = YAML.parse(yaml);
  const { document: bundled } = bundleReferenceGraph(await loadReferenceGraph(filename, document));
  assert.deepEqual(bundled.components, {
    schemas: {
      A: { type: 'object', properties: { first: { $ref: '#/components/schemas/x' }, second: { $ref: '#/components/schemas/x' } } },
      x: { type: 'string' },
    },
  });
});

test('a ref inside a nested hoist is rewritten in both the whole-file clone and the nested-slice clone', async (t) => {
  const { document } = await bundle(t, {
    'money.json': { type: 'number' },
    'container.json': { type: 'object', $defs: { X: { $ref: './money.json' } } },
  }, root({
    components: {
      schemas: {
        Whole: { $ref: './container.json' },
        Piece: { $ref: './container.json#/$defs/X' },
      },
    },
  }));
  assert.deepEqual(document.components, {
    schemas: {
      Whole: { type: 'object', $defs: { X: { $ref: '#/components/schemas/money' } } },
      Piece: { $ref: '#/components/schemas/money' },
      money: { type: 'number' },
    },
  });
});

test('a $dynamicRef to an external file is hoisted and rewritten; a $dynamicRef anchor is kept as written', async (t) => {
  const { document } = await bundle(t, { 'lib.json': { type: 'string' } }, root({
    components: {
      schemas: {
        A: { type: 'object', properties: { x: { $dynamicRef: './lib.json' } } },
        B: { $dynamicRef: '#node' },
      },
    },
  }));
  assert.deepEqual(document.components, {
    schemas: {
      A: { type: 'object', properties: { x: { $dynamicRef: '#/components/schemas/lib' } } },
      B: { $dynamicRef: '#node' },
      lib: { type: 'string' },
    },
  });
});

test('an unresolved external pointer is left as written', async (t) => {
  const { document } = await bundle(t, { 'x.json': { a: { type: 'string' } } },
    root({ components: { schemas: { A: { $ref: './x.json#/missing' } } } }));
  assert.deepEqual(document.components, { schemas: { A: { $ref: './x.json#/missing' } } });
});

const dogVariant = { type: 'object', required: ['kind'], properties: { kind: { type: 'string' }, bark: { type: 'boolean' } } };
const catVariant = { type: 'object', required: ['kind'], properties: { kind: { type: 'string' }, purr: { type: 'boolean' } } };

test('a root discriminator mapping to another file is hoisted and rewritten; a bare component name stays as written', async (t) => {
  const { document } = await bundle(t, { 'dog.json': dogVariant }, root({
    components: {
      schemas: {
        Cat: catVariant,
        Pet: {
          oneOf: [{ $ref: './dog.json' }, { $ref: '#/components/schemas/Cat' }],
          discriminator: { propertyName: 'kind', mapping: { dog: './dog.json', 'dog~v1/x': './dog.json', cat: 'Cat' } },
        },
      },
    },
  }));
  assert.deepEqual(document.components, {
    schemas: {
      Cat: catVariant,
      Pet: {
        oneOf: [{ $ref: '#/components/schemas/dog' }, { $ref: '#/components/schemas/Cat' }],
        discriminator: { propertyName: 'kind', mapping: { dog: '#/components/schemas/dog', 'dog~v1/x': '#/components/schemas/dog', cat: 'Cat' } },
      },
      dog: dogVariant,
    },
  });
});

test('a discriminator mapping inside another file is rewritten to the hoisted component', async (t) => {
  const { document } = await bundle(t, {
    'pets.json': {
      components: {
        schemas: {
          Pet: {
            oneOf: [{ $ref: '#/components/schemas/Dog' }],
            discriminator: { propertyName: 'kind', mapping: { dog: '#/components/schemas/Dog' } },
          },
          Dog: dogVariant,
        },
      },
    },
  }, root({ components: { schemas: { Pet: { $ref: './pets.json#/components/schemas/Pet' } } } }));
  assert.deepEqual(document.components, {
    schemas: {
      Pet: {
        oneOf: [{ $ref: '#/components/schemas/pets.Dog' }],
        discriminator: { propertyName: 'kind', mapping: { dog: '#/components/schemas/pets.Dog' } },
      },
      'pets.Dog': dogVariant,
    },
  });
});

test('a 3.2 discriminator defaultMapping to another file is hoisted and rewritten', async (t) => {
  const { document } = await bundle(t, { 'dog.json': dogVariant, 'cat.json': catVariant }, {
    openapi: '3.2.0',
    info: { title: 'Bundle', version: '1' },
    components: {
      schemas: {
        Pet: {
          oneOf: [{ $ref: './cat.json' }],
          discriminator: { propertyName: 'kind', defaultMapping: './dog.json' },
        },
      },
    },
  });
  assert.deepEqual(document.components, {
    schemas: {
      Pet: {
        oneOf: [{ $ref: '#/components/schemas/cat' }],
        discriminator: { propertyName: 'kind', defaultMapping: '#/components/schemas/dog' },
      },
      cat: catVariant,
      dog: dogVariant,
    },
  });
});

test('a 3.2 media type in another file is hoisted into components/mediaTypes', async (t) => {
  const { document } = await bundle(t, { 'media.json': { schema: { type: 'string' } } }, {
    openapi: '3.2.0',
    info: { title: 'Bundle', version: '1' },
    paths: { '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { $ref: './media.json' } } } } } } },
  });
  assert.deepEqual(document.paths, {
    '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { $ref: '#/components/mediaTypes/media' } } } } } },
  });
  assert.deepEqual(document.components, { mediaTypes: { media: { schema: { type: 'string' } } } });
});
