import assert from 'node:assert/strict';
import test from 'node:test';

import { stripUndeclared } from '@exprtlabs/golem/internal/model-runtime';
import { render } from '#golem/code';
import type { SchemaNode } from '#golem/schema-graph';
import { StripPlans, type StripPlanEnv } from '#golem/strip-plan';

/** The plan of a descriptor as a generated module writes it, read back as data. Only a descriptor with no reference needs no more of the environment. */
function planOf(descriptor: SchemaNode['descriptor']): Parameters<typeof stripUndeclared>[1] {
  const env: Pick<StripPlanEnv, 'extraValues'> = { extraValues: () => undefined };
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
