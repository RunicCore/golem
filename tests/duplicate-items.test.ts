import assert from 'node:assert/strict';
import test from 'node:test';

import { duplicateItems, jsonEqual } from '@exprtlabs/golem/internal/validation-runtime';
import { compileSchema } from './support/compiled-validators.js';

class Point {
  constructor(readonly x: number, readonly y: number) {}
}

const NAN_OBJECT = { n: Number.NaN };
const INVALID_DATE = new Date(Number.NaN);
const SHARED_FUNCTION = (): number => 1;
const SHARED_SYMBOL = Symbol('shared');

/** Lists with the pair a double loop over `jsonEqual` reports: the lowest first index with a later equal item, and the lowest later index. */
const ROWS: readonly { readonly name: string; readonly list: readonly unknown[]; readonly pair: readonly [number, number] | undefined }[] = [
  { name: 'a pair that closes the outer span wins over an inner pair found earlier', list: ['a', 'b', 'b', 'a'], pair: [0, 3] },
  { name: 'the lowest later index of the first repeated item', list: [1, 2, 1, 1], pair: [0, 2] },
  { name: 'the first of two inner pairs', list: [1, 2, 2, 3, 3], pair: [1, 2] },
  { name: 'a late pair for the lowest first index beats an earlier-found pair', list: [1, 2, 3, 2, 1], pair: [0, 4] },
  { name: 'no items', list: [], pair: undefined },
  { name: 'one item', list: ['a'], pair: undefined },
  { name: 'number and its text differ', list: [1, '1'], pair: undefined },
  { name: 'zero and negative zero are equal', list: [0, -0], pair: [0, 1] },
  { name: 'true and 1 differ', list: [true, 1], pair: undefined },
  { name: 'bigint 1 and number 1 differ', list: [1n, 1], pair: undefined },
  { name: 'equal bigints are equal', list: [1n, 1n], pair: [0, 1] },
  { name: 'empty text and null differ', list: ['', null], pair: undefined },
  { name: 'null and undefined are equal', list: [null, undefined], pair: [0, 1] },
  { name: 'a hole is null', list: [, null], pair: [0, 1] }, // eslint-disable-line no-sparse-arrays
  { name: 'two NaN are never equal', list: [Number.NaN, Number.NaN], pair: undefined },
  { name: 'objects equal in any key order', list: [{ a: 1, b: 2 }, { b: 2, a: 1 }], pair: [0, 1] },
  { name: 'a key with undefined is absent', list: [{ a: undefined }, {}], pair: [0, 1] },
  { name: 'a key with null is present', list: [{ a: null }, {}], pair: undefined },
  { name: 'an array and an object with the same members differ', list: [[1], { 0: 1 }], pair: undefined },
  { name: 'an empty array and an empty object differ', list: [[], {}], pair: undefined },
  { name: 'a text value and a number value differ', list: [{ a: '1' }, { a: 1 }], pair: undefined },
  { name: 'array items are not forged by a text that holds a separator', list: [['a', 'b'], ['a,s1:b']], pair: undefined },
  { name: 'object members are not forged by a text that holds a separator', list: [{ a: 'x', b: 'y' }, { a: 'x,1:b=s1:y' }], pair: undefined },
  { name: 'a text with quotes and a comma is one item', list: ['","', '",'], pair: undefined },
  { name: 'equal dates', list: [new Date(5), new Date(5)], pair: [0, 1] },
  { name: 'different dates', list: [new Date(5), new Date(6)], pair: undefined },
  { name: 'a date and an empty object differ', list: [new Date(5), {}], pair: undefined },
  { name: 'two invalid dates differ', list: [new Date(Number.NaN), new Date(Number.NaN)], pair: undefined },
  { name: 'the same invalid date twice is equal to itself', list: [INVALID_DATE, INVALID_DATE], pair: [0, 1] },
  { name: 'nested arrays and objects that are equal', list: [{ a: [1, { b: [null, 'x'] }] }, { a: [1, { b: [undefined, 'x'] }] }], pair: [0, 1] },
  { name: 'nested arrays and objects that differ deep inside', list: [{ a: [1, { b: [null, 'x'] }] }, { a: [1, { b: [null, 'y'] }] }], pair: undefined },
  { name: 'objects holding NaN are never equal', list: [{ n: Number.NaN }, { n: Number.NaN }], pair: undefined },
  { name: 'the same object holding NaN twice is equal to itself', list: [NAN_OBJECT, NAN_OBJECT], pair: [0, 1] },
  { name: 'two parents of one object that holds NaN are equal', list: [{ inner: NAN_OBJECT }, { inner: NAN_OBJECT }], pair: [0, 1] },
  { name: 'two parents of different objects that hold NaN differ', list: [{ inner: { n: Number.NaN } }, { inner: { n: Number.NaN } }], pair: undefined },
  { name: 'the same function twice is equal', list: [SHARED_FUNCTION, SHARED_FUNCTION], pair: [0, 1] },
  { name: 'two functions differ', list: [() => 1, () => 1], pair: undefined },
  { name: 'the same symbol twice is equal', list: [SHARED_SYMBOL, SHARED_SYMBOL], pair: [0, 1] },
  { name: 'two symbols with one name differ', list: [Symbol('a'), Symbol('a')], pair: undefined },
  { name: 'a class instance equals a plain object of its fields', list: [new Point(1, 2), { x: 1, y: 2 }], pair: [0, 1] },
];

