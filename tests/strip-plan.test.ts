import assert from 'node:assert/strict';
import test from 'node:test';

import { stripUndeclared } from '@exprtlabs/golem/internal/model-runtime';
import { identifier, render } from '#golem/code';
import type { SchemaNode } from '#golem/schema-graph';
import { StripPlans, type StripPlanEnv } from '#golem/strip-plan';

/** The plan of a descriptor as a generated module writes it, read back as data. Only a descriptor with no reference needs no more of the environment. */
function planOf(descriptor: SchemaNode['descriptor']): Parameters<typeof stripUndeclared>[1] {
  const env: Pick<StripPlanEnv, 'extraValues' | 'classOf'> = { extraValues: () => undefined, classOf: () => undefined };
  const plan = new StripPlans(env as StripPlanEnv).ofNode({ id: 'node', descriptor } as SchemaNode);
  assert.ok(plan, 'the descriptor holds a closed object');
  return new Function(`return ${render(plan)};`)() as Parameters<typeof stripUndeclared>[1];
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
  const stripped = stripUndeclared(wire, plan);
  assert.equal(JSON.stringify(stripped), '{"__proto__":{"title":"a"}}');
  assert.equal(JSON.stringify(stripUndeclared(wire, plan, undefined, true)), '{"__proto__":{"title":"a"}}', 'an encode strips it the same way');
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
  assert.deepEqual(stripUndeclared(items, plan), items);
  assert.deepEqual(stripUndeclared(items, plan, undefined, true), items);
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
  const holder = new Function('treePlan', `return ${render(plan)};`)(planOf(treeDescriptor)) as Parameters<typeof stripUndeclared>[1];
  assert.deepEqual(stripUndeclared([{ label: 'a', extra: 1 }], holder), [{ label: 'a' }]);
  assert.deepEqual(stripUndeclared({ code: 'c', extra: 1 }, holder), { code: 'c' });
});
