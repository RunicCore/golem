import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResultCase } from '../scripts/benchmark/results-schema.js';
import { compareTable, costTable, rankSpeeds } from '../scripts/benchmark/tables.js';

const timed = (payload: string, operation: string, adapter: string, median: number): ResultCase =>
  ({ payload, operation, adapter, support: 'full', opsPerSec: { median, min: median, max: median } });
const row = (results: Parameters<typeof costTable>[0], payload: string, operation: string) =>
  costTable(results).find(r => r.payload === payload && r.operation === operation);
const ops = (value: number) => ({ kind: 'ops', value });
const ratio = (value: number) => ({ kind: 'ratio', value });

// protects: T-235 each ratio cell of the validation columns, read from compare and cost timings together
test('the cost table divides validation on by validation off and IModel by IObject, from both timing lists', () => {
  const results = {
    cases: [timed('simple', 'parse', 'golem', 200), timed('simple', 'parse', 'golem-validated', 100), timed('simple', 'parse', 'golem-object', 40)],
    cost: { cases: [timed('simple', 'parse', 'golem-object-off', 80), timed('simple', 'decode', 'golem', 90), timed('simple', 'decode', 'golem-validated', 45)] },
  };
  assert.deepEqual(row(results, 'simple', 'parse'), {
    payload: 'simple', operation: 'parse',
    imodelOff: ops(200), imodelOn: ops(100), imodelOnOverOff: ratio(0.5),
    iobjectOff: ops(80), iobjectOn: ops(40), iobjectOnOverOff: ratio(0.5), imodelOverIobject: ratio(2.5), serdeManyOverNone: { kind: 'not-applicable' }, invalidOverValid: { kind: 'not-run' },
  });
  assert.deepEqual(row(results, 'simple', 'decode'), {
    payload: 'simple', operation: 'decode',
    imodelOff: ops(90), imodelOn: ops(45), imodelOnOverOff: ratio(0.5),
    iobjectOff: { kind: 'not-run' }, iobjectOn: { kind: 'not-run' }, iobjectOnOverOff: { kind: 'not-run' }, imodelOverIobject: { kind: 'not-run' }, serdeManyOverNone: { kind: 'not-applicable' }, invalidOverValid: { kind: 'not-run' },
  });
});

// protects: T-235 validate has no off mode
test('the cost table shows validate off and both on/off ratios as not applicable, and still divides IModel by IObject', () => {
  const results = { cases: [timed('nested', 'validate', 'golem-validated', 100), timed('nested', 'validate', 'golem-object', 50)] };
  assert.deepEqual(row(results, 'nested', 'validate'), {
    payload: 'nested', operation: 'validate',
    imodelOff: { kind: 'not-applicable' }, imodelOn: ops(100), imodelOnOverOff: { kind: 'not-applicable' },
    iobjectOff: { kind: 'not-applicable' }, iobjectOn: ops(50), iobjectOnOverOff: { kind: 'not-applicable' }, imodelOverIobject: ratio(2), serdeManyOverNone: { kind: 'not-applicable' }, invalidOverValid: { kind: 'not-run' },
  });
});

test('the cost table has no row for a payload or operation that no run timed', () => {
  const results = { cases: [timed('simple', 'parse', 'golem', 200)] };
  assert.deepEqual(costTable(results).map(r => `${r.payload}/${r.operation}`), ['simple/parse']);
});

// protects: T-237 the serde column divides serde-many by serde-none on the serde-many rows only, IModel with validation on
test('the cost table divides serde-many by serde-none for the same operation on the serde-many rows, and nowhere else', () => {
  const results = {
    cases: [],
    cost: { cases: [
      timed('serde-many', 'decode', 'golem-validated', 30), timed('serde-none', 'decode', 'golem-validated', 120),
      timed('serde-many', 'decode', 'golem', 60), timed('serde-many', 'encode', 'golem-validated', 50),
    ] },
  };
  assert.deepEqual(costTable(results).map(r => [r.payload, r.operation, r.serdeManyOverNone]), [
    ['serde-none', 'decode', { kind: 'not-applicable' }],
    ['serde-many', 'decode', ratio(0.25)],
    ['serde-many', 'encode', { kind: 'not-run' }],
  ]);
});

// protects: T-239 order, shared rank inside the noise band, separate rank outside it
test('rank orders the libraries by speed and lets a library inside the band share the rank of the fastest of its run', () => {
  assert.deepEqual(rankSpeeds([80, 100, 96], 0.05), [3, 1, 1]);
  assert.deepEqual(rankSpeeds([100, 90], 0.05), [1, 2]);
  assert.deepEqual(rankSpeeds([100, 95], 0.05), [1, 1], 'a ratio of exactly 1 - band is a tie');
});

