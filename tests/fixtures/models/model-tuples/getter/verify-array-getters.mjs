import assert from 'node:assert/strict';
import { TSnapshotBaseModel } from './build/snapshot.model.generated.js';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';

const codecId = process.argv[2];
assert.ok(codecId, 'generated Snapshot codec ID is required');
const codec = requireObjectCodec(codecId);

function trackedArray(values, labels, order) {
  for (const [index, value] of values.entries()) {
    Object.defineProperty(values, String(index), { get() { order.push(labels[index]); return value; }, enumerable: true });
  }
  return values;
}

function getterModel(onChoiceRead, label = 'first-label') {
  const reads = { names: 0, pair: 0, trailing: 0, required: 0, optional: 0, nested: 0, choice: 0, createdAt: 0 };
  const order = [];
  const names = trackedArray(['n'], ['names:item'], order);
  const pair = trackedArray(['p'], ['pair:item'], order);
  const trailing = trackedArray(['t', false], ['trailing:head', 'trailing:tail'], order);
  const createdAt = new Date('2026-09-24T00:00:00.000Z');
  const nested = Object.create({
    get choice() {
      reads.choice++;
      order.push('nested.choice');
      onChoiceRead?.();
      return reads.choice === 1 ? 'first-nested' : 'later-nested';
    },
  });
  Object.defineProperty(nested, 'label', { value: label, enumerable: true });
  const prototype = Object.create(TSnapshotBaseModel.prototype);
  Object.defineProperties(prototype, {
    names: { get() { reads.names++; order.push('names:get'); return reads.names === 1 ? names : ['later-names']; } },
    pair: { get() { reads.pair++; order.push('pair:get'); return reads.pair === 1 ? pair : ['later-pair']; } },
    trailing: { get() { reads.trailing++; order.push('trailing:get'); return reads.trailing === 1 ? trailing : ['later-trailing', true]; } },
    required: { get() { reads.required++; order.push('required:get'); return reads.required === 1 ? 'first-required' : 'later-required'; } },
    optional: { get() { reads.optional++; order.push('optional:get'); return reads.optional === 1 ? 'first-optional' : 'later-optional'; } },
    nested: { get() { reads.nested++; order.push('nested:get'); return reads.nested === 1 ? nested : {}; } },
    createdAt: { get() { reads.createdAt++; order.push('createdAt:get'); return createdAt; } },
  });
  const value = Object.create(prototype);
  return { value, reads, order };
}

const expectedReads = { names: 1, pair: 1, trailing: 1, required: 1, optional: 1, nested: 1, choice: 1, createdAt: 1 };
const expectedOrder = ['names:get', 'names:item', 'pair:get', 'pair:item', 'trailing:get', 'trailing:head', 'trailing:tail', 'required:get', 'optional:get', 'nested:get', 'nested.choice', 'createdAt:get'];
const expectedWire = {
  names: ['n'],
  pair: ['p'],
  trailing: ['t', false],
  required: 'first-required',
  optional: 'first-optional',
  nested: { choice: 'first-nested', label: 'first-label' },
  createdAt: '2026-09-24T00:00:00.000Z',
};

const stringifyCase = getterModel();
assert.equal(Object.hasOwn(stringifyCase.value, 'optional'), false);
const text = codec.stringify(stringifyCase.value, { validate: false });
assert.deepEqual(JSON.parse(text), expectedWire);
assert.deepEqual(stringifyCase.reads, expectedReads);
assert.deepEqual(stringifyCase.order, expectedOrder);

let reentered = false;
const wireCase = getterModel(() => {
  if (reentered) return;
  reentered = true;
  const nestedCase = getterModel(undefined, 'inner-label');
  const nestedWire = codec.toWireFormat(nestedCase.value, { validate: false });
  assert.deepEqual(nestedWire.nested, { choice: 'first-nested', label: 'inner-label' });
  assert.deepEqual(nestedCase.reads, expectedReads);
});
const wire = codec.toWireFormat(wireCase.value, { validate: false });
assert.deepEqual(wire, expectedWire);
assert.deepEqual(wireCase.reads, expectedReads);
assert.deepEqual(wireCase.order, expectedOrder);
assert.equal(reentered, true);
