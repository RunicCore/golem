import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MODEL_CODEC_IDS_KEY } from '@exprtlabs/golem/schema';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { compile } from '@exprtlabs/golem/validator-compiler';

import { compileValidatorModule, type FastCheck } from './support/compiled-validators.js';

// The fast check `is_X` of the validator compiler (`fastPath`) is exact: `is(v)` is true if and only if `validate(v,
// true)` reports no issue. Each row compiles one schema with `fastPath` on and compares both functions of that module.

const MODEL_CODEC_IDS = Symbol.for(MODEL_CODEC_IDS_KEY);

/** A class whose prototype lists `ids` the way a registered model does. */
function modelClass(...ids: string[]): new () => object {
  const model = class {};
  Object.defineProperty(model.prototype, MODEL_CODEC_IDS, { value: ids });
  return model;
}

const Cat = modelClass('Cat');
const Dog = modelClass('Dog');

interface Compiled {
  readonly validate: Validator;
  readonly isValid: FastCheck;
}

async function compileFast(schema: unknown, resources: Readonly<Record<string, unknown>> = {}): Promise<Compiled> {
  const module = await compileValidatorModule({ roots: { root: schema }, resources, fastPath: true });
  const isValid = module.fastByRoot.root;
  assert.ok(isValid, 'the root has a fast check');
  return { validate: module.byRoot.root, isValid };
}

/** What a function did with a value: its answer, or the name of the error it threw. */
function outcome(run: () => boolean): boolean | string {
  try {
    return run();
  } catch (error) {
    return error instanceof Error ? `throws ${error.name}` : 'throws';
  }
}

/** The values on which the fast check and the full validator disagree, with both answers. */
function disagreements({ validate, isValid }: Compiled, values: readonly unknown[]): readonly unknown[] {
  return values
    .map(value => ({ value, full: outcome(() => validate(value, true).length === 0), fast: outcome(() => isValid(value)) }))
    .filter(entry => entry.full !== entry.fast);
}

// A seeded generator of odd values: each value is a valid sample with one change at a random place in it.

/** mulberry32: a small seeded generator, so a failing value is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const ODD_VALUES: readonly (() => unknown)[] = [
  () => Number.NaN, () => Number.POSITIVE_INFINITY, () => Number.NEGATIVE_INFINITY, () => -0, () => 1.5, () => 2 ** 53, () => 0.30000000000000004,
  () => new Date(Number.NaN), () => new Date(0), () => '', () => 'a', () => '😀', () => '😀😀', () => 'a😀b', () => '\ud800', () => '2024-01-01T00:00:00Z',
  () => null, () => undefined, () => true, () => 0, () => 7, () => -1, () => [], () => [undefined], () => [, 1], () => [1, 1], () => [{ a: 1 }, { a: 1, b: undefined }],
  () => ({}), () => Object.create(null), () => ({ [Symbol('s')]: 1 }), () => new Proxy({ id: 1 }, {}), () => new Cat(), () => new Dog(), () => ({ a: undefined }),
];

function odd(random: () => number): unknown {
  return ODD_VALUES[Math.floor(random() * ODD_VALUES.length)]();
}

/** A plain object of the samples, which a change may edit. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** A copy of a sample: plain objects, arrays (holes kept) and Dates are copied, other values shared. */
function copy(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) if (index in value) result[index] = copy(value[index]);
    return result;
  }
  if (!isPlainRecord(value)) return value;
  // Each property keeps its descriptor, so a getter is not run and a non-enumerable key stays one.
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    Object.defineProperty(result, key, 'value' in descriptor ? { ...descriptor, value: copy(descriptor.value) } : descriptor);
  }
  return result;
}

/** The plain objects and arrays inside `value`, itself included. */
function containers(value: unknown): readonly (Record<string, unknown> | unknown[])[] {
  if (Array.isArray(value)) return [value, ...value.flatMap(containers)];
  // Through the descriptors, so a getter is not run.
  return isPlainRecord(value) ? [value, ...Object.values(Object.getOwnPropertyDescriptors(value)).flatMap(descriptor => ('value' in descriptor ? containers(descriptor.value) : []))] : [];
}

/** One change to an object: a field replaced, removed, set to `undefined`, hidden or added, or the object made odd. */
function changeObject(target: Record<string, unknown>, random: () => number): unknown {
  const keys = Object.keys(target);
  const key = keys.length === 0 ? 'id' : keys[Math.floor(random() * keys.length)];
  switch (Math.floor(random() * 8)) {
    case 0: target[key] = odd(random); return undefined;
    case 1: delete target[key]; return undefined;
    case 2: target[key] = undefined; return undefined;
    case 3: Object.defineProperty(target, key, { enumerable: false }); return undefined;
    case 4: target[`extra${Math.floor(random() * 3)}`] = random() < 0.3 ? undefined : odd(random); return undefined;
    case 5: Object.defineProperty(target, Symbol('extra'), { value: 1, enumerable: true }); return undefined;
    case 6: return new Proxy(target, {});
    default: return Object.create(target);
  }
}

