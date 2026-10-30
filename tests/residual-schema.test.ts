import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_CLASS_KEYWORD, schemaForDescriptor, VALIDATION_KEYWORD } from '#golem/schema';
import { DATE_FIELD } from './support/date-field.js';

const str = { kind: 'string' };
const num = { kind: 'number' };
const date = DATE_FIELD;
const FINITE_TIME = {
  id: '@exprtlabs/golem/internal/validation-runtime#hasFiniteTime',
  module: '@exprtlabs/golem/internal/validation-runtime',
  exportName: 'hasFiniteTime',
  specifier: '@exprtlabs/golem/internal/validation-runtime',
};
const DATE_INSTANCE = { [MODEL_CLASS_KEYWORD]: { name: 'Date', path: ['Date'], valid: FINITE_TIME } };
const DATE_TEXT = { allOf: [{ type: 'string' }, { format: 'date-time' }] };
const withRule = (d: object, id = 'src/rules.ts:1:2') => ({ ...d, validations: [id] });
const hex = { kind: 'number', serde: { wireDescriptor: { kind: 'string', constraints: [{ kind: 'pattern', value: '^[0-9a-f]+$' }] } }, constraints: [{ kind: 'minimum', value: 0 }] };
const obj = (properties: Record<string, object>, extra: object = {}) => ({ kind: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...extra });
const opts = (representation: 'model-only' | 'wire-only', residual = { modelOnly: new Set<string>(), wireOnly: new Set<string>() }) =>
  ({ representation, executableBindings: true, residualReferences: residual }) as const;

test('unconverted leaves leave nothing to check in either direction', () => {
  assert.equal(schemaForDescriptor(obj({ a: str, b: { ...num, constraints: [{ kind: 'minimum', value: 1 }] } }), opts('model-only')), true);
  assert.equal(schemaForDescriptor(obj({ a: str }), opts('wire-only')), true);
});

test('a TValidation on an unconverted leaf is model-only, never wire-only', () => {
  assert.deepEqual(schemaForDescriptor(obj({ note: withRule(str) }), opts('model-only')),
    { properties: { note: { [VALIDATION_KEYWORD]: { schema: true, bindings: ['src/rules.ts:1:2'] } } } });
  assert.equal(schemaForDescriptor(obj({ note: withRule(str) }), opts('wire-only')), true);
});

test('dates: model-only checks the Date, wire-only checks the ISO string', () => {
  // protects: T-725 an invalid Date is rejected in the model-only plane: the binding's validity function stays in the check
  assert.deepEqual(schemaForDescriptor(obj({ when: date }), opts('model-only')), { properties: { when: DATE_INSTANCE } });
  assert.deepEqual(schemaForDescriptor(obj({ when: date }), opts('wire-only')), { properties: { when: DATE_TEXT } });
});

test('TSerde: model-only is the decoded value schema, wire-only the decoder parameter schema', () => {
  assert.deepEqual(schemaForDescriptor(obj({ code: hex }), opts('model-only')), { properties: { code: { allOf: [{ type: 'number' }, { minimum: 0 }] } } });
  assert.deepEqual(schemaForDescriptor(obj({ code: hex }), opts('wire-only')), { properties: { code: { allOf: [{ type: 'string' }, { pattern: '^[0-9a-f]+$' }] } } });
});

test('residual objects carry no required list and no exactness; arrays recurse', () => {
  const schema = schemaForDescriptor(obj({ items: { kind: 'array', item: obj({ at: date, sku: str }) } }), opts('model-only'));
  assert.deepEqual(schema, { properties: { items: { items: { properties: { at: DATE_INSTANCE } } } } });
});

test('a union containing a converted field falls back to the full plane schema; a plain union is true', () => {
  const union = { kind: 'union', variants: [obj({ kind: { kind: 'literal', value: 'open' } }), obj({ kind: { kind: 'literal', value: 'hold' }, until: date })], discriminator: { propertyName: 'kind', variants: [{ values: ['open'] }, { values: ['hold'] }] } };
  const modelOnly = schemaForDescriptor(obj({ channel: union }), opts('model-only')) as { properties: { channel: object } };
  assert.deepEqual(modelOnly.properties.channel, schemaForDescriptor(union, { representation: 'model', executableBindings: true }));
  const plain = { kind: 'union', variants: [{ kind: 'literal', value: 'a' }, { kind: 'literal', value: 'b' }] };
  assert.equal(schemaForDescriptor(obj({ tag: plain }), opts('model-only')), true);
});

test('references use the residual id only when that model has one', () => {
  const definitions = { Child: obj({ at: date }), Plain: obj({ a: str }) };
  const residual = { modelOnly: new Set(['Child']), wireOnly: new Set(['Child']) };
  const parent = obj({ child: { kind: 'reference', name: 'Child' }, plain: { kind: 'reference', name: 'Plain' } });
  const schema = schemaForDescriptor(parent, { ...opts('model-only', residual), definitions, referencePrefix: 'ref:' });
  assert.deepEqual(schema, { properties: { child: { $ref: 'ref:Child#model-only' } } });
});

test('an object-level TValidation wraps the model-only residual', () => {
  const schema = schemaForDescriptor(withRule(obj({ a: str })), opts('model-only'));
  assert.deepEqual(schema, { [VALIDATION_KEYWORD]: { schema: true, bindings: ['src/rules.ts:1:2'] } });
});

import { createSchemaGraph } from '#golem/schema-graph';

test('graph nodes get residual schemas only when something is left to check', () => {
  const graph = createSchemaGraph({
    Stamp: { kind: 'object', properties: { at: date }, required: ['at'], additionalProperties: false },
    Plain: { kind: 'object', properties: { a: { kind: 'string' } }, required: ['a'], additionalProperties: false },
    Tree: { kind: 'object', properties: { at: date, children: { kind: 'array', item: { kind: 'reference', name: 'Tree' } } }, required: ['at', 'children'], additionalProperties: false },
  } as never);
  graph.seal();
  const node = (name: string) => [...graph.nodes.values()].find(n => n.name === name)!;
  assert.ok(node('Stamp').modelOnlyJsonSchema && node('Stamp').wireOnlyJsonSchema);
  assert.equal(node('Plain').sameSchema, true);
  assert.equal(node('Plain').modelOnlyJsonSchema, undefined);
  const tree = JSON.stringify(node('Tree').modelOnlyJsonSchema);
  assert.match(tree, /#model-only/, 'recursive model references its own residual schema');
});

test('optional and nullable converted fields use their own residual, not the union fallback', () => {
  const optional = { kind: 'union', variants: [date, { kind: 'undefined' }] };
  assert.deepEqual(schemaForDescriptor(obj({ when: optional }), opts('model-only')), { properties: { when: DATE_INSTANCE } });
  const nullable = { kind: 'union', variants: [{ kind: 'null' }, date] };
  assert.deepEqual(schemaForDescriptor(obj({ hold: nullable }), opts('wire-only')),
    { properties: { hold: { anyOf: [{ type: 'null' }, DATE_TEXT] } } });
});
