import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import { command } from '../packed/helpers.js';
import { writeSdk } from '#openapi/generator';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
  writeGeneratedSdk,
} from './helpers.js';

// The lowering pass is internal to the built package; load it from dist instead of compiling package source into the tests.
const distRoot = path.dirname(fileURLToPath(import.meta.resolve('@exprtlabs/codegen/model')));
const { lowerDiscriminatorMappings } = await import(pathToFileURL(path.join(distRoot, 'discriminator-mapping.js')).href) as {
  readonly lowerDiscriminatorMappings: <Schema>(schema: Schema) => Schema;
};

/** Cat and Dog declare `kind` as a plain string; only the mapping ties tag values to them. */
const petDocument = {
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1' },
  paths: {
    '/owners': {
      post: {
        operationId: 'createOwner',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Owner' } } } },
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Owner' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Cat: { type: 'object', required: ['name'], properties: { kind: { type: 'string' }, name: { type: 'string' } } },
      Dog: { type: 'object', required: ['bark'], properties: { kind: { type: 'string' }, bark: { type: 'boolean' } } },
      Pet: {
        oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
        discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } },
      },
      Owner: { type: 'object', required: ['pet'], properties: { pet: { $ref: '#/components/schemas/Pet' } } },
    },
  },
};

interface CaseReport {
  readonly validateCodec: boolean;
  readonly validateModel: boolean;
  readonly encodeOwner: boolean;
  readonly toWireFormat: boolean;
  readonly stringify: boolean;
}

const expected: Readonly<Record<string, boolean>> = {
  taggedPlain: true,
  untaggedCatModel: true,
  untaggedPlain: false,
  untaggedStranger: false,
  taggedStranger: true,
  catModelForeignTag: false,
};

for (const ajvStandalone of [false, true]) {
  test(`discriminator mapping: validation agrees with encode and round trip (ajvStandalone=${ajvStandalone})`, async (t) => {
    const output = path.join(createFixtureProject(t, 'runic-openapi-standalone-discriminator-'), 'sdk');
    await generateMaterializedSdk(petDocument, { output, name: 'Pets', profile: { mobx: false, validation: true, ajvStandalone } });
    compileGeneratedSdk(output, [], { strict: true });
    copyFixtureFile(output, 'openapi/standalone-discriminator/verify.mjs', 'verify.mjs');
    // Standalone validators must run where code generation from strings is blocked.
    const flags = ajvStandalone ? ['--disallow-code-generation-from-strings'] : [];
    const result = await command(output, process.execPath, [...flags, 'verify.mjs']);
    const { codeGeneration, report } = JSON.parse(result.stdout) as {
      readonly codeGeneration: string;
      readonly report: Readonly<Record<string, CaseReport>>;
    };
    if (ajvStandalone) assert.equal(codeGeneration, 'blocked');
    for (const [name, outcome] of Object.entries(report)) {
      assert.deepEqual(outcome, {
        validateCodec: expected[name],
        validateModel: expected[name],
        encodeOwner: expected[name],
        toWireFormat: expected[name],
        stringify: expected[name],
      }, name);
    }
    assert.deepEqual(Object.keys(report).sort(), Object.keys(expected).sort());
  });
}

/** A mapping names its target in the document's own spelling: an escaped pointer, a bare name, or a schema `$id`. */
function mappedDocument(cat: string, dog: string, refs: { readonly branch: string; readonly mapping: string }): Record<string, unknown> {
  const pointer = (name: string) => `#/components/schemas/${encodeURIComponent(name.replaceAll('~', '~0').replaceAll('/', '~1'))}`;
  return {
    openapi: '3.1.0',
    info: { title: 'Names', version: '1' },
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          responses: { 200: { description: 'ok' } },
        },
      },
    },
    components: {
      schemas: {
        [cat]: {
          ...(refs.branch.startsWith('https:') || refs.mapping.startsWith('https:') ? { $id: 'https://pets.test/cat' } : {}),
          type: 'object', required: ['name'], properties: { kind: { type: 'string' }, name: { type: 'string' } },
        },
        [dog]: { type: 'object', required: ['bark'], properties: { kind: { type: 'string' }, bark: { type: 'boolean' } } },
        Pet: {
          oneOf: [{ $ref: refs.branch === 'pointer' ? pointer(cat) : refs.branch }, { $ref: pointer(dog) }],
          discriminator: {
            propertyName: 'kind',
            mapping: { cat: refs.mapping === 'pointer' ? pointer(cat) : refs.mapping, dog: pointer(dog) },
          },
        },
      },
    },
  };
}

