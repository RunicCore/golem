import assert from 'node:assert/strict';
import { isObservableObject } from 'mobx';
import typia from 'typia';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { codecIdOf } from './codec-id.js';
import './typia-comparison.model.generated.js';
import type { Agreement, CompareCase, CompareTask, MobxTwins, Subject, TwinFactories, TwinKind } from './compare-case.js';
import { imodelTwins } from './typia-imodel.model.js';
import type {
  TCompareArray, TCompareFlat, TCompareItem, TCompareNested, TCompareOptional, TCompareTuple, TCompareUnion,
} from './typia-comparison.model.js';


/** The JSON form of a model value: a `Date` is an ISO string, everything else keeps its type. */
type Wire<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

/** Stands for a key removed from the initial data. */
const MISSING = Symbol('missing');

/**
 * A wrong value at a path of the initial data, or `MISSING` to remove the key. `onValue` sets it on the built value
 * instead, for a value that a twin's constructor refuses (an unknown union tag).
 */
interface Mutation { readonly path: readonly (string | number)[]; readonly value: unknown; readonly onValue?: true }

interface ModelSpec<T extends { id: number }> {
  readonly name: string;
  readonly codecId: string;
  readonly model: T;
  /** Values that both libraries must reject: a wrong type at the top level and one deeper. */
  readonly invalid: readonly unknown[];
  /** One wrong type that the validators meet early (the first field) and one that they meet late (the last field checked). */
  readonly early: Mutation;
  readonly late: Mutation;
  /** Edge values of the contract checks (finite numbers, valid Dates, required keys, union tags, tuple length), by name. */
  readonly probes: readonly (readonly [name: string, mutation: Mutation])[];
  readonly is: (value: unknown) => value is T;
  readonly assert: (value: unknown) => T;
  readonly equals: (value: unknown) => value is T;
  /** What a developer writes by hand: field by field, no validation, no generic walk. */
  readonly decode: (wire: Wire<T>) => T;
  readonly encode: (model: T) => Wire<T>;
}

const at = new Date('2026-10-01T12:00:00.000Z');
const address = (n: number) => ({ street: `${n} Main Street`, city: 'Springfield', zip: '12345', lat: 40.5 + n, lng: -73.9 - n });

function cloneModel<T>(model: T): T {
  return structuredClone(model);
}

function wireOf<T>(model: T): Wire<T> {
  return JSON.parse(JSON.stringify(model));
}

const flat: ModelSpec<TCompareFlat> = {
  name: 'flat',
  codecId: 'TCompareFlat',
  model: { id: 7, name: 'Ada Lovelace', email: 'ada@example.com', age: 36, score: 91.5, active: true, createdAt: at },
  invalid: [{ ...{ id: 7, name: 'Ada', email: 'a@b.c', age: 36, score: 1, active: true, createdAt: at }, age: '36' }, { id: 7 }],
  early: { path: ['id'], value: '7' },
  late: { path: ['createdAt'], value: 'not a date' },
  probes: [['NaN', { path: ['age'], value: Number.NaN }], ['Infinity', { path: ['score'], value: Number.POSITIVE_INFINITY }],
    ['invalid Date', { path: ['createdAt'], value: new Date(Number.NaN) }], ['missing key', { path: ['email'], value: MISSING }]],
  is: typia.createIs<TCompareFlat>(),
  assert: typia.createAssert<TCompareFlat>(),
  equals: typia.createEquals<TCompareFlat>(),
  decode: w => ({ id: w.id, name: w.name, email: w.email, age: w.age, score: w.score, active: w.active, createdAt: new Date(w.createdAt) }),
  encode: m => ({ id: m.id, name: m.name, email: m.email, age: m.age, score: m.score, active: m.active, createdAt: m.createdAt.toISOString() }),
};

