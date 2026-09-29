import assert from 'node:assert/strict';
import test from 'node:test';
import { defineModelProperty } from '@exprtlabs/codegen/conversion';

const ownData = (target: object, name: string) => Object.getOwnPropertyDescriptor(target, name);

test('defineModelProperty creates an own enumerable writable data property', () => {
  const target = {};
  defineModelProperty(target, 'x', 1);
  assert.deepEqual(ownData(target, 'x'), { value: 1, enumerable: true, configurable: true, writable: true });
});

test('defineModelProperty never invokes inherited setters or changes the prototype', () => {
  let calls = 0;
  class Base { set child(_value: unknown) { calls++; } }
  const target = new Base();
  defineModelProperty(target, 'child', 'value');
  defineModelProperty(target, '__proto__', 'data');
  assert.equal(calls, 0);
  assert.equal(Object.getPrototypeOf(target), Base.prototype);
  assert.deepEqual(ownData(target, 'child'), { value: 'value', enumerable: true, configurable: true, writable: true });
  assert.deepEqual(ownData(target, '__proto__'), { value: 'data', enumerable: true, configurable: true, writable: true });
});

test('defineModelProperty shadows inherited read-only properties and replaces own accessors', () => {
  const proto = Object.defineProperty({}, 'fixed', { value: 0, writable: false });
  const target: object = Object.create(proto);
  defineModelProperty(target, 'fixed', 5);
  assert.deepEqual(ownData(target, 'fixed'), { value: 5, enumerable: true, configurable: true, writable: true });
  const withAccessor = Object.defineProperty({}, 'name', { get: () => 'getter', configurable: true, enumerable: false });
  defineModelProperty(withAccessor, 'name', 'data');
  assert.deepEqual(ownData(withAccessor, 'name'), { value: 'data', enumerable: true, configurable: true, writable: true });
});

test('a setter added to a prototype after first use is still bypassed', () => {
  let calls = 0;
  class Late {}
  defineModelProperty(new Late(), 'value', 1);
  Object.defineProperty(Late.prototype, 'value', { set() { calls++; }, configurable: true });
  const target = new Late();
  defineModelProperty(target, 'value', 2);
  assert.equal(calls, 0);
  assert.equal(ownData(target, 'value')?.value, 2);
});
