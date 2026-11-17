import assert from 'node:assert/strict';
import test from 'node:test';

import { stripForDecode, stripForEncode } from '@exprtlabs/golem/internal/model-runtime';
import { identifier, render } from '#golem/code';
import type { ModelTypeDescriptor } from '#golem/schema';
import { StripPlans } from '#golem/strip-plan';
import { closedObject, schemaNode, stripPlanEnv } from './support/schema-nodes.js';

/** The plan of a descriptor as a generated module writes it, read back as data. Only a descriptor with no reference needs no more of the environment. */
function planOf(descriptor: ModelTypeDescriptor): Parameters<typeof stripForDecode>[1] {
  const env = stripPlanEnv({ extraValues: () => undefined, classOf: () => undefined });
  const plan = new StripPlans(env).ofNode(schemaNode('node', descriptor));
  assert.ok(plan, 'the descriptor holds a closed object');
  return new Function(`return ${render(plan)};`)() as Parameters<typeof stripForDecode>[1];
}

test('the plan of a closed object that declares a field called __proto__ strips the object that field holds', () => {
  // protects: T-896 an object literal takes `__proto__` as the prototype, so the plan writes the field as a computed key and the walk reads it as an own property
  const closed = closedObject({ title: { kind: 'string' } });
  // A schema that a model does not generate may still hold the name, and `Object.fromEntries` makes it an own key where an object literal sets the prototype.
  const properties = Object.fromEntries<ModelTypeDescriptor>([['__proto__', closed]]);
  assert.deepEqual(Object.keys(properties), ['__proto__']);
  const plan = planOf(closedObject(properties, []));
  const wire = JSON.parse('{"__proto__": {"title": "a", "extra": 1}, "junk": 1}') as object;
  const stripped = stripForDecode(wire, plan, { maxDepth: undefined, bound: false });
  assert.equal(JSON.stringify(stripped), '{"__proto__":{"title":"a"}}');
  assert.equal(JSON.stringify(stripForEncode(wire, plan, { maxDepth: undefined, bound: false })), '{"__proto__":{"title":"a"}}', 'an encode strips it the same way');
});

test('a union whose tagged variant takes arrays does not give its arrays to the plan of another array variant', () => {
  // protects: T-896 two variants that can take an array make exact matching, so no plan of one of them may strip an array
  const arrayOf = (name: string): ModelTypeDescriptor => ({ kind: 'array', item: closedObject({ [name]: { kind: 'string' } }) });
  // An open variant has no plan, so the plan holds no generic map that `new Function` cannot read.
  const cat: ModelTypeDescriptor = { kind: 'object', properties: { kind: { kind: 'string' } }, required: ['kind'], additionalProperties: true };
  const tagged: ModelTypeDescriptor = { kind: 'union', variants: [cat, arrayOf('a')], discriminator: { propertyName: 'kind', variants: [{ values: ['cat'] }, { values: [] }] } };
  const plan = planOf({ kind: 'union', variants: [tagged, arrayOf('b')] });
  const items = [{ a: 'x', extra: 1 }];
  assert.deepEqual(stripForDecode(items, plan, { maxDepth: undefined, bound: false }), items);
  assert.deepEqual(stripForEncode(items, plan, { maxDepth: undefined, bound: false }), items);
});

test('a union of an array node of another module and a closed object gets the plan of the array and the plan of the object', () => {
  // protects: T-896 an array node of another module is an array leaf: read as an object it makes two objects and no array, the union gets no plan, and nothing is stripped
  const treeDescriptor: ModelTypeDescriptor = { kind: 'array', item: closedObject({ label: { kind: 'string' } }) };
  const tree = schemaNode('Tree', treeDescriptor);
  const env = stripPlanEnv({
    extraValues: () => undefined,
    classOf: () => undefined,
    nodeOf: () => tree,
    external: () => true,
    importedPlan: () => identifier('treePlan'),
  });
  const union: ModelTypeDescriptor = { kind: 'union', variants: [{ kind: 'reference', name: 'Tree' }, closedObject({ code: { kind: 'string' } })] };
  const plan = new StripPlans(env).ofNode(schemaNode('holder', union));
  assert.ok(plan, 'the union holds an array and a closed object');
  const holder = new Function('treePlan', `return ${render(plan)};`)(planOf(treeDescriptor)) as Parameters<typeof stripForDecode>[1];
  assert.deepEqual(stripForDecode([{ label: 'a', extra: 1 }], holder, { maxDepth: undefined, bound: false }), [{ label: 'a' }]);
  assert.deepEqual(stripForDecode({ code: 'c', extra: 1 }, holder, { maxDepth: undefined, bound: false }), { code: 'c' });
});

test('a union of a scalar node of another module and a closed object gets the plan of the object', () => {
  // protects: T-896 a scalar node of another module is no object: read as one it makes two objects, the union gets no plan, and the extra key of the object stays
  const scalar = schemaNode('Scalar', { kind: 'string' });
  const env = stripPlanEnv({
    extraValues: () => undefined,
    classOf: () => undefined,
    nodeOf: () => scalar,
    external: () => true,
    importedPlan: () => undefined,
  });
  const union: ModelTypeDescriptor = { kind: 'union', variants: [{ kind: 'reference', name: 'Scalar' }, closedObject({ code: { kind: 'string' } })] };
  const plan = new StripPlans(env).ofNode(schemaNode('holder', union));
  assert.ok(plan, 'the union holds one closed object');
  const holder = new Function(`return ${render(plan)};`)() as Parameters<typeof stripForDecode>[1];
  assert.deepEqual(stripForDecode({ code: 'c', extra: 1 }, holder, { maxDepth: undefined, bound: false }), { code: 'c' });
});

test('a union of an SDK array node and a closed object gets the plan of the array and the plan of the object', () => {
  // protects: T-905 an SDK node is a placeholder in the app graph: read as a model it makes two objects and no array, the union gets no plan, and nothing is stripped
  const itemsDescriptor: ModelTypeDescriptor = { kind: 'array', item: closedObject({ label: { kind: 'string' } }) };
  const placeholder = schemaNode('Items', { kind: 'generated-model', id: 'Items' });
  const env = stripPlanEnv({
    extraValues: () => undefined,
    classOf: () => undefined,
    nodeOf: () => placeholder,
    external: () => true,
    holdsSequence: () => true,
    importedPlan: () => identifier('itemsPlan'),
  });
  const union: ModelTypeDescriptor = { kind: 'union', variants: [{ kind: 'generated-model', id: 'Items' }, closedObject({ code: { kind: 'string' } })] };
  const plan = new StripPlans(env).ofNode(schemaNode('holder', union));
  assert.ok(plan, 'the union holds an array and a closed object');
  const holder = new Function('itemsPlan', `return ${render(plan)};`)(planOf(itemsDescriptor)) as Parameters<typeof stripForDecode>[1];
  assert.deepEqual(stripForDecode([{ label: 'a', extra: 1 }], holder, { maxDepth: undefined, bound: false }), [{ label: 'a' }]);
  assert.deepEqual(stripForDecode({ code: 'c', extra: 1 }, holder, { maxDepth: undefined, bound: false }), { code: 'c' });
});