const nested: ModelSpec<TCompareNested> = {
  name: 'nested',
  codecId: 'TCompareNested',
  model: { id: 11, owner: { name: 'Grace Hopper', email: 'grace@example.com', address: address(1) }, billing: address(2), shipping: address(3), createdAt: at },
  invalid: [
    { id: '11', owner: { name: 'G', email: 'g@e.c', address: address(1) }, billing: address(2), shipping: address(3), createdAt: at },
    { id: 11, owner: { name: 'G', email: 'g@e.c', address: { ...address(1), lat: 'north' } }, billing: address(2), shipping: address(3), createdAt: at },
  ],
  early: { path: ['id'], value: '11' },
  late: { path: ['shipping', 'lng'], value: 'north' },
  probes: [['NaN', { path: ['shipping', 'lat'], value: Number.NaN }], ['Infinity', { path: ['owner', 'address', 'lng'], value: Number.NEGATIVE_INFINITY }],
    ['invalid Date', { path: ['createdAt'], value: new Date(Number.NaN) }], ['missing key', { path: ['billing', 'zip'], value: MISSING }]],
  is: typia.createIs<TCompareNested>(),
  assert: typia.createAssert<TCompareNested>(),
  equals: typia.createEquals<TCompareNested>(),
  decode: w => ({
    id: w.id,
    owner: { name: w.owner.name, email: w.owner.email, address: { street: w.owner.address.street, city: w.owner.address.city, zip: w.owner.address.zip, lat: w.owner.address.lat, lng: w.owner.address.lng } },
    billing: { street: w.billing.street, city: w.billing.city, zip: w.billing.zip, lat: w.billing.lat, lng: w.billing.lng },
    shipping: { street: w.shipping.street, city: w.shipping.city, zip: w.shipping.zip, lat: w.shipping.lat, lng: w.shipping.lng },
    createdAt: new Date(w.createdAt),
  }),
  encode: m => ({
    id: m.id,
    owner: { name: m.owner.name, email: m.owner.email, address: { street: m.owner.address.street, city: m.owner.address.city, zip: m.owner.address.zip, lat: m.owner.address.lat, lng: m.owner.address.lng } },
    billing: { street: m.billing.street, city: m.billing.city, zip: m.billing.zip, lat: m.billing.lat, lng: m.billing.lng },
    shipping: { street: m.shipping.street, city: m.shipping.city, zip: m.shipping.zip, lat: m.shipping.lat, lng: m.shipping.lng },
    createdAt: m.createdAt.toISOString(),
  }),
};

// The middle member of three: neither the first nor the last check wins by position.
const union: ModelSpec<TCompareUnion> = {
  name: 'union',
  codecId: 'TCompareUnion',
  model: { id: 5, shape: { kind: 'rect', width: 3, height: 4, at } },
  invalid: [{ id: 5, shape: { kind: 'rect', width: '3', height: 4, at } }, { id: 5, shape: { kind: 'hexagon', at } }],
  early: { path: ['id'], value: '5' },
  late: { path: ['shape', 'at'], value: 'not a date' },
  probes: [['NaN', { path: ['shape', 'width'], value: Number.NaN }], ['invalid Date', { path: ['shape', 'at'], value: new Date(Number.NaN) }],
    ['null tag', { path: ['shape', 'kind'], value: null, onValue: true }], ['wrong tag', { path: ['shape', 'kind'], value: 'circle', onValue: true }],
    ['missing key', { path: ['shape', 'height'], value: MISSING }]],
  is: typia.createIs<TCompareUnion>(),
  assert: typia.createAssert<TCompareUnion>(),
  equals: typia.createEquals<TCompareUnion>(),
  decode: w => {
    const s = w.shape;
    switch (s.kind) {
      case 'circle': return { id: w.id, shape: { kind: 'circle', radius: s.radius, at: new Date(s.at) } };
      case 'rect': return { id: w.id, shape: { kind: 'rect', width: s.width, height: s.height, at: new Date(s.at) } };
      case 'label': return { id: w.id, shape: { kind: 'label', text: s.text, at: new Date(s.at) } };
    }
  },
  encode: m => {
    const s = m.shape;
    switch (s.kind) {
      case 'circle': return { id: m.id, shape: { kind: 'circle', radius: s.radius, at: s.at.toISOString() } };
      case 'rect': return { id: m.id, shape: { kind: 'rect', width: s.width, height: s.height, at: s.at.toISOString() } };
      case 'label': return { id: m.id, shape: { kind: 'label', text: s.text, at: s.at.toISOString() } };
    }
  },
};

