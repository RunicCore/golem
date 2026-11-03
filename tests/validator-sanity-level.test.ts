import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import type { Validator } from '@exprtlabs/golem/validation';
import { compile } from '@exprtlabs/golem/internal/validator-compiler';

import { compileValidatorModule, compileValidators } from './support/compiled-validators.js';

// The sanity level checks the shape only (R-71). A full module carries it as the flag `s`, the third argument of a
// validator; a sanity module holds no check of a value limit. Sanity accepts all that full accepts.

interface Row {
  readonly name: string;
  readonly schema: unknown;
  readonly value: unknown;
  /** True when a limit or a validation function rejects the value at the full level only. */
  readonly limit: boolean;
}

const TUPLE = { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], minItems: 2, items: false };
const SHAPE_REJECTED: readonly Row[] = [
  { name: 'type', schema: { type: 'string' }, value: 5, limit: false },
  { name: 'required', schema: { type: 'object', required: ['a'] }, value: {}, limit: false },
  { name: 'additionalProperties false', schema: { type: 'object', properties: { a: {} }, additionalProperties: false }, value: { b: 1 }, limit: false },
  { name: 'patternProperties key', schema: { type: 'object', patternProperties: { '^x': { type: 'number' } } }, value: { xa: 'no' }, limit: false },
  { name: 'dependentRequired', schema: { dependentRequired: { a: ['b'] } }, value: { a: 1 }, limit: false },
  { name: 'propertyNames', schema: { type: 'object', propertyNames: { enum: ['a'] } }, value: { b: 1 }, limit: false },
  { name: 'enum', schema: { enum: ['a', 'b'] }, value: 'c', limit: false },
  { name: 'const', schema: { const: 1 }, value: 2, limit: false },
  { name: 'tuple too short', schema: TUPLE, value: ['a'], limit: false },
  { name: 'tuple too long', schema: TUPLE, value: ['a', 1, 2], limit: false },
  { name: 'date-time format', schema: { type: 'string', format: 'date-time' }, value: '5', limit: false },
  { name: 'discriminated union tag', schema: { oneOf: [{ properties: { k: { const: 'a' } }, required: ['k'] }, { properties: { k: { const: 'b' } }, required: ['k'] }], discriminator: { propertyName: 'k' } }, value: { k: 'c' }, limit: false },
  { name: 'limit under a failing type', schema: { type: 'string', minLength: 3 }, value: 5, limit: false },
];
const LIMITS: readonly Row[] = [
  { name: 'minLength', schema: { type: 'string', minLength: 3 }, value: 'a', limit: true },
  { name: 'maxLength', schema: { type: 'string', maxLength: 1 }, value: 'abc', limit: true },
  { name: 'pattern', schema: { type: 'string', pattern: '^a' }, value: 'b', limit: true },
  { name: 'format', schema: { type: 'string', format: 'email' }, value: 'nobody', limit: true },
  { name: 'minimum', schema: { type: 'number', minimum: 5 }, value: 1, limit: true },
  { name: 'maximum', schema: { type: 'number', maximum: 5 }, value: 9, limit: true },
  { name: 'exclusiveMinimum', schema: { type: 'number', exclusiveMinimum: 5 }, value: 5, limit: true },
  { name: 'exclusiveMaximum', schema: { type: 'number', exclusiveMaximum: 5 }, value: 5, limit: true },
  { name: 'multipleOf', schema: { type: 'number', multipleOf: 0.1 }, value: 0.25, limit: true },
  { name: 'uniqueItems', schema: { type: 'array', uniqueItems: true }, value: [1, 1], limit: true },
  { name: 'minItems', schema: { type: 'array', minItems: 2 }, value: [1], limit: true },
  { name: 'maxItems', schema: { type: 'array', maxItems: 1 }, value: [1, 2], limit: true },
  { name: 'minProperties', schema: { type: 'object', minProperties: 1 }, value: {}, limit: true },
  { name: 'maxProperties', schema: { type: 'object', maxProperties: 1 }, value: { a: 1, b: 2 }, limit: true },
  { name: 'minContains', schema: { type: 'array', contains: { type: 'number' }, minContains: 2 }, value: [1, 'a'], limit: true },
  { name: 'maxContains', schema: { type: 'array', contains: { type: 'number' }, maxContains: 1 }, value: [1, 2], limit: true },
  { name: 'a limit in a property', schema: { type: 'object', properties: { a: { type: 'string', minLength: 3 } } }, value: { a: 'x' }, limit: true },
  { name: 'a limit behind a $ref', schema: { $ref: '#/$defs/Short', $defs: { Short: { type: 'string', maxLength: 1 } } }, value: 'abc', limit: true },
];