const escapedNameDocuments: readonly [string, Record<string, unknown>][] = [
  ['space', mappedDocument('Pet Cat', 'Pet Dog', { branch: 'pointer', mapping: 'pointer' })],
  ['tilde', mappedDocument('a~cat', 'a~dog', { branch: 'pointer', mapping: 'pointer' })],
  ['slash', mappedDocument('a/cat', 'a/dog', { branch: 'pointer', mapping: 'pointer' })],
  ['$id branch', mappedDocument('Cat', 'Dog', { branch: 'https://pets.test/cat', mapping: 'pointer' })],
  ['$id mapping', mappedDocument('Cat', 'Dog', { branch: 'pointer', mapping: 'https://pets.test/cat' })],
];

// Each profile generates, compiles and runs the SDK: runtime Ajv lowers mappings as the
// generated modules register schemas; standalone lowers them at generation.
for (const ajvStandalone of [false, true]) {
  test(`discriminator mappings select variants for escaped names and $id references (ajvStandalone=${ajvStandalone})`, async (t) => {
    for (const [label, document] of escapedNameDocuments) {
      const output = path.join(createFixtureProject(t, 'runic-openapi-mapped-names-'), 'sdk');
      // These component names are outside the OpenAPI component-key pattern, so the document is not re-validated.
      writeGeneratedSdk(writeSdk, document, { output, name: 'Names', profile: { mobx: false, validation: true, ajvStandalone } });
      compileGeneratedSdk(output, [], { strict: true });
      copyFixtureFile(output, 'openapi/standalone-discriminator/verify-mapping.mjs', 'verify-mapping.mjs');
      const flags = ajvStandalone ? ['--disallow-code-generation-from-strings'] : [];
      const result = await command(output, process.execPath, [...flags, 'verify-mapping.mjs']);
      assert.deepEqual(JSON.parse(result.stdout), { cat: true, dog: true, dogTagWithCatFields: false, unknownTag: false }, label);
    }
  });
}

test('discriminator mapping lowering matches branches by resolved schema, not by name', () => {
  const registry = {
    $id: 'urn:test:registry',
    $defs: { Cat: { type: 'object', required: ['bark'], properties: { bark: { type: 'boolean' } } } },
    components: {
      schemas: {
        Cat: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        Pet: {
          oneOf: [{ $ref: '#/$defs/Cat' }, { $ref: '#/components/schemas/Cat' }],
          discriminator: { propertyName: 'kind', mapping: { stray: '#/$defs/Cat', cat: '#/components/schemas/Cat' } },
        },
      },
    },
  };
  const lowered = lowerDiscriminatorMappings(registry);
  const branches = lowered.components.schemas.Pet.oneOf as readonly { readonly properties?: unknown }[];
  assert.deepEqual(branches.map((branch) => branch.properties), [{ kind: { const: 'stray' } }, { kind: { const: 'cat' } }]);
});

const dateDocument = {
  openapi: '3.1.0',
  info: { title: 'Dates', version: '1' },
  paths: {},
  components: {
    schemas: {
      PaymentBase: {
        type: 'object',
        required: ['id', 'createdAt'],
        properties: { id: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } },
      },
      CardPayment: {
        allOf: [
          { $ref: '#/components/schemas/PaymentBase' },
          { type: 'object', required: ['kind', 'maskedPan'], properties: { kind: { const: 'card' }, maskedPan: { type: 'string' } } },
        ],
      },
      BankPayment: {
        allOf: [
          { $ref: '#/components/schemas/PaymentBase' },
          { type: 'object', required: ['kind', 'reference'], properties: { kind: { const: 'bank' }, reference: { type: 'string' } } },
        ],
      },
      Payment: {
        oneOf: [{ $ref: '#/components/schemas/CardPayment' }, { $ref: '#/components/schemas/BankPayment' }],
        discriminator: { propertyName: 'kind', mapping: { card: '#/components/schemas/CardPayment', bank: '#/components/schemas/BankPayment' } },
      },
    },
  },
};

