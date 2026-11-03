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
/** Two values that hold themselves, with other member names, so `jsonEqual` settles a comparison of them with each other. */
const CYCLE_A: { self?: unknown } = {};
CYCLE_A.self = CYCLE_A;
const CYCLE_B: { loop?: unknown } = {};
CYCLE_B.loop = CYCLE_B;
const SHARED_PAIR = { n: { x: 1 } };
/** A date with an own key: `jsonEqual` compares dates by their time alone. */
const DATE_WITH_KEY = Object.assign(new Date(5), { x: 1 });
class LaterDate extends Date {}
/** One node met at two depths inside two equal items: the copy holds an equal node of its own where the first holds the shared one. */
const DEEP_NODE = { x: { y: [1] } };
const AT_TWO_DEPTHS = { deep: { inner: DEEP_NODE }, k: DEEP_NODE };
const AT_TWO_DEPTHS_COPY = { deep: { inner: DEEP_NODE }, k: { x: { y: [1] } } };

/** Two items of one id that hold one owner, and the owner holds both. */
function twinsOfOneOwner(): readonly [object, object] {
  const owner: { children: unknown[] } = { children: [] };
  const twins = [{ id: 1, owner }, { id: 1, owner }] as const;
  owner.children.push(...twins);
  return twins;
}
const [TWIN_A, TWIN_B] = twinsOfOneOwner();
const SHARED_LEAF = [1];
const SHARED_NODE = { l: SHARED_LEAF, r: SHARED_LEAF };

