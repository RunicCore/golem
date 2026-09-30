import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloneConversionInput, decodeGeneratedModel, decodeGeneratedModelTrusted, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { parseJson } from '@exprtlabs/codegen/serde';
import { registerGeneratedModel, type GeneratedModel } from '@exprtlabs/codegen/model';
import { LibError, LibErrorKind, IssueCode, IssueSource, IssueRepresentation } from '@exprtlabs/codegen/errors';

function cycleAt(path: readonly (string | number)[]): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Deserialization);
    assert.equal(error.issues[0]?.code, IssueCode.Deserialization);
    assert.equal(error.issues[0]?.source, IssueSource.Serde);
    assert.equal(error.issues[0]?.representation, IssueRepresentation.Wire);
    assert.deepEqual(error.issues[0]?.path, path);
    return true;
  };
}

test('input isolation detects a later sibling cycle before decoder or constructor effects', () => {
  let constructions = 0;
  let decodes = 0;
  class RecordModel {
    constructor(public payload: unknown) { constructions++; }
  }
  registerGeneratedModel(RecordModel, {
    fields: ['payload'], profile: { validation: false },
    conversion: {
      decode(value) {
        decodes++;
        return new RecordModel(Reflect.get(value as object, 'payload'));
      },
      encode(model) { return { payload: model.payload }; },
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.again = cycle;
  const input = { payload: [{ valid: 1 }, { last: cycle }] };
  assert.throws(() => decodeGeneratedModel(RecordModel, input), cycleAt(['payload', 1, 'last', 'again']));
  assert.equal(decodes, 0);
  assert.equal(constructions, 0);
  assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(RecordModel, { payload: { valid: 2 } }) as RecordModel & GeneratedModel), { payload: { valid: 2 } });
  assert.equal(constructions, 1);
});

test('isolation keeps ordinary records and prototype-sensitive own fields without merging aliases', () => {
  const shared = { value: 3 };
  const input = JSON.parse('{"__proto__":{"flag":true},"constructor":"data"}') as Record<string, unknown>;
  input.first = shared;
  input.second = shared;
  const result = cloneConversionInput(input) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.deepEqual(result.__proto__, { flag: true });
  assert.equal(result.constructor, 'data');
  assert.notStrictEqual(result.first, shared);
  assert.notStrictEqual(result.first, result.second);
  Reflect.set(result.first as object, 'value', 4);
  assert.equal(shared.value, 3);
  assert.deepEqual(result.second, { value: 3 });
  assert.equal(Object.hasOwn(result, 'optional'), false);
});

test('retained model instances are still traversed for cycles during isolation', () => {
  class Node { child: unknown; }
  registerGeneratedModel(Node, { fields: ['child'], profile: { validation: false }, conversion: {
    decode: () => new Node(), encode: model => ({ child: model.child }),
  } });
  const child = new Node();
  child.child = { back: child };
  assert.throws(() => cloneConversionInput({ child }), cycleAt(['child', 'child', 'back']));
  child.child = { leaf: 1 };
  const copy = cloneConversionInput({ child }) as { child: Node };
  assert.strictEqual(copy.child, child);
});

test('trusted nested decode skips isolation because the caller already detached the tree', () => {
  let calls = 0;
  class Counter { constructor(public value: number) {} }
  registerGeneratedModel(Counter, { fields: ['value'], profile: { validation: false }, conversion: {
    decode(input) {
      calls++;
      const nested = Reflect.get(input as object, 'nested') as { value: number };
      nested.value += 1;
      return new Counter(nested.value);
    },
    encode: model => ({ value: model.value }),
  } });
  const input = { nested: { value: 1 } };
  assert.equal(decodeGeneratedModel(Counter, input).value, 2);
  assert.equal(input.nested.value, 1);
  assert.equal(decodeGeneratedModel(Counter, parseJson(JSON.stringify(input)) as object).value, 2);
  assert.equal(calls, 2);
  const trusted = { nested: { value: 1 } };
  assert.equal(decodeGeneratedModelTrusted(Counter, trusted).value, 2);
  assert.equal(trusted.nested.value, 2);
});

test('isolation snapshots sibling getters, keeps own __proto__ data and ignores enumerable symbol getters', () => {
  let symbolCalls = 0;
  const input = { first: {} as object, later: { value: 1 } };
  Object.defineProperty(input.first, 'change', { enumerable: true, get() {
    input.later = { value: 9 };
    return 2;
  } });
  Object.defineProperty(input, '__proto__', {
    value: { flag: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(input, Symbol('excluded'), { enumerable: true, get() {
    symbolCalls++;
    throw new Error('Symbol input should not be read');
  } });
  const copy = cloneConversionInput(input) as typeof input;
  assert.deepEqual(copy.later, { value: 1 });
  assert.deepEqual(input.later, { value: 9 });
  assert.equal(symbolCalls, 0);
  assert.equal(Object.getOwnPropertySymbols(copy).length, 0);
  assert.strictEqual(Object.getPrototypeOf(copy), Object.prototype);
  assert.equal(Object.hasOwn(copy, '__proto__'), true);
  assert.deepEqual(Reflect.get(copy, '__proto__'), { flag: true });
});


test('decode cycle tracking retains multiple contracts and recovers after failure', () => {
  let recurse = true;
  class First {}
  class Second {}
  class Third {}
  registerGeneratedModel(First, { fields: [], profile: { validation: false }, conversion: {
    decode(input) { decodeGeneratedModel(Second, input); return new First(); }, encode: () => ({}),
  } });
  registerGeneratedModel(Second, { fields: [], profile: { validation: false }, conversion: {
    decode(input) { decodeGeneratedModel(Third, input); return new Second(); }, encode: () => ({}),
  } });
  registerGeneratedModel(Third, { fields: [], profile: { validation: false }, conversion: {
    decode(input) { if (recurse) decodeGeneratedModel(First, input); return new Third(); }, encode: () => ({}),
  } });
  const input = {};
  assert.throws(() => decodeGeneratedModel(First, input), error => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Deserialization);
    return true;
  });
  recurse = false;
  assert.ok(decodeGeneratedModel(First, input) instanceof First);
  assert.ok(decodeGeneratedModel(Second, input) instanceof Second);
});