/** The validator of a full module and of a sanity module of one schema. */
const compiledRuns = new Map<unknown, Promise<{ readonly full: Validator; readonly sanityModule: Validator }>>();

function runs(schema: unknown): Promise<{ readonly full: Validator; readonly sanityModule: Validator }> {
  const known = compiledRuns.get(schema);
  if (known) return known;
  const created = Promise.all([compileValidators({ roots: { root: schema } }), compileValidators({ roots: { root: schema }, level: 'sanity' })])
    .then(([full, sanity]) => ({ full: full.root, sanityModule: sanity.root }));
  compiledRuns.set(schema, created);
  return created;
}

/** True when the validator reports no issue, in all-errors mode and in fail-fast mode. */
function accepts(validate: Validator, value: unknown, flag?: boolean): boolean {
  return validate(value, true, flag).length === 0 && validate(value, false, flag).length === 0;
}

/** What the full module accepts with the flag absent and false, and what it and a sanity module accept at the sanity level. */
async function levels(schema: unknown, value: unknown): Promise<{ readonly full: boolean; readonly flag: boolean; readonly sanityModule: boolean }> {
  const { full, sanityModule } = await runs(schema);
  assert.equal(accepts(full, value), accepts(full, value, false), 'a false flag is an absent flag');
  return { full: accepts(full, value), flag: accepts(full, value, true), sanityModule: accepts(sanityModule, value) };
}

describe('the sanity level', () => {
  for (const row of [...SHAPE_REJECTED, ...LIMITS]) {
    test(`${row.name}: ${row.limit ? 'full rejects, sanity accepts' : 'every level rejects'}`, async () => {
      // protects: R-71 sanity keeps the shape and skips the value limits, in a sanity module and in the full one with the flag
      const { sanityModule, full } = await runs(row.schema);
      assert.equal(accepts(full, row.value), false, 'full module, flag absent');
      assert.equal(accepts(full, row.value, false), false, 'full module, flag false');
      assert.equal(accepts(full, row.value, true), row.limit, 'full module, flag true');
      assert.equal(accepts(sanityModule, row.value), row.limit, 'sanity module');
    });
  }
});

const SHORT = { $defs: { Short: { type: 'string', maxLength: 3 } } };