const items: TCompareItem[] = Array.from({ length: 100 }, (_, i) => ({ id: i, sku: `SKU-${i}`, name: `Item ${i}`, price: 9.99 + i, quantity: i % 7, createdAt: at }));
const array: ModelSpec<TCompareArray> = {
  name: 'array',
  codecId: 'TCompareArray',
  model: { id: 3, items },
  invalid: [{ id: 3, items: 'none' }, { id: 3, items: items.map((item, i) => i === 99 ? { ...item, price: '9.99' } : item) }],
  early: { path: ['id'], value: '3' },
  late: { path: ['items', 99, 'price'], value: '9.99' },
  probes: [['NaN', { path: ['items', 50, 'price'], value: Number.NaN }], ['invalid Date', { path: ['items', 99, 'createdAt'], value: new Date(Number.NaN) }],
    ['missing key', { path: ['items', 10, 'sku'], value: MISSING }]],
  is: typia.createIs<TCompareArray>(),
  assert: typia.createAssert<TCompareArray>(),
  equals: typia.createEquals<TCompareArray>(),
  decode: w => ({ id: w.id, items: w.items.map(i => ({ id: i.id, sku: i.sku, name: i.name, price: i.price, quantity: i.quantity, createdAt: new Date(i.createdAt) })) }),
  encode: m => ({ id: m.id, items: m.items.map(i => ({ id: i.id, sku: i.sku, name: i.name, price: i.price, quantity: i.quantity, createdAt: i.createdAt.toISOString() })) }),
};

const tuple: ModelSpec<TCompareTuple> = {
  name: 'tuple',
  codecId: 'TCompareTuple',
  model: { id: 9, row: [1, 'one', true, at], range: [10, 20] },
  invalid: [{ id: 9, row: [1, 'one', true, at], range: [10] }, { id: 9, row: [1, 2, true, at], range: [10, 20] }],
  early: { path: ['id'], value: '9' },
  late: { path: ['range', 1], value: 'twenty' },
  probes: [['NaN', { path: ['row', 0], value: Number.NaN }], ['Infinity', { path: ['range', 0], value: Number.POSITIVE_INFINITY }],
    ['invalid Date', { path: ['row', 3], value: new Date(Number.NaN) }], ['tuple length', { path: ['range'], value: [10] }]],
  is: typia.createIs<TCompareTuple>(),
  assert: typia.createAssert<TCompareTuple>(),
  equals: typia.createEquals<TCompareTuple>(),
  decode: w => ({ id: w.id, row: [w.row[0], w.row[1], w.row[2], new Date(w.row[3])], range: [w.range[0], w.range[1]] }),
  encode: m => ({ id: m.id, row: [m.row[0], m.row[1], m.row[2], m.row[3].toISOString()], range: [m.range[0], m.range[1]] }),
};

const optional: ModelSpec<TCompareOptional> = {
  name: 'optional',
  codecId: 'TCompareOptional',
  model: { id: 13, name: 'Alan Turing', note: 'enigma', createdAt: at },
  invalid: [{ id: 13, name: 'A', nickname: 1, createdAt: at }, { id: 13 }],
  early: { path: ['id'], value: '13' },
  late: { path: ['createdAt'], value: 'not a date' },
  probes: [['Infinity', { path: ['id'], value: Number.POSITIVE_INFINITY }], ['invalid Date', { path: ['createdAt'], value: new Date(Number.NaN) }],
    ['missing key', { path: ['name'], value: MISSING }], ['wrong optional', { path: ['nickname'], value: 1 }]],
  is: typia.createIs<TCompareOptional>(),
  assert: typia.createAssert<TCompareOptional>(),
  equals: typia.createEquals<TCompareOptional>(),
  decode: w => ({ id: w.id, name: w.name, ...(w.nickname === undefined ? {} : { nickname: w.nickname }), ...(w.note === undefined ? {} : { note: w.note }), createdAt: new Date(w.createdAt) }),
  encode: m => ({ id: m.id, name: m.name, ...(m.nickname === undefined ? {} : { nickname: m.nickname }), ...(m.note === undefined ? {} : { note: m.note }), createdAt: m.createdAt.toISOString() }),
};

