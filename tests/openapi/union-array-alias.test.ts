import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, sdkBodyCodec, withRootOperations } from './helpers.js';
import { dateTime, ref } from './schema-builders.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

// A component that is an array and reaches itself is a named node of the SDK, not written inline into the schemas that use it.
// A union that holds such a node beside another array must still tell which variant takes an array value (F-39: golem rejects bad
// input, never coerces it). The tests below use closed objects, so a value converted by the wrong variant loses its keys.

const closed = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, required, properties });

/**
 * `Tree` is an array of nodes that hold a label, `extra` fields and the array again; `Holder` holds a `oneOf` of `Tree` and `other`,
 * and a date, so the value of `Holder` converts and its decoder reads the union.
 */
function treeDocument(extra: Record<string, unknown>, other: Record<string, unknown>): Record<string, unknown> {
  return withRootOperations({
    openapi: '3.1.0',
    info: { title: 'UnionArrayAlias', version: '1' },
    paths: {},
    components: {
      schemas: {
        Tree: { type: 'array', items: closed({ label: { type: 'string' }, ...extra, children: ref('Tree') }, ['label', ...Object.keys(extra)]) },
        Holder: closed({ when: dateTime, holder: { oneOf: [ref('Tree'), other] } }, ['when', 'holder']),
      },
    },
  }, 'Holder');
}

const codeItems = { type: 'array', items: closed({ code: { type: 'string' } }, ['code']) };

for (const [what, extra] of [['plain', {}], ['whose items hold a date', { at: dateTime }]] as const) {
  test(`a union of a recursive array ${what} and an inline array stops generation with an ambiguous conversion`, async t => {
    // protects: T-905 the Tree was classed as an object, so the union converted each array value by the keys of the inline array
    const output = path.join(createFixtureProject(t, 'golem-openapi-union-array-ambiguous-'), 'sdk');
    await assert.rejects(
      () => generateMaterializedSdk(treeDocument(extra, codeItems), { output, name: 'UnionArrayAmbiguous', profile: { validation: true } }),
      /Union has ambiguous conversions\. Use a discriminated object union or one serde pair for the value\./,
    );
  });
}

test('a union of a recursive array whose items hold a date and a string decodes the dates of the array and keeps the string', async t => {
  // protects: T-905 an array value was no object for the union, so the Tree took the string branch and its dates stayed strings
  const output = path.join(createFixtureProject(t, 'golem-openapi-union-array-string-'), 'sdk');
  await generateMaterializedSdk(treeDocument({ at: dateTime }, { type: 'string' }), { output, name: 'UnionArrayString', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, noUnusedLocals: true });
  const holder = await sdkBodyCodec(output, 'UnionArrayString', 'Holder');

  const instant = '2025-01-02T03:04:05.000Z';
  const wire = { when: instant, holder: [{ label: 'a', at: instant, children: [{ label: 'b', at: instant, children: [] }] }] };
  const decoded = await holder.decode(wire);
  assert.deepEqual(decoded, { when: new Date(instant), holder: [{ label: 'a', at: new Date(instant), children: [{ label: 'b', at: new Date(instant), children: [] }] }] });
  assert.deepEqual(await holder.encode(decoded), wire);
  assert.deepEqual(await holder.decode({ when: instant, holder: 'text' }), { when: new Date(instant), holder: 'text' });
});