/** Lists with the pair a double loop over `jsonEqual` reports: the lowest first index with a later equal item, and the lowest later index. */
const ROWS: readonly { readonly name: string; readonly list: readonly unknown[]; readonly pair: readonly [number, number] | undefined }[] = [
  { name: 'a pair that closes the outer span wins over an inner pair found earlier', list: ['a', 'b', 'b', 'a'], pair: [0, 3] },
  { name: 'the lowest later index of the first repeated item', list: [1, 2, 1, 1], pair: [0, 2] },
  { name: 'the first of two inner pairs', list: [1, 2, 2, 3, 3], pair: [1, 2] },
  { name: 'a late pair for the lowest first index beats an earlier-found pair', list: [1, 2, 3, 2, 1], pair: [0, 4] },
  { name: 'items equal at the top level that differ deep', list: [{ a: 1, b: { c: 1 } }, { a: 1, b: { c: 2 } }], pair: undefined },
  { name: 'items that differ at the top level with equal deep subtrees', list: [{ a: 1, b: { c: [1, 2] } }, { a: 2, b: { c: [1, 2] } }], pair: undefined },
  { name: 'arrays of one length and equal primitives with different nested items', list: [[1, { a: 1 }], [1, { a: 2 }]], pair: undefined },
  { name: 'arrays of one length and equal primitives with equal nested items', list: [[1, { a: 1 }], [1, { a: 1 }]], pair: [0, 1] },
  { name: 'flat items next to nested items: the flat pair has the lowest first index', list: [{ k: 1 }, { n: { x: 1 } }, { k: 2 }, { k: 1 }, { n: { x: 2 } }, { n: { x: 1 } }], pair: [0, 3] },
  { name: 'flat items next to nested items: the nested pair has the lowest first index', list: [{ n: { x: 1 } }, { k: 1 }, { n: { x: 2 } }, { k: 1 }, { n: { x: 1 } }], pair: [0, 4] },
  { name: 'the same object again comes after an equal copy', list: [SHARED_PAIR, { n: { x: 1 } }, SHARED_PAIR], pair: [0, 1] },
  { name: 'the same object again comes before an equal copy', list: [SHARED_PAIR, SHARED_PAIR, { n: { x: 1 } }], pair: [0, 1] },
  { name: 'items of equal id that share a cyclic owner', list: [TWIN_A, TWIN_B], pair: [0, 1] },
  { name: 'the same items of a cyclic owner in the other order', list: [TWIN_B, TWIN_A], pair: [0, 1] },
  { name: 'equal items that meet a shared node at two depths', list: [AT_TWO_DEPTHS, AT_TWO_DEPTHS_COPY], pair: [0, 1] },
  { name: 'a date with an own key equals a plain date of its time', list: [DATE_WITH_KEY, new Date(5)], pair: [0, 1] },
  { name: 'an instance of a class that extends Date equals a plain date of its time', list: [new LaterDate(5), new Date(5)], pair: [0, 1] },
  { name: 'no items', list: [], pair: undefined },
  { name: 'one item', list: ['a'], pair: undefined },
  { name: 'six items with one duplicate', list: [1, 2, 3, 4, 5, 3], pair: [2, 5] },
  { name: 'seven items with one duplicate', list: [{ a: 1 }, { a: 2 }, 3, 4, 5, 6, { a: 1 }], pair: [0, 6] },
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

/** Seven items that equal nothing in a row; behind a row's list they make it longer than the pairwise limit and leave its pair as it is. */
const FILLER = ['filler-0', 'filler-1', 'filler-2', 'filler-3', 'filler-4', 'filler-5', 'filler-6'];

for (const { name, list, pair } of ROWS) {
  test(`duplicateItems: ${name}`, () => {
    // protects: T-849 both the pairwise and the one-pass search report the pair of the double loop over jsonEqual
    assert.deepEqual(duplicateItems(list), pair);
    assert.deepEqual(duplicateItems([...list, ...FILLER]), pair);
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

const LEAVES: readonly unknown[] = [0, -0, 1, '1', '', 'a,b', 's1:a', null, undefined, true, false, Number.NaN, 1n, new Date(0), new Date(Number.NaN), NAN_OBJECT, SHARED_FUNCTION, SHARED_SYMBOL, CYCLE_A, CYCLE_B, DATE_WITH_KEY, SHARED_NODE, AT_TWO_DEPTHS, AT_TWO_DEPTHS_COPY];

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

test('duplicateItems answers as the double loop over jsonEqual for 4000 random lists of 0 to 14 items of a fixed seed', () => {
  // protects: T-849 the one-pass search equals the double loop over jsonEqual on mixed values
  const random = seeded(849);
  const lists = Array.from({ length: 4000 }, () => Array.from({ length: Math.floor(random() * 15) }, () => randomValue(random, 3)));
  assert.deepEqual(lists.map(duplicateItems), lists.map(doubleLoop));
});

test('duplicateItems finds the one duplicate at the end of 100000 strings and of 100000 objects', () => {
  // protects: T-849 a request body sets the list length; the search stays linear
  const strings = Array.from({ length: 100_000 }, (_, position) => `item-${position}`);
  assert.deepEqual(duplicateItems([...strings, 'item-0']), [0, 100_000]);
  const objects = Array.from({ length: 100_000 }, (_, position) => ({ id: position, tags: ['a', String(position)] }));
  assert.deepEqual(duplicateItems([...objects, { tags: ['a', '0'], id: 0 }]), [0, 100_000]);
});

/** `levels` arrays (or objects, with `wrap` false) around `leaf`, built without recursion. */
function nested(levels: number, leaf: unknown, wrap: boolean): unknown {
  let value = leaf;
  for (let level = 0; level < levels; level++) value = wrap ? [value] : { next: value };
  return value;
}

test('duplicateItems builds the key of an item nested 100000 levels without a deep call stack, at any list length', () => {
  // protects: T-849 one request item nested very deep must not raise RangeError in the key builder
  const deepArray = nested(100_000, 'end', true);
  const deepObject = nested(100_000, 'end', false);
  assert.deepEqual(duplicateItems([deepArray, nested(100_000, 'end', true)]), [0, 1]);
  assert.deepEqual(duplicateItems([deepObject, nested(100_000, 'end', false)]), [0, 1]);
  assert.deepEqual(duplicateItems([deepArray, ...FILLER.slice(0, 5), nested(100_000, 'end', true)]), [0, 6]);
  assert.equal(duplicateItems([deepArray, ...FILLER, nested(100_000, 'other', true), nested(99_999, 'end', true), deepObject]), undefined);
  assert.equal(duplicateItems([deepArray, nested(100_000, 'other', true)]), undefined);
});

class Child {
  constructor(readonly id: number, readonly owner: { readonly children: unknown[] }) {}
}

/** `count` instances with program state: each holds its `owner`, and the owner holds the instances. */
function cyclicItems(count: number): Child[] {
  const owner: { children: unknown[] } = { children: [] };
  const items = Array.from({ length: count }, (_, id) => new Child(id, owner));
  owner.children.push(...items);
  return items;
}

test('duplicateItems ends on items that hold a cycle, in a list of 7 and of 2, and finds the same object twice', async () => {
  // protects: T-849 an item that holds a cycle must not grow the walk without end
  const seven = cyclicItems(7);
  const two = cyclicItems(2);
  assert.equal(duplicateItems(seven), undefined);
  assert.equal(duplicateItems(two), undefined);
  assert.deepEqual(duplicateItems([...seven, seven[3]]), [3, 7]);
  assert.deepEqual(duplicateItems([two[0], two[0]]), [0, 1]);
  const validate = await compileSchema({ type: 'array', uniqueItems: true });
  assert.deepEqual(validate(seven, true), []);
  assert.deepEqual(validate([...seven, seven[3]], true), [{ path: [], code: 'unique', indexes: [3, 7] }]);
});

test('duplicateItems walks a value that shares its members once per distinct object', () => {
  // protects: T-849 a value of shared nodes must not expand to its full tree
  const build = (): unknown => {
    let shared: unknown = {};
    for (let level = 0; level < 40; level++) shared = { l: shared, r: shared };
    return shared;
  };
  assert.deepEqual(duplicateItems([build(), build()]), [0, 1]);
  assert.deepEqual(duplicateItems([build(), 1, 2, 3, 4, 5, 6, build()]), [0, 7]);
  const big = { a: [1, { b: 'x' }] };
  assert.deepEqual(duplicateItems(Array.from({ length: 100_000 }, () => big)), [0, 1]);
});

test('duplicateItems finishes on a spine of 256 levels with a look-alike beside the spine at each level', () => {
  // protects: T-849 look-alike siblings must not make each level walk the whole subtree below it
  const lookAlike = (): unknown => ({ name: 'a', children: [{ id: 2 }, { id: 3 }] });
  const lists: unknown[][] = [];
  let spine: unknown = { name: 'a', children: [{ id: 1 }, { id: 1 }] };
  for (let level = 0; level < 256; level++) {
    lists.push([lookAlike(), spine]);
    spine = { name: 'a', children: [{ id: 1 }, spine] };
  }
  assert.deepEqual(lists.map(duplicateItems), lists.map(() => undefined));
  assert.deepEqual(duplicateItems([...lists[255]!, lookAlike()]), [0, 2]);
});

test('duplicateItems finds the pair of two equal spines 500 levels deep with a wide list of small nodes at the bottom', () => {
  // protects: T-849 the memo of one walk must not hold a slot for each depth in each object
  const spine = (last: number): unknown => {
    let node: unknown = { wide: Array.from({ length: 20_000 }, (_, id) => ({ id: id === 19_999 ? last : id })) };
    for (let level = 0; level < 500; level++) node = { next: node };
    return node;
  };
  assert.deepEqual(duplicateItems([spine(19_999), spine(19_999)]), [0, 1]);
  assert.equal(duplicateItems([spine(19_999), spine(-1)]), undefined);
});

test('a uniqueItems validator reports the first duplicate pair in both modes', async () => {
  // protects: T-849 the issue indexes are the pair the double loop gave
  const validate = await compileSchema({ type: 'array', uniqueItems: true });
  const issues = [{ path: [], code: 'unique', indexes: [0, 3] }];
  assert.deepEqual(validate(['a', 'b', 'b', 'a'], true), issues);
  assert.deepEqual(validate(['a', 'b', 'b', 'a'], false), issues);
  assert.deepEqual(validate(['a', 'b', 'c'], true), []);
});