/** Each result is reduced to one number so a timed call cannot be dropped; every model has a numeric `id`, and a JSON text has a length. */
export function consume(value: unknown): number {
  if (value === true) return 1;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number') return value.id + 1;
  return 1;
}

function mutated(init: unknown, mutation: Mutation): unknown {
  const copy = structuredClone(init);
  let target = copy as Record<PropertyKey, unknown>;
  for (const key of mutation.path.slice(0, -1)) target = target[key] as Record<PropertyKey, unknown>;
  const last = mutation.path[mutation.path.length - 1];
  if (mutation.value === MISSING) delete target[last];
  else target[last] = mutation.value;
  return copy;
}

/** Sets the mutation's value on a built value, a class instance included, and returns that value. */
function setAt(value: object, mutation: Mutation): object {
  let target: unknown = value;
  for (const key of mutation.path.slice(0, -1)) target = typeof target === 'object' && target !== null ? Reflect.get(target, key) : undefined;
  if (typeof target !== 'object' || target === null || !Reflect.set(target, mutation.path[mutation.path.length - 1], mutation.value)) {
    throw new Error(`Cannot set ${mutation.path.join('.')} on the built value`);
  }
  return value;
}

/** A twin's value must be what its name says: every nested model a class instance, and observable for MobX. */
function assertInstances(value: unknown, twin: TwinKind, where: string): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => assertInstances(entry, twin, `${where}[${index}]`)); return; }
  if (typeof value !== 'object' || value === null || value instanceof Date) return;
  assert.notEqual(Object.getPrototypeOf(value), Object.prototype, `${where} is a plain object, not a class instance`);
  assert.equal(isObservableObject(value), twin === 'mobx', `${where} ${twin === 'mobx' ? 'is not observable' : 'is observable'}`);
  for (const [key, entry] of Object.entries(value)) assertInstances(entry, twin, `${where}.${key}`);
}

const specs = [flat, nested, union, array, tuple, optional] as const;

/** Every model in each form that exists: plain, IModel twin, MobX twin. A value is built from plain initial data. */
export function createSubjects(twins: MobxTwins): readonly Subject[] {
  const factories: readonly (readonly [TwinKind, TwinFactories | undefined])[] = [
    ['plain', undefined], ['imodel', imodelTwins], ['mobx', twins.mobx],
  ];
  return specs.flatMap(spec => factories.map(([twin, set]): Subject => {
    const factory = set?.[spec.name];
    if (set && !factory) throw new Error(`The ${twin} twin set has no model ${spec.name}`);
    const make = (init: unknown): object => (factory ? factory.make(init) : init as object);
    const valid = make(structuredClone(spec.model));
    if (twin !== 'plain') assertInstances(valid, twin, `${spec.name} ${twin} twin`);
    return {
      model: spec.name,
      twin,
      codecId: factory?.codecId ?? codecIdOf(spec.codecId),
      valid,
      early: make(mutated(spec.model, spec.early)),
      late: make(mutated(spec.model, spec.late)),
      extra: Object.assign(make(structuredClone(spec.model)), { unknownProperty: 1 }),
      probes: [
        ...spec.probes.map(([name, mutation]) => [name, mutation.onValue ? setAt(make(structuredClone(spec.model)), mutation) : make(mutated(spec.model, mutation))] as const),
        ['undefined unknown key', Object.assign(make(structuredClone(spec.model)), { unknownProperty: undefined })] as const,
      ],
      is: spec.is,
      equals: spec.equals,
    };
  }));
}

