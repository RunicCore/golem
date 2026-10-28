import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelValidationContext } from '@exprtlabs/golem/model';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { createObjectCodec, objectCodecValidationReference, resolveModelValidationContextValidator } from '@exprtlabs/golem/serde';

const impl = {
  stringify: () => '{}', parse: () => ({}), validate: () => true, assert: (v: unknown) => v,
  toWireFormat: (v: unknown) => v, fromWireFormat: (v: unknown) => v,
};

test('references name the plane', () => {
  const codec = createObjectCodec('PlaneProbe', impl);
  assert.equal(objectCodecValidationReference(codec, 'model'), 'PlaneProbe');
  assert.equal(objectCodecValidationReference(codec, 'wire'), 'PlaneProbe#wire');
  assert.equal(objectCodecValidationReference(codec, 'model-only'), 'PlaneProbe#model-only');
  assert.equal(objectCodecValidationReference(codec, 'wire-only'), 'PlaneProbe#wire-only');
});

const accept: Validator = () => [];

test('context resolve receives the reference and mode only, cached per (reference, mode)', () => {
  const calls: unknown[][] = [];
  const context = { resolve: (...args: unknown[]) => { calls.push(args); return accept; } };
  const a = resolveModelValidationContextValidator(context as never, 'X#model-only', 'first');
  assert.strictEqual(resolveModelValidationContextValidator(context as never, 'X#model-only', 'first'), a);
  resolveModelValidationContextValidator(context as never, 'X#model-only', 'all');
  resolveModelValidationContextValidator(context as never, 'X', 'first');
  assert.deepEqual(calls, [['X#model-only', 'first'], ['X#model-only', 'all'], ['X', 'first']]);
});

test('context resolution caches each reference and mode independently', () => {
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
});
