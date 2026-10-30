import assert from 'node:assert/strict';
import test from 'node:test';

import { LibError } from '@exprtlabs/golem/errors';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { code, identifier, render, type Code } from '#golem/code';
import { emitArrayConversion, emitArrayItems, emitTupleConversion, type SequenceItem, type TupleConversionDescriptor } from '#golem/sequence-conversion';
import { instantiateRuntime } from './emitted-runtime.js';

const string: ModelTypeDescriptor = { kind: 'string' };
const number: ModelTypeDescriptor = { kind: 'number' };
const boolean: ModelTypeDescriptor = { kind: 'boolean' };
/** A class value that only its serde converts: the item converter of `deserializeConversion` reads it from text and rejects any other value. */
const stamp: ModelTypeDescriptor = { kind: 'class-value', typeName: 'Stamp' };
const nothing: ModelTypeDescriptor = { kind: 'null' };

/** Strings upper-case, numbers double and booleans flip, so each item shows which conversion ran on it. */
function valueItem(descriptor: ModelTypeDescriptor, value: Code): SequenceItem {
  if (descriptor.kind === 'string') return { code: code`(${value} as string).toUpperCase()`, throws: false };
  if (descriptor.kind === 'number') return { code: code`(${value} as number) * 2`, throws: false };
  if (descriptor.kind === 'boolean') return { code: code`!${value}`, throws: false };
  return { code: value, throws: false };
}

function jsonItem(descriptor: ModelTypeDescriptor, value: Code): SequenceItem {
  if (descriptor.kind === 'string') return { code: code`stringifyJsonString(${value} as string)`, throws: false };
  if (descriptor.kind === 'number') return { code: code`stringifyJsonNumber(${value} as number)`, throws: false };
  if (descriptor.kind === 'boolean') return { code: code`stringifyJsonBoolean(${value} as boolean)`, throws: false };
  return { code: code`stringifyJsonScalar(${value} as never)`, throws: false };
}

function stampItem(descriptor: ModelTypeDescriptor, value: Code): SequenceItem {
  return descriptor.kind === 'class-value'
    ? { code: code`(typeof ${value} === 'string' ? ${value}.toUpperCase() : rejectNonStringWire())`, throws: true }
    : { code: value, throws: false };
}

function tuple(items: TupleConversionDescriptor['items'], rest?: TupleConversionDescriptor['rest'], optionalFrom?: number): TupleConversionDescriptor {
  return { kind: 'tuple', items, ...(rest ? { rest } : {}), ...(optionalFrom === undefined ? {} : { optionalFrom }) };
}

/** Compile the emitted conversion of `input` into a function and return it. */
function compile(text: string): (input: unknown) => unknown {
  const { convert } = instantiateRuntime(`export function convert(input: unknown): unknown { return ${text}; }`);
  return (input) => convert(input);
}

function valueConversion(descriptor: TupleConversionDescriptor) {
  return compile(render(emitTupleConversion(descriptor, identifier('input'), { output: 'value', item: valueItem })));
}

function jsonConversion(descriptor: TupleConversionDescriptor) {
  return compile(render(emitTupleConversion(descriptor, identifier('input'), { output: 'json', item: jsonItem })));
}

function deserializeConversion(descriptor: TupleConversionDescriptor) {
  return compile(render(emitTupleConversion(descriptor, identifier('input'), { output: 'value', paths: 'deserialize', item: stampItem })));
}

function issuePath(action: () => unknown): readonly (string | number)[] | undefined {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof LibError);
    return error.issues[0]?.path;
  }
  return assert.fail('Expected the conversion to throw.');
}

test('a fixed tuple converts its declared items and keeps the extra items of a trusted call', () => {
  const convert = valueConversion(tuple([string, number]));
  assert.deepEqual(convert(['a', 2]), ['A', 4]);
  assert.deepEqual(convert(['a', 2, 'extra']), ['A', 4, 'extra']);
});

test('a tuple with an optional item keeps the length of a short input', () => {
  const convert = valueConversion(tuple([string, number], undefined, 1));
  assert.deepEqual(convert(['a']), ['A']);
  assert.deepEqual(convert(['a', 2]), ['A', 4]);
});

test('a rest tuple converts the items before the rest, the rest and the items after it by position', () => {
  const convert = valueConversion(tuple([string, boolean], { index: 1, item: number }));
  assert.deepEqual(convert(['p', 1, 2, true]), ['P', 2, 4, false]);
  assert.deepEqual(convert(['p', true]), ['P', false]);
});

test('a rest tuple whose items before the rest or the rest itself need no conversion converts the others in place', () => {
  assert.deepEqual(valueConversion(tuple([nothing, boolean], { index: 1, item: nothing }))([null, null, null, true]), [null, null, null, false]);
  assert.deepEqual(valueConversion(tuple([string, nothing], { index: 1, item: nothing }))(['p', null, null]), ['P', null, null]);
  assert.deepEqual(valueConversion(tuple([nothing], { index: 0, item: number }))([1, 2, null]), [2, 4, null]);
});

