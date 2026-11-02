import assert from 'node:assert/strict';
import test from 'node:test';

import { isMultipleOf } from '@exprtlabs/golem/internal/validation-runtime';
import { compileSchema, compileValidatorModule } from './support/compiled-validators.js';

type MultipleOf = (value: number, divisor: number, units?: number, scale?: number) => boolean;

/** The runtime `isMultipleOf` and the generated fast form `isMultipleOfScaled`, read from a compiled module; the fast form falls back to the runtime function. */
async function generatedHelpers(): Promise<{ exact: MultipleOf; scaled: MultipleOf }> {
  const { source } = await compileValidatorModule({ roots: { root: { type: 'number', multipleOf: 0.1 } } });
  const scaled = /function (\w+)\(value, divisor, units, scale\) \{\n[\s\S]*?\n\}/.exec(source);
  assert.ok(scaled !== null);
  const fallback = /return ([\w$]+)\(value, divisor\);/.exec(scaled[0]);
  assert.ok(fallback !== null);
  return { exact: isMultipleOf, scaled: new Function(fallback[1]!, `${scaled[0]}\nreturn ${scaled[1]};`)(isMultipleOf) };
}

/** Divisors the compiler writes in the scaled form: the divisor, its `units` and its `scale`. */
const ROWS: readonly (readonly [divisor: number, units: number, scale: number])[] = [
  [0.1, 1, 10], [0.2, 2, 10], [1.5, 15, 10], [0.25, 25, 100], [0.001, 1, 1000], [0.123456789, 123456789, 1e9], [1.5e-7, 15, 1e8], [1e-22, 1, 1e22],
];

const VALUES: readonly number[] = [
  0, -0, 0.1, -0.3, 0.3, 0.35, 0.30000000000000004, 3.000000000000001, 19.99, 0.0075, 1e-7, 3e-7, 1.5e-7, 5e-324, 1e-22, 3e-22, 1e-23, 1, 7, -7, 1e15, 1e21, 1.5e21, 1e300,
  Number.MAX_VALUE, -Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 2 ** 53, 2 ** 53 + 2,
  4503599627370495, 4503599627370495.5, 4503599627370496, 2251799813685247.25, 562949953421312.25, 8595756.71190207, 8820007.45060213, 12345678.9, 0.246913578,
];

test('the scaled multipleOf form answers as the exact function for literal values and for values from a fixed seed', async () => {
  // protects: R-63 MultipleOf with a decimal divisor runs faster with identical results
  const { exact, scaled } = await generatedHelpers();
  let state = 20261029;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const whole = () => (next() >>> 11) * 2 ** 32 + next();
  const generated = Array.from({ length: 8000 }, (_, index) => (index % 2 === 0 ? 1 : -1) * (index % 3 === 0 ? (whole() / 2 ** 53) * 10 ** (next() % 25 - 5) : whole() / 10 ** [0, 1, 2, 3, 7, 9, 12][index % 7]));
  const differing = ([divisor, units, scale]: (typeof ROWS)[number]) => [...VALUES, ...generated, ...generated.slice(0, 2000).map(value => Math.round(value * scale / units) * units / scale)]
    .filter(value => scaled(value, divisor, units, scale) !== exact(value, divisor));
  assert.deepEqual(ROWS.map(row => [row[0], differing(row)]), ROWS.map(row => [row[0], []]));
});

test('a validator with a decimal divisor answers for exponent forms, many decimals, the 2 ** 52 limit and non-finite values', async () => {
  // protects: R-63 MultipleOf with a decimal divisor keeps its results while it runs faster
  const verdicts = async (divisor: number, values: readonly number[]) => {
    const validate = await compileSchema({ multipleOf: divisor });
    return values.map(value => validate(value, false).length === 0);
  };
  assert.deepEqual(await verdicts(0.1, [0.3, -0.3, -0, 0.30000000000000004, 1e21, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY, 1e-7]), [true, true, true, false, true, true, false, false, false]);
  assert.deepEqual(await verdicts(0.001, [0.003, 0.0015, 1.234, 1.2345, 0.001, 0]), [true, false, true, false, true, true]);
  assert.deepEqual(await verdicts(0.5, [9007199254740991, 4503599627370495.5, 2251799813685247.25]), [true, true, false]);
  assert.deepEqual(await verdicts(1e-7, [3e-7, 1.5e-7, 1e-8, 0]), [true, false, false, true]);
  assert.deepEqual(await verdicts(0.123456789, [8595756.71190207, 8820007.45060213, 0.246913578]), [true, false, true]);
  assert.deepEqual(await verdicts(1e-23, [3e-23, 1.5e-23]), [true, false]);
  assert.deepEqual(await verdicts(0.12345678901234566, [0.12345678901234566, 0.2]), [true, false]);
});

test('the compiler writes the scaled form for a decimal divisor whose digits fit, and the exact function for any other divisor', async () => {
  // protects: R-63 the generated validator uses the cached divisor form only where it is exact
  const callsOf = async (divisor: number) => {
    const { source } = await compileValidatorModule({ roots: { root: { type: 'number', multipleOf: divisor } } });
    return source.match(new RegExp(`\\w+\\(\\w+, ${String(divisor).replace('.', '\\.')}(?:, [0-9e+]+, [0-9e+]+)?\\)`, 'g'))?.map(call => call.replace(/^\w+\(\w+,/, 'f(value,'));
  };
  assert.deepEqual(await callsOf(0.1), ['f(value, 0.1, 1, 10)']);
  assert.deepEqual(await callsOf(1.5e-7), ['f(value, 1.5e-7, 15, 100000000)']);
  assert.deepEqual(await callsOf(1e-22), ['f(value, 1e-22, 1, 1e+22)']);
  assert.deepEqual(await callsOf(1e-23), ['f(value, 1e-23)']);
  assert.deepEqual(await callsOf(0.12345678901234566), ['f(value, 0.12345678901234566)']);
  assert.deepEqual(await callsOf(3), ['f(value, 3)']);
});
