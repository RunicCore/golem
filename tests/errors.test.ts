import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IssueRepresentation,
  IssueSource,
  LibError,
  LibErrorKind,
  toIssue,
  type Issue,
} from '@exprtlabs/golem/errors';
import { ModelValidator } from '@exprtlabs/golem/validation';

test('exports the stable string enums used by library errors and issues', () => {
  assert.deepEqual(Object.values(LibErrorKind), [
    'validation',
    'serialization',
    'deserialization',
    'invalid_json',
    'validation_unavailable',
    'response',
  ]);
  assert.equal(IssueSource.External, 'external');
  assert.equal(IssueSource.Serde, 'serde');
  assert.equal(IssueRepresentation.Model, 'model');
  assert.equal(IssueRepresentation.Wire, 'wire');
});

test('toIssue adds the default message, source and representation to a schema issue', () => {
  assert.deepEqual(
    toIssue({ path: ['name'], code: 'tooSmall', measure: 'length', limit: 3, inclusive: true }, IssueSource.TypeScript, IssueRepresentation.Model),
    {
      path: ['name'], code: 'tooSmall', measure: 'length', limit: 3, inclusive: true,
      message: 'Must be at least 3 characters', source: IssueSource.TypeScript, representation: IssueRepresentation.Model,
    },
  );
  assert.deepEqual(
    toIssue({ path: ['items', 0], code: 'required', key: 'sku' }, IssueSource.OpenAPI),
    { path: ['items', 0], code: 'required', key: 'sku', message: 'Missing required property "sku"', source: IssueSource.OpenAPI },
  );
  assert.deepEqual(
    toIssue({ path: [], code: 'custom', reason: 'Name is taken' }, IssueSource.Custom, IssueRepresentation.Wire),
    { path: [], code: 'custom', reason: 'Name is taken', message: 'Name is taken', source: IssueSource.Custom, representation: IssueRepresentation.Wire },
  );
});

test('an issue narrows to the typed fields of its code', () => {
  const issue: Issue = toIssue({ path: ['age'], code: 'tooBig', measure: 'value', limit: 120, inclusive: false }, IssueSource.TypeScript);
  if (issue.code === 'tooBig') {
    issue.limit satisfies number;
    issue.inclusive satisfies boolean;
    assert.equal(issue.limit, 120);
    assert.equal(issue.measure, 'value');
  } else {
    assert.fail('expected a tooBig issue');
  }
});

test('messages() overrides a message by field and code or by code alone', () => {
  const validator = new ModelValidator<{ name: string; nick: string }>({ name: '', nick: '' });
  validator.messages({ 'name.tooSmall': 'Too short', required: 'Fill this in' });
  const tooSmall = (field: string): Issue => toIssue({ path: [field], code: 'tooSmall', measure: 'length', limit: 3, inclusive: true }, IssueSource.TypeScript, IssueRepresentation.Model);

  assert.equal(validator.formatIssue(tooSmall('name'), false).message, 'Too short');
  assert.equal(validator.formatIssue(tooSmall('nick'), false).message, 'Must be at least 3 characters');
  assert.equal(
    validator.formatIssue(toIssue({ path: ['nick'], code: 'required', key: 'nick' }, IssueSource.TypeScript), false).message,
    'Fill this in',
  );
});

test('LibError preserves causes and snapshots unusual paths and typed values', () => {
  const path: (string | number)[] = ['a.b', 'c/d', '~key', 0];
  const expected: string[] = ['a', 'b'];
  const issues: Issue[] = [
    {
      code: 'custom',
      reason: 'Rejected by the application rule',
      message: 'Rejected by the application rule',
      path,
      source: IssueSource.Custom,
      representation: IssueRepresentation.Model,
    },
    toIssue({ path: ['kind'], code: 'literal', expected }, IssueSource.TypeScript, IssueRepresentation.Wire),
    toIssue({ path: ['tags'], code: 'unique', indexes: [0, 2] }, IssueSource.TypeScript),
  ];
  const cause = new Error('predicate failed');
  const error = new LibError(
    LibErrorKind.Validation,
    'Model validation failed.',
    issues,
    { cause },
  );

  path.push('mutated');
  expected.push('c');

  assert.equal(error.name, 'LibError');
  assert.equal(error.kind, LibErrorKind.Validation);
  assert.equal(error.cause, cause);
  assert.deepEqual(error.issues, [
    {
      code: 'custom',
      reason: 'Rejected by the application rule',
      message: 'Rejected by the application rule',
      path: ['a.b', 'c/d', '~key', 0],
      source: IssueSource.Custom,
      representation: IssueRepresentation.Model,
    },
    {
      code: 'literal', expected: ['a', 'b'], message: 'Must be "a" or "b"',
      path: ['kind'], source: IssueSource.TypeScript, representation: IssueRepresentation.Wire,
    },
    { code: 'unique', indexes: [0, 2], message: 'Items at index 0 and 2 are equal; items must be unique', path: ['tags'], source: IssueSource.TypeScript },
  ]);

  const [custom, literal, unique] = error.issues;
  assert.ok(custom && literal && unique);
  assert.ok(Object.isFrozen(error.issues));
  assert.ok(Object.isFrozen(custom));
  assert.ok(Object.isFrozen(custom.path));
  assert.ok(literal.code === 'literal' && Object.isFrozen(literal.expected));
  assert.ok(unique.code === 'unique' && Object.isFrozen(unique.indexes));

  const empty = new LibError(LibErrorKind.ValidationUnavailable, 'Validation is unavailable.');
  assert.deepEqual(empty.issues, []);
  assert.ok(Object.isFrozen(empty.issues));
});

test('LibError rejects non-JSON literal values instead of retaining mutable or cyclic values', () => {
  const rejected = (expected: Extract<Issue, { code: 'literal' }>['expected']) => () => new LibError(LibErrorKind.Validation, 'Invalid issue', [
    { code: 'literal', expected, message: 'Must be a constant', path: [], source: IssueSource.TypeScript },
  ]);
  assert.throws(rejected([Number.NaN]), /finite, acyclic JSON values/);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(rejected([cyclic as never]), /finite, acyclic JSON values/);
});

test('LibError rejects an issue whose code the type does not have', () => {
  // Untyped JavaScript callers, such as setIssues, can send an old keyword code.
  const old = { code: 'minLength', message: 'Too short', path: ['name'], source: IssueSource.TypeScript } as unknown as Issue;
  assert.throws(
    () => new LibError(LibErrorKind.Validation, 'Invalid issue', [old]),
    /Unknown issue code: minLength/,
  );
});
