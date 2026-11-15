import assert from 'node:assert/strict';
import test from 'node:test';
import { followReference, MAX_REFERENCE_HOPS, resolveFragmentPointer, schemaReference } from '@exprtlabs/golem/internal/schema';

const chain = (length: number): Record<string, unknown> => {
  const table: Record<string, unknown> = { end: { type: 'string' } };
  for (let index = 0; index < length; index += 1) table[`r${index}`] = { $ref: index === length - 1 ? 'end' : `r${index + 1}` };
  return table;
};
const follow = (table: Record<string, unknown>, start: string) => followReference<unknown>({ $ref: start }, schemaReference, (reference) => table[reference]);

test('followReference ends at the first value that is no reference and names the last reference', () => {
  assert.deepEqual(follow(chain(3), 'r0'), { target: { type: 'string' }, reference: 'end' });
  assert.deepEqual(followReference<unknown>({ type: 'integer' }, schemaReference, () => undefined), { target: { type: 'integer' }, reference: undefined });
});

test('followReference gives undefined for a miss, a cycle and a chain of more hops than the limit', () => {
  assert.equal(follow({}, 'missing'), undefined);
  assert.equal(follow({ a: { $ref: 'b' }, b: { $ref: 'a' } }, 'a'), undefined);
  assert.notEqual(follow(chain(MAX_REFERENCE_HOPS - 1), 'r0'), undefined);
  assert.equal(follow(chain(MAX_REFERENCE_HOPS + 1), 'r0'), undefined);
});

test('resolveFragmentPointer decodes each token after splitting, so an encoded slash is part of a name, not a separator', () => {
  const document = { components: { 'a/b': { x: [10, 20] }, 'c d': 1 } };
  assert.equal(resolveFragmentPointer(document, '/components/a~1b/x/1'), 20);
  assert.equal(resolveFragmentPointer(document, '/components/c%20d'), 1);
  assert.deepEqual(resolveFragmentPointer(document, '/components/a%2Fb'), { x: [10, 20] });
  assert.equal(resolveFragmentPointer(document, '/components/a/b'), undefined);
  assert.equal(resolveFragmentPointer(document, '/constructor'), undefined);
});