/** One change to an array: an item replaced, the array shortened, a hole, or an extra item. */
function changeArray(target: unknown[], random: () => number): void {
  const index = Math.floor(random() * Math.max(target.length, 1));
  switch (Math.floor(random() * 4)) {
    case 0: target[index] = odd(random); return;
    case 1: target.length = Math.max(0, target.length - 1); return;
    case 2: target.length += 1; return;
    default: target.push(odd(random));
  }
}

/** `count` values, each `sample` with one change at a random place; a change that wraps an object wraps the whole value. */
function oddValues(sample: unknown, seed: number, count: number): readonly unknown[] {
  const random = seeded(seed);
  return Array.from({ length: count }, () => {
    const value = copy(sample);
    const places = containers(value);
    if (places.length === 0) return odd(random);
    const place = places[Math.floor(random() * places.length)];
    if (Array.isArray(place)) {
      changeArray(place, random);
      return value;
    }
    const wrapped = changeObject(place, random);
    return wrapped !== undefined && place === value ? wrapped : value;
  });
}

const ITEM = { type: 'object', required: ['sku', 'qty'], properties: { sku: { type: 'string', minLength: 1 }, qty: { type: 'integer', minimum: 1 } }, additionalProperties: false };

interface Row {
  readonly name: string;
  readonly schema: unknown;
  readonly resources?: Readonly<Record<string, unknown>>;
  /** Valid values of the schema; each also seeds the generated values. */
  readonly valid: readonly unknown[];
}

