import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { writeSdk } from '#openapi/generator';
import {
  compileStrictUnusedSdk,
  documentBase,
  generateMaterializedSdk,
  requireRecord,
  sdkBodyCodec,
  withRootOperations,
  writeGeneratedSdk,
} from './helpers.js';

test('quotes wire keys in the types and converts a quoted wire key through the client', async (t) => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-r6-quote-'), 'sdk');
  const result = await generateMaterializedSdk(withRootOperations(documentBase('3.1.0', {
    components: {
      schemas: {
        Payment: {
          type: 'object',
          properties: {
            'wired-key': { type: 'string' },
            'wired-at': { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }), 'Payment'), { output, name: 'Quoted', profile: { validation: false } });
  compileStrictUnusedSdk(output);
  const types = result.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
  assert.match(types, /"wired-key"\?: string/);

  const payment = await sdkBodyCodec(output, 'Quoted', 'Payment');
  const decoded = await payment.decode({ 'wired-key': 'k', 'wired-at': '2024-05-06T07:08:09.000Z' });
  assert.deepEqual(decoded, { 'wired-key': 'k', 'wired-at': new Date('2024-05-06T07:08:09.000Z') });
  assert.deepEqual(await payment.encode(decoded), { 'wired-key': 'k', 'wired-at': '2024-05-06T07:08:09.000Z' });
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
      () => writeGeneratedSdk(writeSdk, document, { output: path.join(output, String(index)), profile: { validation: false } }),
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
    }, { output: path.join(output, 'validation-enabled'), profile: { validation: true } }),
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
  }, { output: path.join(output, 'metadata'), profile: { validation: false } }));
});

for (const validation of [false, true]) {
  test(`a field named like a runtime export keeps the SDK compiling with unused names rejected and decoding (validation ${validation})`, async t => {
    // protects: SC-3 the unused-import fault, a field named parseJson or beginDecode kept the runtime import because pruning counted the field name as a use
    const output = path.join(createFixtureProject(t, 'golem-openapi-runtime-names-'), 'sdk');
    await generateMaterializedSdk(withRootOperations(documentBase('3.1.0', {
      components: {
        schemas: {
          Echo: {
            type: 'object',
            required: ['parseJson'],
            properties: {
              parseJson: { type: 'string' },
              beginDecode: { type: 'string' },
              registerIModelClass: { type: 'string' },
              at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }), 'Echo'), { output, name: 'RuntimeNames', profile: { validation } });
    compileStrictUnusedSdk(output);
    const echo = await sdkBodyCodec(output, 'RuntimeNames', 'Echo');
    const wire = { parseJson: 'a', beginDecode: 'b', registerIModelClass: 'c', at: '2024-05-06T07:08:09.000Z' };
    const decoded = await echo.decode(wire);
    assert.deepEqual(decoded, { ...wire, at: new Date(wire.at) });
    assert.deepEqual(await echo.encode(decoded), wire);
  });
}

for (const validation of [false, true]) {
  test(`an operation and fields named like the locals of generated code generate, compile and decode (validation ${validation})`, async t => {
    // protects: T-643 R-59 a document name never takes the form of a local ($v, $k): the name allocator adds a suffix
    const output = path.join(createFixtureProject(t, 'golem-openapi-local-names-'), 'sdk');
    const item = { type: 'object', required: ['$k', '$v0'], properties: { $k: { type: 'string' }, $v0: { type: 'string' }, when: { type: 'string', format: 'date-time' } } };
    await generateMaterializedSdk(withRootOperations(documentBase('3.1.0', {
      paths: { '/ping': { get: { operationId: '$v', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Holder' } } } } } } } },
      components: { schemas: { Holder: { type: 'object', required: ['item', 'items'], properties: { item: item, items: { type: 'array', items: item } } } } },
    }), 'Holder'), { output, name: 'LocalNames', profile: { validation } });
    compileStrictUnusedSdk(output);
    const holder = await sdkBodyCodec(output, 'LocalNames', 'Holder');
    const wire = { item: { $k: 'a', $v0: 'b', when: '2024-05-06T07:08:09.000Z' }, items: [{ $k: 'c', $v0: 'd', when: '2024-05-06T07:08:09.000Z' }] };
    const decoded = requireRecord(await holder.decode(wire), 'holder');
    assert.ok(requireRecord(decoded.item, 'item').when instanceof Date);
    assert.deepEqual(await holder.encode(decoded), wire);
    const written = fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.startsWith('dist') && !file.startsWith('node_modules'));
    assert.match(written.map(file => fs.readFileSync(path.join(output, file), 'utf8')).join('\n'), /\$v_/);
  });
}
