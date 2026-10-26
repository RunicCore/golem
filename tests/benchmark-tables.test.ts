import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResultCase } from '../scripts/benchmark/results-schema.js';
import { costTable, releaseVerdict } from '../scripts/benchmark/tables.js';

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

// protects: T-235 a row exists only for a pair that a run timed
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

const pair = (base: number, head: number) => ({ base, head });
/** A case whose two halves of the rounds run at `first` and `second` of a base of 100, and the session at their mean. */
const release = (key: string, first: number, second: number = first) =>
  ({ key, ...pair(100, (first + second) / 2), halves: [pair(100, first), pair(100, second)] });

// protects: F-159 the bench:release check stops, and names the case, when a case runs below the base by more than the band in both halves
test('the release verdict stops when a case runs below the base by more than the band in both halves, and names it', () => {
  const verdict = releaseVerdict([release('simple/parse/golem', 101), release('simple/decode/golem', 80)], 0.1);
  assert.equal(verdict.verdict, 'stop');
  assert.deepEqual(verdict.failing.map(r => [r.key, r.ratio, r.halfRatios]), [['simple/decode/golem', 0.8, [0.8, 0.8]]]);
});

// protects: F-159 the bench:release check passes a drop in one half only, a drop inside the band, any gain, and a ratio exactly at one minus the band
test('the release verdict passes a drop in one half only, inside the band, a gain, and a ratio at one minus the band', () => {
  const passed = releaseVerdict([release('simple/parse/golem', 70, 100), release('simple/encode/golem', 100, 70)], 0.1);
  assert.deepEqual([passed.verdict, passed.failing], ['pass', []]);
  assert.equal(releaseVerdict([release('a/b/golem', 95), release('a/c/golem', 50), release('a/d/golem', 300)], 0.5).verdict, 'pass');
  assert.equal(releaseVerdict([release('a/b/golem', 49.9)], 0.5).verdict, 'stop');
});

// protects: F-159 the bench:release check never passes on no data or an unusable timing or band
test('the release verdict refuses to pass a check that compared nothing or has no usable band or timing', () => {
  assert.throws(() => releaseVerdict([], 0.1), /no case was timed on both sides/);
  assert.throws(() => releaseVerdict([release('a/b/golem', 100)], Number.NaN), /noise band is NaN/);
  assert.throws(() => releaseVerdict([{ key: 'a/b/golem', ...pair(0, 100), halves: [pair(0, 100)] }], 0.1), /invalid timing for a\/b\/golem/);
});