/**
 * golem `validate`, typia `is` and typia `equals` on each subject's probes. A valid value passes all three; a value
 * with a wrong field fails all three; an unknown property fails golem and `equals` and passes `is`, except on a class
 * instance, where golem takes it as program state and accepts it. This also answers
 * whether typia `equals` accepts a class instance of plain fields (the `valid` row of each twin).
 */
export function agreements(subjects: readonly Subject[]): Agreement[] {
  const rows: Agreement[] = [];
  for (const subject of subjects) {
    const codec = requireObjectCodec<object>(subject.codecId);
    // The unknown key of a class instance is program state, which golem accepts.
    const probes = [['valid', subject.valid, [true, true, true]], ['early', subject.early, [false, false, false]],
      ['late', subject.late, [false, false, false]], ['extra', subject.extra, [subject.twin !== 'plain', true, false]]] as const;
    for (const [probe, value, expected] of probes) {
      const golem = codec.validate(value);
      const typiaIs = subject.is(value);
      const typiaEquals = subject.equals(value);
      rows.push({ model: subject.model, twin: subject.twin, probe, golem, typiaIs, typiaEquals, agrees: golem === expected[0] && typiaIs === expected[1] && typiaEquals === expected[2] });
    }
  }
  return rows;
}

function check<T extends { id: number }>(spec: ModelSpec<T>): void {
  const codec = requireObjectCodec<T>(codecIdOf(spec.codecId));
  const wire = wireOf(spec.model);
  const where = (what: string) => `${spec.name}: ${what}`;
  // Valid input: every validator accepts it and returns the same value.
  assert.equal(codec.validate(spec.model), true, where('golem validate accepts'));
  assert.deepEqual(codec.assert(spec.model), spec.model, where('golem assert returns the value'));
  assert.equal(spec.is(spec.model), true, where('typia is accepts'));
  assert.deepEqual(spec.assert(spec.model), spec.model, where('typia assert returns the value'));
  assert.equal(spec.equals(spec.model), true, where('typia equals accepts'));
  // Invalid input: every validator rejects it.
  for (const bad of spec.invalid) {
    assert.equal(codec.validate(bad), false, where('golem validate rejects'));
    assert.throws(() => codec.assert(bad), Error, where('golem assert throws'));
    assert.equal(spec.is(bad), false, where('typia is rejects'));
    assert.throws(() => spec.assert(bad), Error, where('typia assert throws'));
    assert.equal(spec.equals(bad), false, where('typia equals rejects'));
  }
  // An unknown property: golem and typia equals reject it, typia is accepts it.
  const extra = { ...cloneModel(spec.model), unknownProperty: 1 };
  assert.equal(codec.validate(extra), false, where('golem validate rejects an unknown property'));
  assert.equal(spec.equals(extra), false, where('typia equals rejects an unknown property'));
  assert.equal(spec.is(extra), true, where('typia is accepts an unknown property'));
  // Decode and encode: golem, golem without validation and the hand-written code agree.
  assert.deepEqual(codec.fromWireFormat(wire), spec.model, where('golem decode'));
  assert.deepEqual(codec.fromWireFormat(wire, { validate: false }), spec.model, where('golem decode, no validation'));
  assert.deepEqual(spec.decode(wire), spec.model, where('hand-written decode'));
  assert.deepEqual(codec.toWireFormat(spec.model), wire, where('golem encode'));
  assert.deepEqual(codec.toWireFormat(spec.model, { validate: false }), wire, where('golem encode, no validation'));
  assert.deepEqual(spec.encode(spec.model), wire, where('hand-written encode'));
  // Parse and stringify: the text round trip of the same three sides.
  const text = JSON.stringify(wire);
  assert.deepEqual(codec.parse(text), spec.model, where('golem parse'));
  assert.deepEqual(spec.decode(JSON.parse(text)), spec.model, where('hand-written parse'));
  assert.deepEqual(JSON.parse(codec.stringify(spec.model)), wire, where('golem stringify'));
  assert.deepEqual(JSON.parse(JSON.stringify(spec.encode(spec.model))), wire, where('hand-written stringify'));
}

