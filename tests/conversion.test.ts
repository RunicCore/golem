import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  convertModelField,
  deserializeDate,
  serializeDate,
} from '@exprtlabs/golem/conversion';
import {
  IssueCode,
  IssueRepresentation,
  IssueSource,
  LibError,
  LibErrorKind,
} from '@exprtlabs/golem/errors';

test('conversion scopes preserve LibError identity and restore paths after failure', () => {
  const original = new LibError(LibErrorKind.Deserialization, 'Explicit callback failure', [{
    code: IssueCode.Deserialization, message: 'Explicit callback failure', path: ['custom'],
    source: IssueSource.Custom, representation: IssueRepresentation.Wire,
  }]);
  assert.throws(() => convertModelField('deserialize', 'outer', () => { throw original; }), error => error === original);
  assertConversionError(() => convertModelField('serialize', 'items', () =>
    convertModelField('serialize', 2, () => serializeDate('invalid'))),
  LibErrorKind.Serialization, IssueRepresentation.Model, ['items', 2]);
  for (const invalid of ['invalid', 1, null, {}]) {
    assertConversionError(() => convertModelField('deserialize', 'at', () => deserializeDate(invalid)),
      LibErrorKind.Deserialization, IssueRepresentation.Wire, ['at']);
  }
});

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('Expected the action to throw.');
}

function assertConversionError(
  action: () => unknown,
  kind: LibErrorKind.Serialization | LibErrorKind.Deserialization,
  representation: IssueRepresentation,
  path: readonly (string | number)[] = [],
): LibError {
  const error = thrown(action);
  assert.ok(error instanceof LibError);
  assert.equal(error.kind, kind);
  assert.equal(error.issues.length, 1);
  const issue = error.issues[0];
  assert.ok(issue);
  assert.equal(issue.code, kind === LibErrorKind.Serialization
    ? IssueCode.Serialization
    : IssueCode.Deserialization);
  assert.equal(issue.source, IssueSource.Serde);
  assert.equal(issue.representation, representation);
  assert.deepEqual(issue.path, path);
  assert.equal(issue.message, error.message);
  return error;
}

test('deserializes timestamps with ECMAScript Date parse', () => {
  const cases: readonly [string, string][] = [
    ['2024-02-29T23:59:59.123Z', '2024-02-29T23:59:59.123Z'],
    ['2024-03-01T00:00:00.999+02:30', '2024-02-29T21:30:00.999Z'],
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z'],
    ['2024-01-01T12:34:56.700Z', '2024-01-01T12:34:56.700Z'],
  ];
  for (const [wire, expected] of cases) {
    assert.equal(deserializeDate(wire).toISOString(), expected, wire);
    assert.equal(deserializeDate(wire).toISOString(), new Date(wire).toISOString(), wire);
  }
  const existing = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(deserializeDate(existing), existing);
});

test('serializes only finite Date instances as canonical UTC timestamps', () => {
  assert.equal(serializeDate(new Date('0001-01-01T00:00:00.000Z')), '0001-01-01T00:00:00.000Z');
  assert.equal(serializeDate(new Date('2024-02-29T23:59:59.123Z')), '2024-02-29T23:59:59.123Z');

  for (const value of [new Date(Number.NaN), new Date('invalid'), null, '2024-01-01T00:00:00Z', 1]) {
    const error = assertConversionError(
      () => serializeDate(value),
      LibErrorKind.Serialization,
      IssueRepresentation.Model,
    );
    assert.match(error.message, /valid Date/);
  }
});

test('Date conversion preserves caller paths and serializeDate rejects timestamps outside the four-digit UTC year range', () => {
  assert.equal(deserializeDate('0000-01-01T00:00:00Z').toISOString(), '0000-01-01T00:00:00.000Z');
  assert.equal(serializeDate(new Date('9999-12-31T23:59:59.999Z')), '9999-12-31T23:59:59.999Z');
  const path = ['events', 2, 'when'] as const;
  for (const value of [new Date('-000001-12-31T23:00:00Z'), new Date('+010000-01-01T00:00:00Z')]) {
    assertConversionError(() => serializeDate(value, path), LibErrorKind.Serialization, IssueRepresentation.Model, path);
  }
});
