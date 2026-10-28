import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelTypeDescriptor, ModelValidationContext } from '@exprtlabs/golem/model';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { identifier } from '@exprtlabs/golem/internal/emitter';
import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import { emitCodecRuntimeText, instantiateRuntime } from './emitted-runtime.js';
import { compileValidationPlanBinding } from './support/compiled-validators.js';
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

test('a model whose wire schema equals its model schema is asked for as the wire plane on parse', async () => {
  // protects: T-640 one rule: every non-model plane is Id#plane, also when the wire schema equals the model schema
  const plain: ModelTypeDescriptor = { kind: 'object', properties: { name: { kind: 'string' } }, required: ['name'], additionalProperties: false };
  const graph = createSchemaGraph();
  const node = graph.intern(plain, 'Plain');
  graph.seal();
  assert.equal(node.sameSchema, true);
  const validators = await compileValidationPlanBinding(buildCodecValidationPlan([graph], [], {}, true));
  const runtime = instantiateRuntime(
    emitCodecRuntimeText(graph, { validatorName: (id) => identifier(validators.validatorName(id)) }),
    validators.scope,
  );
  const asked: string[] = [];
  // The context answers the wire key only; a context is authoritative, so any other key would throw.
  const context: ModelValidationContext = {
    resolve(reference) {
      asked.push(reference);
      return reference === `${node.codecId}#wire` ? (value) => (typeof (value as { name?: unknown }).name === 'string' ? [] : [{ code: 'type', expected: ['string'], message: 'Expected string', path: ['name'], source: 'serde', representation: 'wire' } as never]) : undefined;
    },
  };
  assert.deepEqual(runtime.fromWireFormatPlain({ name: 'a' }, { validationContext: context }), { name: 'a' });
  assert.deepEqual(asked, [`${node.codecId}#wire`]);
  assert.throws(() => runtime.fromWireFormatPlain({ name: 7 }, { validationContext: context }), /validation/i);
});