function casesOf<T extends { id: number }>(spec: ModelSpec<T>): CompareCase[] {
  // Resolve the codec once, as the other fixtures do; timed calls do only the work.
  const codec = requireObjectCodec<T>(codecIdOf(spec.codecId));
  const { model } = spec;
  const wire = wireOf(model);
  const text = JSON.stringify(wire);
  const off = { validate: false };
  const entry = (task: CompareTask, side: string, run: () => unknown): CompareCase => ({ model: spec.name, twin: 'plain', task, side, run });
  return [
    entry('validate', 'golem validate', () => codec.validate(model)),
    entry('validate', 'golem assert', () => codec.assert(model)),
    entry('validate', 'typia is', () => spec.is(model)),
    entry('validate', 'typia assert', () => spec.assert(model)),
    entry('validate', 'typia equals', () => spec.equals(model)),
    entry('decode', 'golem fromWireFormat', () => codec.fromWireFormat(wire)),
    entry('decode', 'golem fromWireFormat, validate off', () => codec.fromWireFormat(wire, off)),
    entry('decode', 'hand-written', () => spec.decode(wire)),
    entry('encode', 'golem toWireFormat', () => codec.toWireFormat(model)),
    entry('encode', 'golem toWireFormat, validate off', () => codec.toWireFormat(model, off)),
    entry('encode', 'hand-written', () => spec.encode(model)),
    entry('parse', 'golem parse', () => codec.parse(text)),
    entry('parse', 'golem parse, validate off', () => codec.parse(text, off)),
    entry('parse', 'hand-written', () => spec.decode(JSON.parse(text))),
    entry('stringify', 'golem stringify', () => codec.stringify(model)),
    entry('stringify', 'golem stringify, validate off', () => codec.stringify(model, off)),
    entry('stringify', 'hand-written', () => JSON.stringify(spec.encode(model))),
  ];
}

/** The twins' valid-value cases and the failing-value cases of every subject: golem `validate` against typia, and the IModel flat encode. */
function subjectCases(subject: Subject): CompareCase[] {
  const codec = requireObjectCodec<object>(subject.codecId);
  const entry = (task: CompareTask, side: string, run: () => unknown): CompareCase => ({ model: subject.model, twin: subject.twin, task, side, run });
  const { valid, early, late } = subject;
  return [
    // New in the instance-state change, so the base commit has no value for these two rows: the encode of an IModel instance
    // with its fields only and with program state (the unknown key of `extra`).
    ...(subject.twin === 'imodel' && subject.model === 'flat' ? [
      entry('encode', 'golem toWireFormat', () => codec.toWireFormat(valid)),
      entry('encode', 'golem toWireFormat, program state', () => codec.toWireFormat(subject.extra)),
    ] : []),
    ...(subject.twin === 'plain' ? [] : [
      entry('validate', 'golem validate', () => codec.validate(valid)),
      entry('validate', 'typia is', () => subject.is(valid)),
      entry('validate', 'typia equals', () => subject.equals(valid)),
    ]),
    entry('fail-early', 'golem validate', () => codec.validate(early)),
    entry('fail-early', 'typia equals', () => subject.equals(early)),
    entry('fail-late', 'golem validate', () => codec.validate(late)),
    entry('fail-late', 'typia equals', () => subject.equals(late)),
  ];
}

/** Each library's own checks: valid and invalid input, and the agreement of decode and encode. Run before timing. */
export function verifyCompareModels(): void {
  check(flat); check(nested); check(union); check(array); check(tuple); check(optional);
}

export function createCompareCases(twins: MobxTwins): readonly CompareCase[] {
  return [...[casesOf(flat), casesOf(nested), casesOf(union), casesOf(array), casesOf(tuple), casesOf(optional)].flat(), ...createSubjects(twins).flatMap(subjectCases)];
}