describe('sanity accepts all that full accepts', () => {
  // protects: R-71 the monotone rule: a check that fails more once a limit passes less is relaxed
  test('not over a schema with a limit does not decide', async () => {
    const schema = { ...SHORT, not: { $ref: '#/$defs/Short' } };
    assert.deepEqual(await levels(schema, 'abc'), { full: false, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, 'abcdef'), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels({ not: { type: 'string' } }, 'abc'), { full: false, flag: false, sanityModule: false });
  });

  test('an untagged oneOf over limits becomes an anyOf', async () => {
    const schema = { oneOf: [{ type: 'string', maxLength: 3 }, { type: 'string', minLength: 2 }] };
    assert.deepEqual(await levels(schema, 'abcd'), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, 'abc'), { full: false, flag: true, sanityModule: true });
    assert.deepEqual(await levels({ oneOf: [{ type: 'string' }, { type: 'string', const: 'a' }] }, 'a'), { full: false, flag: false, sanityModule: false });
  });

  test('if over a limit does not apply then', async () => {
    // protects: R-71 an if that passes more at sanity must not apply a then that full does not
    const schema = { if: { properties: { a: { maxLength: 1 } } }, then: { required: ['b'] } };
    assert.deepEqual(await levels(schema, { a: 'xyz' }), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, { a: 'x' }), { full: false, flag: true, sanityModule: true });
  });

  test('then over a limit still applies its shape when if is exact', async () => {
    // protects: R-71 relaxing only an if that reaches a limit keeps the shape of then and else
    const schema = { if: { required: ['a'] }, then: { required: ['b'], properties: { b: { type: 'string', maxLength: 1 } } } };
    assert.deepEqual(await levels(schema, { a: 1 }), { full: false, flag: false, sanityModule: false });
    assert.deepEqual(await levels(schema, { a: 1, b: 'xyz' }), { full: false, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, { b: 'xyz' }), { full: true, flag: true, sanityModule: true });
  });

  test('contains over a limit needs no match, and a plain contains still needs one', async () => {
    // protects: R-71 contains counts are limits; a contains with a shape-only schema still needs one match
    const limited = { type: 'array', contains: { type: 'string', maxLength: 1 } };
    assert.deepEqual(await levels(limited, ['abc']), { full: false, flag: true, sanityModule: true });
    assert.deepEqual(await levels(limited, ['a']), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels({ type: 'array', contains: { type: 'number' } }, ['a']), { full: false, flag: false, sanityModule: false });
    assert.deepEqual(await levels({ type: 'array', contains: { type: 'number' }, minContains: 3 }, [1]), { full: false, flag: true, sanityModule: true });
    assert.deepEqual(await levels({ type: 'array', contains: { type: 'number' }, minContains: 3 }, ['a']), { full: false, flag: false, sanityModule: false });
  });

  test('the flag reaches a function that receives an evaluation record', async () => {
    // protects: R-73 the flag s comes before the record e in the parameter list and the call
    // The base takes the record `e` and the flag `s`, in that order after the all-errors flag.
    const schema = { $ref: '#/$defs/Base', unevaluatedProperties: false, $defs: { Base: { properties: { a: { type: 'string', maxLength: 1 } } } } };
    assert.deepEqual(await levels(schema, { a: 'xyz' }), { full: false, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, { a: 'x' }), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, { a: 'x', b: 1 }), { full: false, flag: false, sanityModule: false });
  });

  test('a relaxed if still marks what it evaluates for unevaluatedProperties', async () => {
    // protects: R-71 a relaxed if keeps its evaluation marks, so unevaluatedProperties never rejects more at sanity
    const schema = { properties: { a: {} }, if: { properties: { b: { maxLength: 1 } }, required: ['b'] }, then: { properties: { c: {} } }, unevaluatedProperties: false };
    assert.deepEqual(await levels(schema, { a: 1, b: 'x', c: 1 }), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, { a: 1, b: 'x', d: 1 }), { full: false, flag: false, sanityModule: false });
  });

  test('contains over a limit still marks its matches for unevaluatedItems', async () => {
    // protects: R-71 a contains relaxed in a function that keeps a record still marks the items it matches
    const schema = { type: 'array', contains: { type: 'string', maxLength: 1 }, unevaluatedItems: false };
    assert.deepEqual(await levels(schema, ['a']), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, ['abc']), { full: false, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, ['abc', 5]), { full: false, flag: false, sanityModule: false });
  });

  test('an untagged oneOf that keeps a record runs every branch at sanity, so each match marks its keys', async () => {
    // protects: R-71 a oneOf relaxed to anyOf must not stop after two matches: a later branch can mark the keys full accepts
    const schema = {
      oneOf: [{ properties: { a: { type: 'string', maxLength: 1 } } }, { properties: { b: { type: 'string', maxLength: 1 } } }, { properties: { a: {}, b: {}, c: { type: 'string' } }, required: ['c'] }],
      unevaluatedProperties: false,
    };
    assert.deepEqual(await levels(schema, { a: 'xyz', b: 'xyz', c: 's' }), { full: true, flag: true, sanityModule: true });
    assert.deepEqual(await levels(schema, { a: 'xyz', b: 'xyz', c: 's', d: 1 }), { full: false, flag: false, sanityModule: false });
  });
});

