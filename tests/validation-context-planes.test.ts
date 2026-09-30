import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelValidationContext } from '@exprtlabs/codegen/model';
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

test('context and engine resolution cache each reference and mode independently', () => {
  const accept = (_input: unknown): boolean => true;
  Object.defineProperty(accept, 'errors', { value: [] });
  const lookups: string[] = [];
  const context: ModelValidationContext = {
    resolve(reference, mode) {
      lookups.push(`${reference}|${mode}`);
      return accept;
    },
  };
  resolveModelValidationContextValidator(context, 'shared-ref', 'first');
  resolveModelValidationContextValidator(context, 'shared-ref#wire', 'first');
  resolveModelValidationContextValidator(context, 'shared-ref', 'all');
  resolveModelValidationContextValidator(context, 'shared-ref', 'first');
  assert.deepEqual(lookups, ['shared-ref|first', 'shared-ref#wire|first', 'shared-ref|all'], 'context resolution is reused separately for each reference and mode');

  const engineLookups: string[] = [];
  const engineContext: ModelValidationContext = {
    engine: {
      addSchema() {},
      getSchema(reference) {
        engineLookups.push(reference);
        return accept;
      },
    },
  };
  const engineModelFirst = resolveModelValidationContextValidator(engineContext, 'engine-ref', 'first');
  const engineModelAll = resolveModelValidationContextValidator(engineContext, 'engine-ref', 'all');
  const engineWireFirst = resolveModelValidationContextValidator(engineContext, 'engine-ref#wire', 'first');
  const engineWireAll = resolveModelValidationContextValidator(engineContext, 'engine-ref#wire', 'all');
  assert.strictEqual(engineModelFirst, accept, 'the engine owns its error-mode behavior');
  assert.strictEqual(resolveModelValidationContextValidator(engineContext, 'engine-ref', 'first'), engineModelFirst);
  assert.strictEqual(resolveModelValidationContextValidator(engineContext, 'engine-ref', 'all'), engineModelAll);
  assert.strictEqual(resolveModelValidationContextValidator(engineContext, 'engine-ref#wire', 'first'), engineWireFirst);
  assert.strictEqual(resolveModelValidationContextValidator(engineContext, 'engine-ref#wire', 'all'), engineWireAll);
  assert.deepEqual(engineLookups, ['engine-ref', 'engine-ref', 'engine-ref#wire', 'engine-ref#wire'], 'engine contexts cache each reference and mode independently');

  let secondEngineLookups = 0;
  const secondEngineValidator = (_input: unknown): boolean => false;
  const secondEngineContext: ModelValidationContext = {
    engine: {
      addSchema() {},
      getSchema() {
        secondEngineLookups++;
        return secondEngineValidator;
      },
    },
  };
  assert.strictEqual(resolveModelValidationContextValidator(secondEngineContext, 'engine-ref', 'first'), secondEngineValidator);
  assert.equal(secondEngineLookups, 1, 'a separate context owns an independent engine cache for the same reference');
});