const ROWS: readonly Row[] = [
  {
    name: 'flat model: scalars, a Date, an enum, a format and no unknown keys (K1-K4, K10-K12)',
    schema: {
      type: 'object',
      required: ['id', 'name', 'active', 'score', 'createdAt'],
      properties: {
        id: { type: 'integer' }, name: { type: 'string' }, active: { type: 'boolean' }, score: { type: 'number' },
        createdAt: { golemModelDate: true }, status: { enum: ['open', 'closed', null] }, at: { type: 'string', format: 'date-time' },
      },
      additionalProperties: false,
    },
    valid: [{ id: 1, name: 'n', active: true, score: 1.5, createdAt: new Date(0), status: 'open', at: '2024-01-01T00:00:00Z' }, { id: 2, name: '', active: false, score: 0, createdAt: new Date(1), status: null }],
  },
  {
    name: 'nested model and a nullable child (K11, K18, K20)',
    schema: {
      type: 'object',
      required: ['owner'],
      properties: { owner: { $ref: '#/$defs/Person' }, partner: { anyOf: [{ $ref: '#/$defs/Person' }, { type: 'null' }] } },
      additionalProperties: false,
      $defs: { Person: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
    },
    valid: [{ owner: { name: 'a', age: 3 }, partner: null }, { owner: { name: 'b' }, partner: { name: 'c' } }],
  },
  {
    name: 'array of models with limits and unique items (K7, K8)',
    schema: { type: 'array', items: ITEM, minItems: 1, maxItems: 3, uniqueItems: true },
    valid: [[{ sku: 'a', qty: 1 }], [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2 }]],
  },
  {
    name: 'tuple with an optional tail and no extra items (K7)',
    schema: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }, { golemModelDate: true }], items: false, minItems: 2 },
    valid: [['a', 1], ['a', 1, new Date(0)]],
  },
  {
    name: 'record of numbers with a key count (K13, K14)',
    schema: { type: 'object', additionalProperties: { type: 'number', minimum: 0 }, minProperties: 1, maxProperties: 3 },
    valid: [{ a: 1 }, { a: 0, b: 2, c: 3 }],
  },
  {
    name: 'allOf of two members with shared names, one closed (K19)',
    schema: {
      allOf: [
        { type: 'object', required: ['id'], properties: { id: { type: 'string' }, note: { type: 'string' } } },
        { type: 'object', properties: { id: { type: 'string', minLength: 2 }, note: { type: 'string' } }, additionalProperties: false },
      ],
    },
    valid: [{ id: 'ab' }, { id: 'abc', note: 'n' }],
  },
  {
    name: 'dependentRequired, a required any, a never property and a required key that properties does not name (K10, K15, K30)',
    schema: {
      type: 'object',
      required: ['anything', 'tag'],
      properties: { anything: {}, card: { type: 'string' }, billing: { type: 'string' }, forbidden: false },
      dependentRequired: { card: ['billing'] },
      additionalProperties: { type: 'string' },
    },
    valid: [{ anything: null, tag: 't' }, { anything: [1], tag: 'x', card: 'c', billing: 'b' }],
  },
  {
    name: 'string limits by code point and a pattern, number bounds and multipleOf (K5, K6)',
    schema: {
      type: 'object',
      required: ['code', 'price'],
      properties: {
        code: { type: 'string', minLength: 2, maxLength: 3, pattern: '^[a-z😀]+$' },
        price: { type: 'number', exclusiveMinimum: 0, maximum: 100, multipleOf: 0.1 },
        count: { type: 'integer', minimum: -1, exclusiveMaximum: 10 },
      },
    },
    valid: [{ code: '😀😀', price: 0.3 }, { code: 'abc', price: 100, count: -1 }],
  },
  {
    name: 'model instance in a property (K26)',
    schema: {
      type: 'object',
      required: ['pet'],
      properties: { pet: { golemModelInstance: { of: 'Cat', among: ['Cat', 'Dog'], required: true } }, other: { golemModelInstance: { among: ['Cat', 'Dog'], required: false } } },
    },
    valid: [{ pet: new Cat() }, { pet: new Cat(), other: { plain: 1 } }],
  },
  {
    name: 'recursive tree through $ref (K18)',
    schema: { $ref: '#/$defs/Node', $defs: { Node: { type: 'object', required: ['value'], properties: { value: { type: 'integer' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } }, additionalProperties: false } } },
    valid: [{ value: 1, children: [{ value: 2 }, { value: 3, children: [{ value: 4 }] }] }],
  },
  {
    name: 'micro-leaves and unions inside a model: contains, patternProperties, propertyNames, oneOf, a discriminator, not, if, dependentSchemas',
    schema: {
      type: 'object',
      required: ['list'],
      properties: {
        list: { type: 'array', contains: { const: 1 }, maxContains: 2 },
        map: { type: 'object', patternProperties: { '^x': { type: 'integer' } }, additionalProperties: false },
        names: { type: 'object', propertyNames: { maxLength: 2 } },
        choice: { oneOf: [{ type: 'string' }, { type: 'string', minLength: 3 }, { type: 'integer' }] },
        shape: { oneOf: [{ type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } }, { type: 'object', required: ['kind'], properties: { kind: { const: 'b' }, size: { type: 'integer' } } }], discriminator: { propertyName: 'kind' } },
        other: { not: { type: 'string' } },
        when: { if: { type: 'integer' }, then: { minimum: 5 }, else: { type: 'string' } },
        card: { type: 'object', dependentSchemas: { number: { required: ['cvv'] } } },
      },
    },
    valid: [{ list: [1, 2] }, { list: [1, 1], map: { x1: 2 }, names: { ab: 1 }, choice: 'ab', shape: { kind: 'b', size: 1 }, other: 1, when: 6, card: { number: 1, cvv: 2 } }],
  },
  {
    name: 'tagged union: the tag selects one branch, an unknown or missing tag fails (K21)',
    schema: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'object', required: ['kind', 'radius'], properties: { kind: { const: 'circle' }, radius: { type: 'number', minimum: 0 } }, additionalProperties: false },
          { type: 'object', required: ['kind', 'side'], properties: { kind: { enum: ['square', 'box'] }, side: { type: 'integer' } }, additionalProperties: false },
          { type: 'object', required: ['kind'], properties: { kind: { const: 7 } } },
        ],
        discriminator: { propertyName: 'kind' },
      },
    },
    valid: [[{ kind: 'circle', radius: 1 }, { kind: 'box', side: 2 }, { kind: 7, extra: true }], [{ kind: 'square', side: 0 }]],
  },
  {
    name: 'untagged oneOf counts exactly one match, anyOf takes any, and not inverts an exact child (K20, K22, K23)',
    schema: {
      type: 'object',
      properties: {
        one: { oneOf: [{ type: 'integer' }, { type: 'number', minimum: 10 }, { type: 'string' }] },
        any: { anyOf: [{ type: 'string', maxLength: 1 }, { type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        notText: { not: { type: 'string' } },
        notShape: { not: { type: 'object', required: ['a'] } },
      },
    },
    valid: [{ one: 1, any: 'a', notText: 1, notShape: { b: 1 } }, { one: 'x', any: ['a', 'b'], notText: null, notShape: [] }],
  },
  {
    name: 'IModel class union: a tagged plain object or an untagged instance of its class (K21, K23, K26)',
    schema: {
      type: 'array',
      items: {
        oneOf: [
          {
            allOf: [{ type: 'object', properties: { kind: { type: 'string' }, lives: { type: 'integer' } } }],
            anyOf: [
              { properties: { kind: { const: 'cat' } }, required: ['kind'], golemModelInstance: { of: 'Cat', among: ['Cat', 'Dog'], required: false } },
              { not: { required: ['kind'] }, golemModelInstance: { of: 'Cat', among: ['Cat', 'Dog'], required: true } },
            ],
          },
          {
            allOf: [{ type: 'object', properties: { kind: { type: 'string' }, barks: { type: 'boolean' } } }],
            anyOf: [
              { properties: { kind: { const: 'dog' } }, required: ['kind'], golemModelInstance: { of: 'Dog', among: ['Cat', 'Dog'], required: false } },
              { not: { required: ['kind'] }, golemModelInstance: { of: 'Dog', among: ['Cat', 'Dog'], required: true } },
            ],
          },
        ],
      },
    },
    valid: [[{ kind: 'cat', lives: 9 }, { kind: 'dog', barks: true }, new Cat(), new Dog()]],
  },
];

for (const row of ROWS) {
  test(`fast check equals the full validator in both directions on generated odd values: ${row.name}`, async () => {
    const compiled = await compileFast(row.schema, row.resources);
    const values = [...row.valid, ...row.valid.flatMap((sample, position) => oddValues(sample, 1000 + position, 400))];
    assert.deepEqual(disagreements(compiled, values), []);
    assert.deepEqual(row.valid.map(value => compiled.isValid(value)), row.valid.map(() => true), 'every valid value passes the fast check');
    const verdicts = new Set(values.map(value => outcome(() => compiled.isValid(value))));
    assert.ok(verdicts.has(true) && verdicts.has(false), 'the generated values hold both valid and invalid ones');
  });
}

// The JSON view (spec section 4): a field is present when it is an own enumerable property whose value is not undefined.

const NON_ENUMERABLE_ID: Record<string, unknown> = { extra: 1 };
Object.defineProperty(NON_ENUMERABLE_ID, 'id', { value: 1, enumerable: false });
const SYMBOL_EXTRA = { id: 1, [Symbol('extra')]: 2 };
const INHERITED_ID: object = Object.create({ id: 1 });
const NULL_PROTOTYPE: Record<string, unknown> = Object.assign(Object.create(null), { id: 1 });
const OWN_PROTO_KEY: Record<string, unknown> = JSON.parse('{"id":1,"__proto__":2}');
const PROXY = new Proxy({ id: 1 }, {});

const CLOSED = { type: 'object', required: ['id'], properties: { id: { type: 'number' }, note: { type: 'string' } }, additionalProperties: false };

const JSON_VIEW_ROWS: readonly (readonly [name: string, schema: unknown, value: unknown, valid: boolean])[] = [
  ['NaN is not a number', { type: 'number' }, Number.NaN, false],
  ['Infinity is not a number', { type: 'number' }, Number.POSITIVE_INFINITY, false],
  ['-0 is an integer', { type: 'integer' }, -0, true],
  ['an invalid Date is not a Date', { golemModelDate: true }, new Date(Number.NaN), false],
  ['a declared key that is not enumerable is absent, and the other key is unknown', CLOSED, NON_ENUMERABLE_ID, false],
  ['a symbol key is not a key of the JSON view', CLOSED, SYMBOL_EXTRA, true],
  ['an inherited declared key is absent', CLOSED, INHERITED_ID, false],
  ['a null-prototype object is an object', CLOSED, NULL_PROTOTYPE, true],
  ['an own __proto__ data key is an unknown key', CLOSED, OWN_PROTO_KEY, false],
  ['a Proxy is read through its traps', CLOSED, PROXY, true],
  ['an optional key set to undefined is absent, and an extra key is unknown', CLOSED, { id: 1, note: undefined, extra: 1 }, false],
  ['an extra key set to undefined is absent', CLOSED, { id: 1, extra: undefined }, true],
  ['an astral string counts code points at minLength', { type: 'string', minLength: 2 }, '😀', false],
  ['two astral code points meet minLength 2', { type: 'string', minLength: 2 }, '😀😀', true],
  ['three astral code points pass maxLength 3', { type: 'string', maxLength: 3 }, '😀😀😀', true],
  ['a lone surrogate is one code point', { type: 'string', minLength: 2 }, '\ud800', false],
  ['a short tuple skips its missing items', { prefixItems: [{ type: 'string' }, { type: 'number' }] }, ['a'], true],
  ['a hole in a tuple is an undefined item', { prefixItems: [{ type: 'string' }, { type: 'number' }] }, [, 1], false],
  ['a required any rejects an undefined value', { type: 'object', required: ['any'], properties: { any: {} } }, { any: undefined }, false],
  ['a required any accepts null', { type: 'object', required: ['any'], properties: { any: {} } }, { any: null }, true],
  ['a never property accepts its key set to undefined', { properties: { name: false } }, { name: undefined }, true],
  ['a never property rejects its key', { properties: { name: false } }, { name: 1 }, false],
  ['a const object ignores an undefined-valued key', { const: { a: 1 } }, { a: 1, b: undefined }, true],
  ['a primitive enum compares by value', { enum: [1, 'a', null] }, 1.0, true],
  ['a primitive enum rejects a string of a number', { enum: [1] }, '1', false],
  ['a subclass of a registered model selects the model', { golemModelInstance: { of: 'Cat', among: ['Cat'], required: true } }, new (class extends Cat {})(), true],
  ['a plain object with a tag is no instance', { golemModelInstance: { of: 'Cat', among: ['Cat'], required: true } }, { kind: 'Cat' }, false],
];

for (const [name, schema, value, valid] of JSON_VIEW_ROWS) {
  test(`JSON view: ${name}`, async () => {
    const { validate, isValid } = await compileFast(schema);
    assert.deepEqual({ full: validate(value, true).length === 0, fast: isValid(value) }, { full: valid, fast: valid });
  });
}

test('a throwing getter of a declared key throws from the fast check as from the full validator', async () => {
  const { validate, isValid } = await compileFast(CLOSED);
  const value = { get id(): number { throw new RangeError('getter'); } };
  assert.throws(() => validate(value, true), RangeError);
  assert.throws(() => isValid(value), RangeError);
});

// No silent decline: each keyword row gets a fast check that accepts a valid value and rejects an invalid one, and the
// roots the spec excludes get none.

const NESTED = (schema: object): object => ({ type: 'object', properties: { field: schema } });
const inField = (value: unknown): object => ({ field: value });

const FAST_FORM_ROWS: readonly (readonly [row: string, schema: unknown, valid: unknown, invalid: unknown])[] = [
  ['K1 type', { type: ['string', 'integer'] }, 1, 1.5],
  ['K2 const and enum', { enum: ['a', 1, { b: 2 }] }, { b: 2 }, 'b'],
  ['K3 format', { type: 'string', format: 'uuid' }, '123e4567-e89b-12d3-a456-426614174000', 'x'],
  ['K4 Date', { golemModelDate: true }, new Date(0), '1970-01-01'],
  ['K5 string limits and pattern', { type: 'string', minLength: 1, maxLength: 4, pattern: '^a' }, 'ab', 'ba'],
  ['K6 number bounds and multipleOf', { type: 'number', minimum: 0, exclusiveMaximum: 9, multipleOf: 3 }, 6, 9],
  ['K7 tuple and items', { type: 'array', prefixItems: [{ type: 'string' }], items: false, minItems: 1 }, ['a'], ['a', 1]],
  ['K8 uniqueItems', { type: 'array', uniqueItems: true }, [1, 2], [{ a: 1 }, { a: 1 }]],
  ['K9 contains', NESTED({ type: 'array', contains: { type: 'string' } }), inField(['a']), inField([1])],
  ['K10 and K11 required and properties', { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, { a: 'x' }, { a: 1 }],
  ['K12 additionalProperties false', { type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1 }, { b: 1 }],
  ['K13 additionalProperties schema', { type: 'object', additionalProperties: { type: 'string' } }, { b: 'x' }, { b: 1 }],
  ['K14 minProperties and maxProperties', { type: 'object', minProperties: 1, maxProperties: 2 }, { a: 1 }, { a: undefined }],
  ['K15 dependentRequired', { type: 'object', dependentRequired: { a: ['b'] } }, { a: 1, b: 1 }, { a: 1 }],
  ['K16 patternProperties', NESTED({ type: 'object', patternProperties: { '^a': { type: 'string' } } }), inField({ ab: 'x' }), inField({ ab: 1 })],
  ['K17 propertyNames', NESTED({ type: 'object', propertyNames: { minLength: 2 } }), inField({ ab: 1 }), inField({ a: 1 })],
  ['K18 $ref', { $ref: '#/$defs/A', $defs: { A: { type: 'string' } } }, 'a', 1],
  ['K19 allOf', { allOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] }, { a: 1, b: 1 }, { a: 1 }],
  ['K20 anyOf', { anyOf: [{ type: 'string' }, { type: 'null' }] }, null, 1],
  ['K21 oneOf with a discriminator', { oneOf: [{ properties: { k: { const: 'a' } }, required: ['k'] }, { properties: { k: { const: 'b' } }, required: ['k'] }], discriminator: { propertyName: 'k' } }, { k: 'b' }, { k: 'c' }],
  ['K22 oneOf', { oneOf: [{ type: 'string' }, { type: 'integer' }] }, 'a', 1.5],
  ['K23 not', { not: { type: 'string' } }, 1, 'a'],
  ['K23 an IModel class union branch', { anyOf: [{ not: { required: ['kind'] }, golemModelInstance: { of: 'Cat', among: ['Cat'], required: true } }, { required: ['kind'] }] }, new Cat(), {}],
  ['K24 if, then and else', NESTED({ if: { type: 'string' }, then: { minLength: 2 } }), inField('ab'), inField('a')],
  ['K25 dependentSchemas', NESTED({ dependentSchemas: { a: { required: ['b'] } } }), inField({ a: 1, b: 1 }), inField({ a: 1 })],
  ['K26 golemModelInstance', { golemModelInstance: { of: 'Cat', among: ['Cat'], required: true } }, new Cat(), new Dog()],
  ['K30 a never property', { properties: { a: false } }, { b: 1 }, { a: 1 }],
];

for (const [row, schema, valid, invalid] of FAST_FORM_ROWS) {
  test(`fast form table: ${row} has a fast check that accepts a valid value and rejects an invalid one`, async () => {
    const { validate, isValid } = await compileFast(schema);
    assert.deepEqual(
      { full: [validate(valid, true).length === 0, validate(invalid, true).length === 0], fast: [isValid(valid), isValid(invalid)] },
      { full: [true, false], fast: [true, false] },
    );
  });
}

const RULES = new Map([['rules.isEven', { importPath: './rules.mjs', exportName: 'isEven' }]]);

test('no fast check for a root that reaches a validation function, also through $ref, while a root beside it keeps its own', () => {
  const result = compile(
    {
      roots: new Map<string, unknown>([
        ['Money', { type: 'integer', exprtValidation: ['rules.isEven'] }],
        ['Order', { type: 'object', properties: { total: { $ref: 'Money' } } }],
        ['Note', { type: 'string' }],
      ]),
      validations: RULES,
    },
    { unknownFormats: 'warn', fastPath: true },
  );
  assert.deepEqual([...result.fastExports], [['Note', 'is_Note']]);
});

test('no fast check for a root whose object or array check of the value itself, also inside allOf, a union branch or $ref, is a micro-leaf, whose tree holds only micro-leaves, or that keeps an evaluation record', () => {
  const result = compile(
    {
      roots: new Map<string, unknown>([
        ['Patterns', { type: 'object', patternProperties: { '^a': { type: 'string' } } }],
        ['Contains', { type: 'array', contains: { type: 'string' } }],
        ['OnlyIf', { if: { type: 'string' }, then: { minLength: 2 } }],
        ['AllOfOfLeaves', { allOf: [{ if: { type: 'string' }, then: { minLength: 2 } }, { dependentSchemas: { a: { required: ['b'] } } }] }],
        ['AnyOfOfLeaves', { anyOf: [{ type: 'object', propertyNames: { maxLength: 1 } }, { type: 'array', contains: { type: 'string' } }] }],
        ['RefToLeaf', { $ref: '#/$defs/Leaf', $defs: { Leaf: { type: 'object', patternProperties: { '^a': { type: 'string' } } } } }],
        ['AllOfWithLeafObject', { allOf: [{ type: 'object', patternProperties: { '^x': { type: 'integer' } } }, { type: 'object' }] }],
        ['AnyOfWithLeafObject', { anyOf: [{ type: 'object', patternProperties: { '^x': { type: 'integer' } } }, { type: 'string' }] }],
        ['RefToLeafBesideType', { type: 'object', $ref: '#/$defs/Leaf', $defs: { Leaf: { type: 'object', patternProperties: { '^a': { type: 'string' } } } } }],
        ['Unevaluated', { type: 'object', properties: { a: {} }, unevaluatedProperties: false }],
      ]),
    },
    { unknownFormats: 'warn', fastPath: true },
  );
  assert.deepEqual([...result.fastExports], []);
});

// Declared keys that `properties` does not name: each is captured, then tested as an unknown key.
test('the fast check captures each required or dependent key that properties does not name, and tests it as an additional key', async () => {
  const required = await compileFast({ required: ['a', 'b'], additionalProperties: { type: 'string' } });
  const dependent = await compileFast({ dependentRequired: { card: ['billing'] }, additionalProperties: { type: 'string' } });
  const values = [{ a: 'x' }, { a: 'x', b: 'y' }, { a: 'x', b: 1 }, { b: 'y' }];
  assert.deepEqual(values.map(value => [required.validate(value, true).length === 0, required.isValid(value)]), [[false, false], [true, true], [false, false], [false, false]]);
  const cards = [{ card: 'x' }, { card: 'x', billing: 'y' }, { billing: 'y' }, { card: 1, billing: 'y' }];
  assert.deepEqual(cards.map(value => [dependent.validate(value, true).length === 0, dependent.isValid(value)]), [[false, false], [true, true], [true, true], [false, false]]);
});

// A seeded schema generator: schemas from a small grammar (objects with required, properties, dependentRequired,
// additionalProperties, key counts and patternProperties; arrays and tuples; oneOf, anyOf, not and tagged unions;
// $ref, const and enums of objects, formats, Dates, model instances and scalars), each checked on values made for it.

const KEYS = ['a', 'b', 'c', 'd'] as const;

/** Samples of each generated format: a valid one first, then one that fails. */
const FORMAT_SAMPLES: Readonly<Record<string, readonly string[]>> = {
  'date-time': ['2024-01-01T00:00:00Z', '2024-01-01'],
  date: ['2024-01-01', '2024-13-01'],
  email: ['a@b.co', 'a'],
  uuid: ['123e4567-e89b-12d3-a456-426614174000', 'x'],
};

/** The schemas `$ref` reaches, by resource name; `Node` reaches itself. */
const SHARED: Readonly<Record<string, Record<string, unknown>>> = {
  Item: ITEM,
  Node: { type: 'object', required: ['value'], properties: { value: { type: 'integer' }, children: { type: 'array', items: { $ref: 'Node' } } }, additionalProperties: false },
  Code: { type: 'string', format: 'uuid' },
  // A tagged union of $ref branches: each branch is judged at its target.
  Circle: { type: 'object', required: ['kind', 'r'], properties: { kind: { const: 'circle' }, r: { type: 'number' } }, additionalProperties: false },
  Square: { type: 'object', required: ['kind', 'side'], properties: { kind: { const: 'square' }, side: { type: 'number' }, r: { type: 'string' } } },
  Shape: { oneOf: [{ $ref: 'Circle' }, { $ref: 'Square' }], discriminator: { propertyName: 'kind' } },
};

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function subset<T>(random: () => number, items: readonly T[]): T[] {
  return items.filter(() => random() < 0.5);
}

/**
 * A schema at `depth`. `own` is true for a schema of the root value itself (union branches, `not` and `allOf` keep
 * it): such a schema gets no `patternProperties`, whose micro-leaf would leave the root without a fast check.
 */
function randomSchema(random: () => number, depth: number, own: boolean): Record<string, unknown> {
  const child = (): Record<string, unknown> => randomSchema(random, depth + 1, false);
  const same = (): Record<string, unknown> => randomSchema(random, depth + 1, own);
  const leaves = ['string', 'integer', 'number', 'boolean', 'enum', 'const', 'format', 'date', 'instance', 'ref'];
  const kinds = depth < 2 ? [...leaves, 'array', 'tuple', 'object', 'object', 'object', 'oneOf', 'anyOf', 'not', 'tagged', 'constTagged'] : leaves;
  switch (pick(random, kinds)) {
    case 'string': return random() < 0.5 ? { type: 'string' } : { type: 'string', minLength: 1, maxLength: 2 };
    case 'integer': return { type: 'integer', ...(random() < 0.5 ? { minimum: 0 } : {}) };
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'enum': return { enum: subset(random, ['y', 1, null, true, { k: 1 }, [1, 'x']]).concat(['x']) };
    case 'const': return { const: pick(random, ['x', 1, null, { k: 1, m: [2] }]) };
    case 'format': return { type: 'string', format: pick(random, Object.keys(FORMAT_SAMPLES)) };
    case 'date': return { golemModelDate: true };
    case 'instance': return { golemModelInstance: { of: 'Cat', among: ['Cat', 'Dog'], required: random() < 0.5 } };
    case 'ref': return { $ref: pick(random, Object.keys(SHARED)) };
    case 'array': return { type: 'array', items: child(), ...(random() < 0.3 ? { minItems: 1 } : {}), ...(random() < 0.3 ? { uniqueItems: true } : {}) };
    case 'tuple': return { type: 'array', prefixItems: [child(), child()], ...pick(random, [{}, { items: false }, { items: child() }]), ...(random() < 0.3 ? { minItems: 1 } : {}) };
    case 'oneOf': return { oneOf: [same(), same()] };
    case 'anyOf': return { anyOf: [same(), same(), same()] };
    case 'not': return { not: same() };
    case 'tagged': {
      // Both branches declare `a`, each with its own check; `own` is a key only one branch declares.
      const branch = (tag: string, own: string): Record<string, unknown> => ({
        type: 'object',
        // The tag may be optional in a branch: the discriminator reads it from `properties` alone.
        required: random() < 0.3 ? ['a'] : ['kind', 'a'],
        properties: { kind: { const: tag }, a: child(), [own]: child() },
        ...pick(random, [{}, { additionalProperties: false }, { additionalProperties: false }, { additionalProperties: { type: 'string' } }]),
      });
      return { oneOf: [branch('p', 'b'), branch('q', 'c')], discriminator: { propertyName: 'kind' } };
    }
    case 'constTagged': {
      // A union with no discriminator whose branches each require `t` and hold it to one value of their own, or a near
      // miss: `t` not required in one branch, two branches with one value, an enum of two, or a branch that is no object.
      const miss = pick(random, ['none', 'none', 'optional', 'duplicate', 'enum', 'nonObject']);
      const branch = (tag: string, own: string, last: boolean): Record<string, unknown> => ({
        type: 'object',
        required: miss === 'optional' && last ? ['a'] : ['t', 'a'],
        properties: { t: miss === 'enum' && last ? { enum: [tag, 'r'] } : { const: miss === 'duplicate' && last ? 'p' : tag }, a: child(), [own]: child() },
        ...pick(random, [{}, { additionalProperties: false }, { additionalProperties: false }]),
      });
      return { [pick(random, ['anyOf', 'oneOf'])]: [branch('p', 'b', false), miss === 'nonObject' ? { type: 'string' } : branch('q', 'c', true)] };
    }
    default: {
      const named = subset(random, KEYS);
      const trigger = pick(random, KEYS);
      return {
        type: 'object',
        properties: Object.fromEntries(named.map(key => [key, child()])),
        required: subset(random, KEYS),
        ...(random() < 0.3 ? { dependentRequired: { [trigger]: subset(random, KEYS.filter(key => key !== trigger)) } } : {}),
        ...pick(random, [{}, { additionalProperties: false }, { additionalProperties: { type: 'string' } }, { additionalProperties: child() }]),
        ...(!own && random() < 0.5 ? { patternProperties: { '^x': child() } } : {}),
        ...(random() < 0.2 ? { minProperties: 1 } : {}),
        ...(random() < 0.2 ? { maxProperties: 2 } : {}),
      };
    }
  }
}

/** A value made for `schema`, often valid: each required, dependent and some optional keys get a value of their schema. */
/** `value` with a key that only another branch declares, with a value that branch accepts. */
function withForeignKey(value: Record<string, unknown>, [key, schema]: readonly [string, unknown], random: () => number): Record<string, unknown> {
  return isPlainRecord(schema) ? { ...value, [key]: valueFor(schema, random) } : value;
}

/** `value` whose `key` is not in the JSON view: a non-enumerable own property, or a property of its prototype. */
function withHiddenKey(value: Record<string, unknown>, key: string, random: () => number): Record<string, unknown> {
  const { [key]: own, ...rest } = Object.getOwnPropertyDescriptors(value);
  if (own === undefined) return value;
  if (random() < 0.5) return Object.defineProperties({}, { ...rest, [key]: { ...own, enumerable: false } });
  return Object.defineProperties(Object.create(Object.defineProperties({}, { [key]: own })), rest);
}

function valueFor(schema: Record<string, unknown>, random: () => number): unknown {
  if (typeof schema.$ref === 'string') return valueFor(SHARED[schema.$ref], random);
  if (Array.isArray(schema.enum)) return copy(pick(random, schema.enum));
  if ('const' in schema) return copy(schema.const);
  if (schema.golemModelDate === true) return random() < 0.9 ? new Date(0) : new Date(Number.NaN);
  if (schema.golemModelInstance !== undefined) return random() < 0.8 ? new Cat() : new Dog();
  const branches = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(branches)) {
    const branch = pick(random, branches);
    const value = isPlainRecord(branch) ? valueFor(branch, random) : null;
    // Half the time a key that only another branch declares, with a value that branch accepts.
    const target = (entry: unknown): unknown => (isPlainRecord(entry) && typeof entry.$ref === 'string' ? SHARED[entry.$ref] : entry);
    const own = target(branch);
    const other = target(pick(random, branches.filter(entry => entry !== branch)));
    const declared = isPlainRecord(own) && isPlainRecord(own.properties) ? Object.keys(own.properties) : [];
    const foreign = isPlainRecord(other) && isPlainRecord(other.properties) ? Object.entries(other.properties).filter(([key]) => !declared.includes(key)) : [];
    const result = isPlainRecord(value) && foreign.length > 0 && random() < 0.5 ? withForeignKey(value, pick(random, foreign), random) : value;
    const tag = isPlainRecord(schema.discriminator) ? schema.discriminator.propertyName : undefined;
    return typeof tag === 'string' && isPlainRecord(result) && random() < 0.3 ? withHiddenKey(result, tag, random) : result;
  }
  if (schema.not !== undefined) return odd(random);
  if (typeof schema.format === 'string') return pick(random, [...FORMAT_SAMPLES[schema.format], FORMAT_SAMPLES[schema.format][0]]);
  switch (schema.type) {
    case 'string': return pick(random, ['x', 'ab', '']);
    case 'integer': return pick(random, [0, 1, -1]);
    case 'number': return pick(random, [0.5, 2]);
    case 'boolean': return random() < 0.5;
    case 'array': {
      const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems.filter(isPlainRecord) : [];
      const items = schema.items;
      const head = prefix.slice(0, Math.floor(random() * (prefix.length + 1))).map(item => valueFor(item, random));
      const tail = isPlainRecord(items) && head.length === prefix.length ? Array.from({ length: Math.floor(random() * 3) }, () => valueFor(items, random)) : [];
      return [...head, ...tail];
    }
    default: {
      const properties = isPlainRecord(schema.properties) ? schema.properties : {};
      const additional = schema.additionalProperties;
      const keys = new Set([...(Array.isArray(schema.required) ? schema.required : []), ...subset(random, Object.keys(properties))]);
      const value = Object.fromEntries([...keys].map(key => {
        const own = properties[key] ?? additional;
        return [key, isPlainRecord(own) ? valueFor(own, random) : 'x'];
      }));
      const pattern = isPlainRecord(schema.patternProperties) ? schema.patternProperties['^x'] : undefined;
      return isPlainRecord(pattern) && random() < 0.7 ? { ...value, x1: valueFor(pattern, random) } : value;
    }
  }
}

test('fast check equals the full validator in both directions on generated schemas and values made for them', async () => {
  const random = seeded(7);
  const schemas = Array.from({ length: 400 }, () => randomSchema(random, 0, true));
  const module = await compileValidatorModule({ roots: Object.fromEntries(schemas.map((schema, index) => [`s${index}`, schema])), resources: SHARED, fastPath: true });
  const cases = schemas.flatMap((schema, index) => {
    const sample = valueFor(schema, random);
    return [sample, ...oddValues(sample, 5000 + index, 30)].map(value => ({ root: `s${index}`, value }));
  });
  const disagreeing = cases.filter(({ root, value }) => outcome(() => module.byRoot[root](value, true).length === 0) !== outcome(() => module.fastByRoot[root](value)));
  assert.deepEqual(disagreeing.map(({ root, value }) => ({ root, schema: schemas[Number(root.slice(1))], value })), []);
  assert.equal(Object.keys(module.fastByRoot).length, schemas.length, 'every generated schema has a fast check');
  const verdicts = new Set(cases.map(({ root, value }) => outcome(() => module.fastByRoot[root](value))));
  assert.ok(verdicts.has(true) && verdicts.has(false), 'the values hold both valid and invalid ones');
});

test('with fastPath off the module exports no fast check and is the same as without the option', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string', format: 'date' } } };
  const plain = compile({ roots: new Map([['root', schema]]) }, { unknownFormats: 'warn' });
  const off = compile({ roots: new Map([['root', schema]]) }, { unknownFormats: 'warn', fastPath: false });
  assert.deepEqual({ source: off.source, fastExports: [...off.fastExports] }, { source: plain.source, fastExports: [] });
});