describe('a validation function', () => {
  const RULES = 'export const isEven = value => value % 2 === 0;\n';
  const input = { roots: { root: { exprtValidation: { schema: { type: 'integer' }, bindings: ['rules.isEven'] } } }, validations: { 'rules.isEven': { importPath: './rules.mjs', exportName: 'isEven' } }, modules: { 'rules.mjs': RULES } };

  test('runs at the full level only, and the structure under it stays', async () => {
    // protects: R-71 a TValidation call is a value rule; sanity checks the structure under it
    const { root: full } = await compileValidators(input);
    const { root: sanity } = await compileValidators({ ...input, level: 'sanity' });
    assert.deepEqual(full(3, true), [{ path: [], code: 'custom' }]);
    assert.deepEqual(full(3, true, true), []);
    assert.deepEqual(full('x', true, true), [{ path: [], code: 'type', expected: ['integer'] }]);
    assert.deepEqual(sanity(3, true), []);
    assert.deepEqual(sanity('x', true), [{ path: [], code: 'type', expected: ['integer'] }]);
  });
});

describe('a sanity module', () => {
  const LIMITED = { type: 'object', required: ['a'], properties: { a: { type: 'string', minLength: 2, pattern: '^a', format: 'email' }, b: { type: 'number', maximum: 3, multipleOf: 0.1 }, c: { type: 'array', uniqueItems: true, maxItems: 2 } } };

  test('holds no code for a value limit and takes no flag', async () => {
    // protects: R-71 a sanity project emits only sanity checks
    const { source } = await compileValidatorModule({ roots: { root: LIMITED }, level: 'sanity' });
    assert.doesNotMatch(source, /codePointLength|checkFormat|formatTest|isMultipleOf|new RegExp|\bpattern\d+\b|code: 'unique'|\bunique\d+:|tooBig|tooSmall/);
    assert.match(source, /export function validate_root\(value, all\) \{/);
  });

  test('leaves out a check that only a limit held', async () => {
    // protects: R-71 a sanity project emits only sanity checks: no loop for an array or a key list that held a limit alone
    const limitsOnly = { type: 'object', propertyNames: { maxLength: 5 }, properties: { tags: { minItems: 1, uniqueItems: true }, owner: { properties: { name: { minLength: 1 } } } } };
    const { source } = await compileValidatorModule({ roots: { root: limitsOnly }, level: 'sanity' });
    assert.doesNotMatch(source, /for \(|\.push\("(tags|owner|name)"\)/);
    assert.deepEqual((await compileValidators({ roots: { root: limitsOnly }, level: 'sanity' })).root({ tags: [1, 1], owner: { name: '' }, extraordinarilyLong: 1 }, true), []);
  });

  test('reports a schema diagnostic as the full level does', () => {
    // protects: R-71 an invalid pattern and an unknown format are reported at every level
    for (const level of ['full', 'sanity'] as const) {
      const roots = new Map<string, unknown>([['root', { properties: { a: { pattern: '(' }, b: { format: 'nonesuch' } } }]]);
      const { diagnostics } = compile({ roots }, { unknownFormats: 'warn', level });
      assert.deepEqual(diagnostics.map(entry => [entry.code, entry.severity]), [['VALIDATE_INVALID_PATTERN', GolemDiagnosticSeverity.Error], ['VALIDATE_UNKNOWN_FORMAT', GolemDiagnosticSeverity.Warning]]);
    }
  });

  test('has fast checks that match its own validator', async () => {
    // protects: R-71 a sanity module's fast check is true exactly when its validator reports no issue
    const { byRoot, fastByRoot } = await compileValidatorModule({ roots: { root: LIMITED }, level: 'sanity', fastPath: true });
    const values = [{ a: 'x', b: 9, c: [1, 1, 1] }, { b: 1 }, { a: 1 }, { a: 'x', extra: 1 }];
    assert.deepEqual(values.map(value => fastByRoot.root(value)), values.map(value => byRoot.root(value, true).length === 0));
    assert.deepEqual(values.map(value => fastByRoot.root(value)), [true, false, false, true]);
  });
});