for (const { name, list, pair } of ROWS) {
  test(`duplicateItems: ${name}`, () => {
    // protects: T-849 the one-pass search reports the pair of the double loop over jsonEqual
    assert.deepEqual(duplicateItems(list), pair);
  });
}

/** A small deterministic generator (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const LEAVES: readonly unknown[] = [0, -0, 1, '1', '', 'a,b', 's1:a', null, undefined, true, false, Number.NaN, 1n, new Date(0), new Date(Number.NaN), NAN_OBJECT, SHARED_FUNCTION, SHARED_SYMBOL];

function randomValue(random: () => number, depth: number): unknown {
  const pick = random();
  if (depth === 0 || pick < 0.5) return LEAVES[Math.floor(random() * LEAVES.length)];
  const members = Array.from({ length: Math.floor(random() * 3) }, () => randomValue(random, depth - 1));
  if (pick < 0.75) return members;
  return Object.fromEntries(members.map((member, position) => [['a', 'b', 'c'][(position + Math.floor(random() * 2)) % 3]!, member]));
}

/** The double loop of the generated check before T-849, over `jsonEqual`. */
function doubleLoop(list: readonly unknown[]): readonly [number, number] | undefined {
  for (let first = 0; first < list.length - 1; first++) {
    for (let second = first + 1; second < list.length; second++) {
      if (jsonEqual(list[first] ?? null, list[second] ?? null)) return [first, second];
    }
  }
  return undefined;
}

test('duplicateItems answers as the double loop over jsonEqual for 4000 random small lists of a fixed seed', () => {
  // protects: T-849 the one-pass search equals the double loop over jsonEqual on mixed values
  const random = seeded(849);
  const lists = Array.from({ length: 4000 }, () => Array.from({ length: Math.floor(random() * 7) }, () => randomValue(random, 3)));
  assert.deepEqual(lists.map(duplicateItems), lists.map(doubleLoop));
});

test('duplicateItems finds the one duplicate at the end of 100000 strings and of 100000 objects', () => {
  // protects: T-849 a request body sets the list length; the search stays linear
  const strings = Array.from({ length: 100_000 }, (_, position) => `item-${position}`);
  assert.deepEqual(duplicateItems([...strings, 'item-0']), [0, 100_000]);
  const objects = Array.from({ length: 100_000 }, (_, position) => ({ id: position, tags: ['a', String(position)] }));
  assert.deepEqual(duplicateItems([...objects, { tags: ['a', '0'], id: 0 }]), [0, 100_000]);
});

test('a uniqueItems validator reports the first duplicate pair in both modes', async () => {
  // protects: T-849 the issue indexes are the pair the double loop gave
  const validate = await compileSchema({ type: 'array', uniqueItems: true });
  const issues = [{ path: [], code: 'unique', indexes: [0, 3] }];
  assert.deepEqual(validate(['a', 'b', 'b', 'a'], true), issues);
  assert.deepEqual(validate(['a', 'b', 'b', 'a'], false), issues);
  assert.deepEqual(validate(['a', 'b', 'c'], true), []);
});
