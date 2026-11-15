import assert from 'node:assert/strict';
import test from 'node:test';

import { stripForDecode, stripForEncode } from '@exprtlabs/golem/internal/model-runtime';
import { identifier, render } from '#golem/code';
import type { SchemaNode } from '#golem/schema-graph';
import { StripPlans, type StripPlanEnv } from '#golem/strip-plan';

/** The plan of a descriptor as a generated module writes it, read back as data. Only a descriptor with no reference needs no more of the environment. */
function planOf(descriptor: SchemaNode['descriptor']): Parameters<typeof stripForDecode>[1] {
  const env: Pick<StripPlanEnv, 'extraValues' | 'classOf'> = { extraValues: () => undefined, classOf: () => undefined };
  const plan = new StripPlans(env as StripPlanEnv).ofNode({ id: 'node', descriptor } as SchemaNode);
  assert.ok(plan, 'the descriptor holds a closed object');
  return new Function(`return ${render(plan)};`)() as Parameters<typeof stripForDecode>[1];
}

test('the plan of a closed object that declares a field called __proto__ strips the object that field holds', () => {
  // protects: T-896 an object literal takes `__proto__` as the prototype, so the plan writes the field as a computed key and the walk reads it as an own property
  const closed = { kind: 'object', properties: { title: { kind: 'string' } }, required: ['title'], additionalProperties: false };
  // A schema that a model does not generate may still hold the name, and JSON.parse makes it an own key.
  const properties = JSON.parse('{"__proto__": null}') as Record<string, unknown>;
  properties['__proto__'] = closed;
  assert.deepEqual(Object.keys(properties), ['__proto__']);
  const plan = planOf({ kind: 'object', properties, required: [], additionalProperties: false } as unknown as SchemaNode['descriptor']);
  const wire = JSON.parse('{"__proto__": {"title": "a", "extra": 1}, "junk": 1}') as object;
  const stripped = stripForDecode(wire, plan, { maxDepth: undefined, bound: false });
  assert.equal(JSON.stringify(stripped), '{"__proto__":{"title":"a"}}');
  assert.equal(JSON.stringify(stripForEncode(wire, plan, { maxDepth: undefined, bound: false })), '{"__proto__":{"title":"a"}}', 'an encode strips it the same way');
});

test('a union whose tagged variant takes arrays does not give its arrays to the plan of another array variant', () => {
  // protects: T-896 two variants that can take an array make exact matching, so no plan of one of them may strip an array
  const closed = (name: string) => ({ kind: 'object', properties: { [name]: { kind: 'string' } }, required: [name], additionalProperties: false });
  const arrayOf = (name: string) => ({ kind: 'array', item: closed(name) });
  // An open variant has no plan, so the plan holds no generic map that `new Function` cannot read.
  const cat = { kind: 'object', properties: { kind: { kind: 'string' } }, required: ['kind'] };
  const tagged = { kind: 'union', variants: [cat, arrayOf('a')], discriminator: { propertyName: 'kind', variants: [{ values: ['cat'] }, { values: [] }] } };
  const plan = planOf({ kind: 'union', variants: [tagged, arrayOf('b')] } as unknown as SchemaNode['descriptor']);
  const items = [{ a: 'x', extra: 1 }];
  assert.deepEqual(stripForDecode(items, plan, { maxDepth: undefined, bound: false }), items);
  assert.deepEqual(stripForEncode(items, plan, { maxDepth: undefined, bound: false }), items);
});

