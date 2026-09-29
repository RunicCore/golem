import assert from 'node:assert/strict';
import test from 'node:test';
import { createObjectCodec, objectCodecValidationReference, registerCodecSchemas, resolveModelValidationContextValidator } from '@exprtlabs/codegen/serde';

const impl = {
  stringify: () => '{}', parse: () => ({}), validate: Object.assign(() => true, { errors: null }), assert: (v: unknown) => v,
  toWireFormat: (v: unknown) => v, fromWireFormat: (v: unknown) => v,
};

test('references name the plane', () => {
  const codec = createObjectCodec('PlaneProbe', { ...impl, schema: { type: 'object' }, wireSchema: { type: 'object' }, modelOnlySchema: { properties: {} }, wireOnlySchema: { properties: {} } });
  assert.equal(objectCodecValidationReference(codec, 'model'), 'PlaneProbe');
  assert.equal(objectCodecValidationReference(codec, 'wire'), 'PlaneProbe#wire');
  assert.equal(objectCodecValidationReference(codec, 'model-only'), 'PlaneProbe#model-only');
  assert.equal(objectCodecValidationReference(codec, 'wire-only'), 'PlaneProbe#wire-only');
});

test('context resolve receives the reference and mode only, cached per (reference, mode)', () => {
  const calls: unknown[][] = [];
  const context = { resolve: (...args: unknown[]) => { calls.push(args); return Object.assign(() => true, { errors: null }); } };
  const a = resolveModelValidationContextValidator(context as never, 'X#model-only', 'first');
  assert.strictEqual(resolveModelValidationContextValidator(context as never, 'X#model-only', 'first'), a);
  resolveModelValidationContextValidator(context as never, 'X#model-only', 'all');
  resolveModelValidationContextValidator(context as never, 'X', 'first');
  assert.deepEqual(calls, [['X#model-only', 'first'], ['X#model-only', 'all'], ['X', 'first']]);
});

test('registerCodecSchemas writes every schema a codec has, and referenced codecs once', () => {
  createObjectCodec('PlaneChild', { ...impl, schema: { type: 'object' }, modelOnlySchema: { properties: {} } });
  createObjectCodec('PlaneParent', { ...impl, schema: { type: 'object' }, wireSchema: { type: 'object' },
    modelOnlySchema: { properties: { c: { $ref: 'PlaneChild#model-only' } } } });
  const written: string[] = [];
  registerCodecSchemas((_schema, id) => written.push(id), 'PlaneParent');
  assert.deepEqual(written.sort(), ['PlaneChild', 'PlaneChild#model-only', 'PlaneParent', 'PlaneParent#model-only', 'PlaneParent#wire'].sort());
});
