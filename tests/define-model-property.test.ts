import assert from 'node:assert/strict';
import test from 'node:test';
import { defineModelFields, defineModelProperty, modelFieldsAssignable } from '@exprtlabs/golem/internal/model-runtime';

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

test('modelFieldsAssignable refuses a class whose prototype chain holds a field name, and defineModelFields skips undefined values', () => {
  // protects: F-33 a field named like a prototype member (an accessor, __proto__) is defined as data, never assigned
  class Plain {}
  class WithSetter { set child(_value: unknown) { /* never called by the generated constructor */ } }
  assert.equal(modelFieldsAssignable(Plain, ['id', 'name']), true);
  assert.equal(modelFieldsAssignable(WithSetter, ['id', 'child']), false);
  assert.equal(modelFieldsAssignable(class Inherits {}, ['id', '__proto__']), false);
  const target = {};
  defineModelFields(target, ['id', 'name', '__proto__'], [1, undefined, 'data']);
  assert.deepEqual(Object.keys(target), ['id', '__proto__']);
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
});