test('a union of an array node of another module and a closed object gets the plan of the array and the plan of the object', () => {
  // protects: T-896 an array node of another module is an array leaf: read as an object it makes two objects and no array, the union gets no plan, and nothing is stripped
  const closed = (properties: Record<string, unknown>, required: string[]) => ({ kind: 'object', properties, required, additionalProperties: false });
  const treeDescriptor = { kind: 'array', item: closed({ label: { kind: 'string' } }, ['label']) } as unknown as SchemaNode['descriptor'];
  const tree = { id: 'Tree', descriptor: treeDescriptor } as SchemaNode;
  const env = {
    extraValues: () => undefined,
    classOf: () => undefined,
    nodeOf: () => tree,
    external: () => true,
    importedPlan: () => identifier('treePlan'),
  } as unknown as StripPlanEnv;
  const union = { kind: 'union', variants: [{ kind: 'reference', name: 'Tree' }, closed({ code: { kind: 'string' } }, ['code'])] };
  const plan = new StripPlans(env).ofNode({ id: 'holder', descriptor: union } as unknown as SchemaNode);
  assert.ok(plan, 'the union holds an array and a closed object');
  const holder = new Function('treePlan', `return ${render(plan)};`)(planOf(treeDescriptor)) as Parameters<typeof stripForDecode>[1];
  assert.deepEqual(stripForDecode([{ label: 'a', extra: 1 }], holder, { maxDepth: undefined, bound: false }), [{ label: 'a' }]);
  assert.deepEqual(stripForDecode({ code: 'c', extra: 1 }, holder, { maxDepth: undefined, bound: false }), { code: 'c' });
});

test('a union of a scalar node of another module and a closed object gets the plan of the object', () => {
  // protects: T-896 a scalar node of another module is no object: read as one it makes two objects, the union gets no plan, and the extra key of the object stays
  const code = { kind: 'object', properties: { code: { kind: 'string' } }, required: ['code'], additionalProperties: false };
  const scalar = { id: 'Scalar', descriptor: { kind: 'string' } } as SchemaNode;
  const env = {
    extraValues: () => undefined,
    classOf: () => undefined,
    nodeOf: () => scalar,
    external: () => true,
    importedPlan: () => undefined,
  } as unknown as StripPlanEnv;
  const union = { kind: 'union', variants: [{ kind: 'reference', name: 'Scalar' }, code] };
  const plan = new StripPlans(env).ofNode({ id: 'holder', descriptor: union } as unknown as SchemaNode);
  assert.ok(plan, 'the union holds one closed object');
  const holder = new Function(`return ${render(plan)};`)() as Parameters<typeof stripForDecode>[1];
  assert.deepEqual(stripForDecode({ code: 'c', extra: 1 }, holder, { maxDepth: undefined, bound: false }), { code: 'c' });
});

test('a union of an SDK array node and a closed object gets the plan of the array and the plan of the object', () => {
  // protects: T-905 an SDK node is a placeholder in the app graph: read as a model it makes two objects and no array, the union gets no plan, and nothing is stripped
  const closed = (properties: Record<string, unknown>, required: string[]) => ({ kind: 'object', properties, required, additionalProperties: false });
  const itemsDescriptor = { kind: 'array', item: closed({ label: { kind: 'string' } }, ['label']) } as unknown as SchemaNode['descriptor'];
  const placeholder = { id: 'Items', descriptor: { kind: 'generated-model', id: 'Items' } } as unknown as SchemaNode;
  const env = {
    extraValues: () => undefined,
    classOf: () => undefined,
    nodeOf: () => placeholder,
    external: () => true,
    holdsSequence: () => true,
    importedPlan: () => identifier('itemsPlan'),
  } as unknown as StripPlanEnv;
  const union = { kind: 'union', variants: [{ kind: 'generated-model', id: 'Items' }, closed({ code: { kind: 'string' } }, ['code'])] };
  const plan = new StripPlans(env).ofNode({ id: 'holder', descriptor: union } as unknown as SchemaNode);
  assert.ok(plan, 'the union holds an array and a closed object');
  const holder = new Function('itemsPlan', `return ${render(plan)};`)(planOf(itemsDescriptor)) as Parameters<typeof stripForDecode>[1];
  assert.deepEqual(stripForDecode([{ label: 'a', extra: 1 }], holder, { maxDepth: undefined, bound: false }), [{ label: 'a' }]);
  assert.deepEqual(stripForDecode({ code: 'c', extra: 1 }, holder, { maxDepth: undefined, bound: false }), { code: 'c' });
});
