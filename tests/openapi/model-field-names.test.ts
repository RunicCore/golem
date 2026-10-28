import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { generate, writeSdk } from '#openapi/generator';
import {
  assertGenerationRejected,
  compileStrictUnusedSdk,
  documentBase,
  generateMaterializedSdk,
  generatedModelSource,
  isGeneratedModelClass,
  requireRecord,
  writeGeneratedSdk,
  writeOpenApiDocument,
} from './helpers.js';

test('reserves generated model API members and quotes wire keys', async (t) => {
  // RESERVED_MODEL_MEMBERS has no profile input, so one profile covers the rejection.
  const directory = createFixtureProject(t, 'golem-openapi-r6-member-');
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    components: {
      schemas: {
        Payment: {
          type: 'object',
          properties: {
            toJSON: { type: 'string' },
          },
        },
      },
    },
  }));
  await assertGenerationRejected(input, /collides with generated model API member/);

  const quoted = createFixtureProject(t, 'golem-openapi-r6-quote-');
  const quotedInput = writeOpenApiDocument(quoted, documentBase('3.1.0', {
    components: {
      schemas: {
        Payment: {
          type: 'object',
          properties: {
            'wired-key': { type: 'string' },
          },
        },
      },
    },
  }));
  const result = await generate({
    input: quotedInput,
    output: path.join(quoted, 'sdk'),
    profile: { mobx: false, validation: false },
  });
  const types = result.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
  const models = generatedModelSource(result.artifacts);
  assert.match(types, /"wired-key"\?: string/);
  assert.match(models, /\["wired-key"\]/);
});

test('SDK generation rejects declared Object.prototype field names and directs callers to rename them', t => {
  const output = createFixtureProject(t, 'golem-openapi-field-names-');
  const cases: readonly { readonly name: string; readonly schema: Record<string, unknown> }[] = [
    {
      name: 'required __proto__',
      schema: { type: 'object', required: ['__proto__'], properties: Object.fromEntries([['__proto__', { type: 'string' }]]) },
    },
    {
      name: 'optional toString',
      schema: { type: 'object', properties: { toString: { type: 'string' } } },
    },
    {
      name: 'inherited constructor',
      schema: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { label: { type: 'string' } } }] },
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const schemas = scenario.name.includes('constructor')
      ? {
        Base: { type: 'object', properties: { constructor: { type: 'string' } } },
        Special: scenario.schema,
      }
      : { Special: scenario.schema };
    const document = {
      openapi: '3.1.0', info: { title: `Unsupported ${index}`, version: '1' },
      components: { schemas },
    };
    assert.throws(
      () => writeGeneratedSdk(writeSdk, document, { output: path.join(output, String(index)), profile: { mobx: false, validation: false } }),
      (error: unknown) => error instanceof Error
        && /Declared model field/.test(error.message)
        && /rename/.test(error.message)
        && (scenario.name.includes('__proto__') ? /__proto__/.test(error.message)
          : scenario.name.includes('toString') ? /toString/.test(error.message)
            : /constructor/.test(error.message)),
      scenario.name,
    );
  }
  assert.throws(
    () => writeGeneratedSdk(writeSdk, {
      openapi: '3.1.0', info: { title: 'Validation-enabled field', version: '1' },
      components: { schemas: { Special: { type: 'object', properties: { valueOf: { type: 'string' } } } } },
    }, { output: path.join(output, 'validation-enabled'), profile: { mobx: false, validation: true } }),
    (error: unknown) => error instanceof Error
      && /Declared model field/.test(error.message)
      && /"valueOf"/.test(error.message)
      && /rename/.test(error.message),
    'valueOf must be rejected during SDK generation when validation is enabled',
  );

  const literalPayload = Object.fromEntries([
    ['toString', 'literal'],
    ['constructor', 'literal'],
    ['__proto__', 'literal'],
  ]);
  assert.doesNotThrow(() => writeGeneratedSdk(writeSdk, {
    openapi: '3.1.0', info: { title: 'Metadata values', version: '1' },
    components: { schemas: { Metadata: {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          const: literalPayload,
          enum: [literalPayload],
          default: literalPayload,
        },
        entries: { type: 'object', additionalProperties: { type: 'object' } },
      },
    } } },
  }, { output: path.join(output, 'metadata'), profile: { mobx: false, validation: false } }));
});

for (const validation of [false, true]) {
  test(`a field named like a runtime export keeps the SDK compiling with unused names rejected and decoding (validation ${validation})`, async t => {
    // protects: SC-3 the unused-import fault, a field named parseJson or beginDecode kept the runtime import because pruning counted the field name as a use
    const output = path.join(createFixtureProject(t, 'golem-openapi-runtime-names-'), 'sdk');
    await generateMaterializedSdk(documentBase('3.1.0', {
      components: {
        schemas: {
          Echo: {
            type: 'object',
            required: ['parseJson'],
            properties: { parseJson: { type: 'string' }, beginDecode: { type: 'string' }, registerIModelClass: { type: 'string' } },
          },
        },
      },
    }), { output, name: 'RuntimeNames', profile: { mobx: false, validation } });
    compileStrictUnusedSdk(output);
    const EchoModel = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'runtime names SDK').EchoModel;
    assert.ok(isGeneratedModelClass(EchoModel));
    const wire = { parseJson: 'a', beginDecode: 'b', registerIModelClass: 'c' };
    const decoded = decodeGeneratedModel(EchoModel, wire);
    assert.deepEqual(encodeGeneratedModel(decoded), wire);
  });
}