test('several items after the rest take the positions at the end of the input', () => {
  const convert = valueConversion(tuple([string, boolean], { index: 0, item: number }));
  assert.deepEqual(convert([1, 2, 'a', true]), [2, 4, 'A', false]);
  assert.deepEqual(convert(['a', true]), ['A', false]);
});

test('a short rest tuple input keeps its length', () => {
  const convert = valueConversion(tuple([string, boolean], { index: 1, item: number }));
  assert.deepEqual(convert(['only']), ['ONLY']);
  assert.deepEqual(convert([]), []);
});

test('a tuple that needs no conversion returns a new array of the same items', () => {
  const convert = valueConversion(tuple([nothing, nothing], { index: 1, item: nothing }));
  const input = [null, null, 'extra'];
  const output = convert(input);
  assert.deepEqual(output, [null, null, 'extra']);
  assert.notStrictEqual(output, input);
});

test('a value that is not an array passes through a value conversion', () => {
  assert.equal(valueConversion(tuple([string, number]))('text'), 'text');
});

test('a tuple writes JSON with each item in its own position', () => {
  assert.equal(jsonConversion(tuple([string, number]))(['a', 2, 'extra']), '["a",2,"extra"]');
  assert.equal(jsonConversion(tuple([string, number], undefined, 1))(['a']), '["a"]');
  const trailing = jsonConversion(tuple([string, boolean], { index: 1, item: number }));
  assert.equal(trailing(['p', 1, 2, true]), '["p",1,2,true]');
  assert.equal(trailing(['p', false]), '["p",false]');
  assert.equal(trailing(['only']), '["only"]');
  assert.equal(jsonConversion(tuple([number], { index: 0, item: number }))([1, 2]), '[1,2]');
});

test('a tuple with no conversion writes its items as JSON scalars and a non-array as one scalar', () => {
  const convert = jsonConversion(tuple([nothing, nothing]));
  assert.equal(convert([null, 'x']), '[null,"x"]');
  assert.equal(convert('text'), '"text"');
});

test('a failing tuple item names its position in the error path, before and after the rest', () => {
  const convert = deserializeConversion(tuple([string, stamp], { index: 1, item: stamp }));
  assert.deepEqual(convert(['a', 'b', 'c']), ['a', 'B', 'C']);
  assert.deepEqual(issuePath(() => convert(['a', 'b', 7, 'c'])), [2]);
  assert.deepEqual(issuePath(() => convert(['a', 'b', 'c', 'd', 7])), [4]);
  assert.deepEqual(issuePath(() => convert(['a', 7])), [1]);
});

test('an array converts each item and keeps a non-array as it is', () => {
  const convert = compile(render(emitArrayConversion(string, identifier('input'), { output: 'value', item: valueItem })));
  assert.deepEqual(convert(['a', 'b']), ['A', 'B']);
  assert.equal(convert('text'), 'text');
});

test('an array that needs no conversion returns a new array of the same items', () => {
  const convert = compile(render(emitArrayConversion(nothing, identifier('input'), { output: 'value', item: valueItem })));
  const input = [null, 'x'];
  const output = convert(input);
  assert.deepEqual(output, [null, 'x']);
  assert.notStrictEqual(output, input);
});

test('an array writes JSON with no guard', () => {
  const convert = compile(render(emitArrayConversion(string, identifier('input'), { output: 'json', item: jsonItem })));
  assert.equal(convert(['a', 'b']), '["a","b"]');
});

test('the items of a scalar-or-array union change the array and leave an unchanged array as it is', () => {
  const changed = compile(render(emitArrayItems(string, identifier('input'), { output: 'value', item: valueItem })));
  assert.deepEqual(changed(['a']), ['A']);
  const unchanged = compile(render(emitArrayItems(nothing, identifier('input'), { output: 'value', item: valueItem })));
  const input = [null];
  assert.strictEqual(unchanged(input), input);
});

test('a failing array item names its index, and a converter that takes the item only keeps its default path', () => {
  const convert = compile(render(emitArrayConversion(stamp, identifier('input'), { output: 'value', paths: 'deserialize', item: stampItem })));
  assert.deepEqual(convert(['a']), ['A']);
  assert.deepEqual(issuePath(() => convert(['a', 7])), [1]);
});

test('a rest tuple with only a failing rest item names the item index', () => {
  const convert = deserializeConversion(tuple([], { index: 0, item: stamp }));
  assert.deepEqual(issuePath(() => convert(['a', 7])), [1]);
});

test('an item after the rest that converts as the rest names its index like the rest', () => {
  const convert = deserializeConversion(tuple([stamp], { index: 0, item: stamp }));
  assert.deepEqual(convert(['a', 'b']), ['A', 'B']);
  assert.deepEqual(issuePath(() => convert([7, 'b'])), [0]);
  assert.deepEqual(issuePath(() => convert(['a', 7])), [1]);
});