for (const ajvStandalone of [false, true]) {
  test(`inherited date fields decode and validate in allOf variants and their union (ajvStandalone=${ajvStandalone})`, async (t) => {
    const output = path.join(createFixtureProject(t, 'runic-openapi-variant-dates-'), 'sdk');
    await generateMaterializedSdk(dateDocument, { output, name: 'Dates', profile: { mobx: false, validation: true, ajvStandalone } });
    compileGeneratedSdk(output, [], { strict: true });
    copyFixtureFile(output, 'openapi/standalone-discriminator/verify-dates.mjs', 'verify-dates.mjs');
    const flags = ajvStandalone ? ['--disallow-code-generation-from-strings'] : [];
    const result = await command(output, process.execPath, [...flags, 'verify-dates.mjs']);
    assert.deepEqual(JSON.parse(result.stdout), {
      base: true, variant: true, union: true, parseVariant: true, parseUnion: true,
      unionConstructs: true, validateVariant: true, validateUnion: true, nonObjectIsInput: true, rejectsBadDate: true,
    });
  });
}

test('discriminator mapping lowering reports a $ref alias cycle', () => {
  const registry = {
    components: {
      schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: { $ref: '#/components/schemas/A' },
        C: { type: 'object' },
        Pet: {
          oneOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/C' }],
          discriminator: { propertyName: 'kind', mapping: { a: '#/components/schemas/A', c: '#/components/schemas/C' } },
        },
      },
    },
  };
  assert.throws(() => lowerDiscriminatorMappings(registry), /cycle of \$ref aliases/);
});

test('component names that collide once escaped keep separate validators, not each other\'s schema', async (t) => {
  const body = (name: string) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${encodeURIComponent(name.replaceAll('~', '~0'))}` } } } });
  const document = {
    openapi: '3.1.0',
    info: { title: 'Collide', version: '1' },
    paths: {
      '/tilde': { post: { operationId: 'postTilde', requestBody: body('a~b'), responses: { 200: { description: 'ok' } } } },
      '/escaped': { post: { operationId: 'postEscaped', requestBody: body('a%7Eb'), responses: { 200: { description: 'ok' } } } },
    },
    components: {
      schemas: {
        'a~b': { type: 'object', required: ['tilde'], properties: { tilde: { type: 'string' } } },
        'a%7Eb': { type: 'object', required: ['escaped'], properties: { escaped: { type: 'string' } } },
      },
    },
  };
  for (const ajvStandalone of [false, true]) {
    const output = path.join(createFixtureProject(t, 'runic-openapi-urn-collision-'), 'sdk');
    writeGeneratedSdk(writeSdk, document, { output, name: 'Collide', profile: { mobx: false, validation: true, ajvStandalone } });
    compileGeneratedSdk(output);
    const module = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
      'collide client',
    );
    const Client = module.CollideClient;
    assert.equal(isGeneratedClientClass(Client), true);
    if (!isGeneratedClientClass(Client)) throw new TypeError('CollideClient');
    const client = new Client({
      baseUrl: 'https://api.example',
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await assert.doesNotReject(
      () => client.postTilde().execute({ body: { tilde: 'x' } }),
      `postTilde must validate its own body (requires "tilde") (ajvStandalone=${ajvStandalone})`,
    );
    await assert.rejects(
      () => client.postTilde().execute({ body: { escaped: 'x' } }),
      /validation failed/i,
      `postTilde must validate against its own schema (requires "tilde"), not "a%7Eb"'s (ajvStandalone=${ajvStandalone})`,
    );
    await assert.doesNotReject(
      () => client.postEscaped().execute({ body: { escaped: 'x' } }),
      `postEscaped must validate its own body (requires "escaped") (ajvStandalone=${ajvStandalone})`,
    );
    await assert.rejects(
      () => client.postEscaped().execute({ body: { tilde: 'x' } }),
      /validation failed/i,
      `postEscaped must validate against its own schema (requires "escaped"), not "a~b"'s (ajvStandalone=${ajvStandalone})`,
    );
  }
});
