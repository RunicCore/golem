import assert from 'node:assert/strict';
import test from 'node:test';
import { followReference, MAX_REFERENCE_HOPS, resolveFragmentPointer, schemaReference } from '@exprtlabs/golem/internal/schema';

/** `{ $ref: 'r0' }` then `r0 -> r1 -> ... -> end`: a `follow` of `r0` takes `length + 1` hops. */
const chain = (length: number): Record<string, unknown> => {
  const table: Record<string, unknown> = { end: { type: 'string' } };
  for (let index = 0; index < length; index += 1) table[`r${index}`] = { $ref: index === length - 1 ? 'end' : `r${index + 1}` };
  return table;
};
const follow = (table: Record<string, unknown>, start: string) => followReference<unknown>({ $ref: start }, schemaReference, (reference) => table[reference]);

test('followReference ends at the first value that is no reference and names the last reference', () => {
  assert.deepEqual(follow(chain(3), 'r0'), { kind: 'found', target: { type: 'string' }, reference: 'end' });
  assert.deepEqual(followReference<unknown>({ type: 'integer' }, schemaReference, () => undefined), { kind: 'found', target: { type: 'integer' }, reference: undefined });
});

test('followReference tells a miss, which keeps the last reference, from a cycle', () => {
  assert.deepEqual(follow({ a: { $ref: 'gone' } }, 'a'), { kind: 'miss', last: { $ref: 'gone' } });
  assert.deepEqual(follow({}, 'missing'), { kind: 'miss', last: { $ref: 'missing' } });
  assert.deepEqual(follow({ a: { $ref: 'b' }, b: { $ref: 'a' } }, 'a'), { kind: 'cycle' });
});

test('followReference follows a chain of exactly the limit of hops and stops at one more', () => {
  assert.equal(follow(chain(MAX_REFERENCE_HOPS - 1), 'r0').kind, 'found');
  assert.equal(follow(chain(MAX_REFERENCE_HOPS), 'r0').kind, 'cycle');
});

test('resolveFragmentPointer decodes the fragment first (RFC 6901 section 6), so %2F separates and ~1 is the only escape for a slash', () => {
  const document = { components: { 'a/b': { x: [10, 20] }, 'c d': 1, a: { b: 'nested' } } };
  assert.equal(resolveFragmentPointer(document, '/components/a~1b/x/1'), 20);
  assert.equal(resolveFragmentPointer(document, '/components/c%20d'), 1);
  assert.equal(resolveFragmentPointer(document, '/components/a%2Fb'), 'nested');
  assert.equal(resolveFragmentPointer(document, '/components/a%7E1b/x/0'), 10);
  assert.equal(resolveFragmentPointer(document, '/constructor'), undefined);
});

test('resolveFragmentPointer reads an array only by a canonical index', () => {
  const document = { a: [10, 20] };
  assert.equal(resolveFragmentPointer(document, '/a/1'), 20);
  assert.equal(resolveFragmentPointer(document, '/a/length'), undefined);
  assert.equal(resolveFragmentPointer(document, '/a/01'), undefined);
  assert.equal(resolveFragmentPointer(document, '/a/2'), undefined);
});