// protects: T-239 the tie chain rule: a tie is anchored at the fastest library of the run, never chained
test('a library inside the band of its neighbour but outside the band of the fastest starts the next run', () => {
  // 96 ties 100, and 92 ties 96 (0.958), but 92 is outside the band of 100 (0.92 < 0.95): it takes its own rank.
  assert.deepEqual(rankSpeeds([100, 96, 92], 0.05), [1, 1, 3]);
  assert.deepEqual(rankSpeeds([100, 96, 92, 91], 0.05), [1, 1, 3, 3]);
});

// protects: T-239 a file with no noise band ranks without ties
test('rank gives every library its own rank when the results have no noise band', () => {
  assert.deepEqual(rankSpeeds([100, 99.9], undefined), [1, 2]);
});

const adapters = ['typia', 'zod'].map(id => ({ id, group: 'plain', label: id, library: id, checked: true, sourceUrl: '' }));
const payloads = ['simple', 'checkout'].map(id => ({ id, label: id, bytes: 1, description: '', sourceUrl: '' }));
const unsupported = (payload: string, operation: string, adapter: string): ResultCase => ({ payload, operation, adapter, support: 'none', note: 'no conversion' });

// protects: T-239 the compare table ranks per row inside the group, skips unsupported cells and sums up with n of m
test('the compare table ranks each row, leaves an unsupported row out of the summary, and scores with n of m', () => {
  const cases = [
    timed('simple', 'parse', 'typia', 400), timed('simple', 'parse', 'zod', 100),
    timed('simple', 'stringify', 'typia', 100), timed('simple', 'stringify', 'zod', 98),
    unsupported('checkout', 'parse', 'typia'), timed('checkout', 'parse', 'zod', 50),
  ];
  const table = compareTable({ cases, adapters, payloads, noise: { loadAverage: { start: [0, 0, 0], end: [0, 0, 0] }, controlSpread: 0.05 } });
  assert.equal(table.band, 0.05);
  assert.deepEqual(table.groups.map(g => g.id), ['plain']);
  const [plain] = table.groups;
  assert.deepEqual(plain.rows.map(r => [r.payload, r.operation, r.cells.map(c => c.cell.kind === 'ops' ? c.cell.rank : c.cell.kind)]), [
    ['simple', 'parse', [1, 2]],
    ['simple', 'stringify', [1, 1]],
    ['checkout', 'parse', ['not-supported', 1]],
  ]);
  const zod = plain.summary.find(s => s.adapter === 'zod');
  // Zod's speed over the leader: 100 / 400 = 0.25 and 98 / 100 = 0.98; the geometric mean is sqrt(0.245).
  assert.ok(zod?.score !== undefined && Math.abs(zod.score - Math.sqrt(0.245)) < 1e-12);
  assert.deepEqual([zod?.rows, zod?.of], [2, 3]);
  assert.deepEqual(plain.summary.find(s => s.adapter === 'typia')?.rows, 2);
});

// protects: T-239 a library that does less work carries a mark
test('the compare table marks the cells of a library that does less work', () => {
  const classValidator = [{ id: 'class-validator', group: 'validated-classes', label: 'class-validator', library: 'class-validator', checked: true, sourceUrl: '' }];
  const table = compareTable({ cases: [timed('simple', 'parse', 'class-validator', 100)], adapters: classValidator, payloads, noise: undefined });
  const cell = table.groups[0].rows[0].cells[0].cell;
  assert.deepEqual(cell, { kind: 'ops', value: 100, rank: 1, mark: 'does not reject unknown properties' });
  assert.equal(table.band, undefined);
});

// protects: T-242 the invalid/valid column divides the invalid timing by the valid one for the reading operations only
test('the cost table divides invalid input by valid input for parse, decode and validate, and shows not applicable for stringify and encode', () => {
  const results = {
    cases: [timed('simple', 'parse', 'golem-validated', 100), timed('simple', 'stringify', 'golem-validated', 100), timed('simple', 'validate', 'golem-validated', 80)],
    cost: { cases: [timed('simple', 'decode', 'golem-validated', 200), timed('simple', 'encode', 'golem-validated', 300)] },
    invalid: { cases: [timed('simple', 'parse', 'golem-validated', 25), timed('simple', 'decode', 'golem-validated', 50), timed('simple', 'validate', 'golem-validated', 80)] },
  };
  assert.deepEqual(costTable(results).map(r => [r.operation, r.invalidOverValid]), [
    ['parse', ratio(0.25)],
    ['stringify', { kind: 'not-applicable' }],
    ['decode', ratio(0.25)],
    ['encode', { kind: 'not-applicable' }],
    ['validate', ratio(1)],
  ]);
  assert.deepEqual(costTable({ ...results, invalid: undefined }).map(r => r.invalidOverValid.kind), ['not-run', 'not-applicable', 'not-run', 'not-applicable', 'not-run']);
});
