import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  convertModelField,
  convertModelItems,
  convertModelTupleItems,
  deserializeDate,
  serializeDate,
} from '@exprtlabs/golem/conversion';
import {
  IssueRepresentation,
  IssueSource,
  LibError,
  LibErrorKind,
} from '@exprtlabs/golem/errors';

test('conversion scopes preserve LibError identity and restore paths after failure', () => {
  const original = new LibError(LibErrorKind.Deserialization, 'Explicit callback failure', [{
    code: 'deserialization', message: 'Explicit callback failure', path: ['custom'],
    source: IssueSource.Custom, representation: IssueRepresentation.Wire,
  }]);
  assert.throws(() => convertModelField('deserialize', 'outer', (failure: LibError) => { throw failure; }, original), error => error === original);
  assertConversionError(() => convertModelField('serialize', 'items', (value: unknown) =>
    convertModelField('serialize', 2, serializeDate, value), 'invalid'),
  LibErrorKind.Serialization, IssueRepresentation.Model, ['items', 2]);
  for (const invalid of ['invalid', 1, null, {}]) {
    assertConversionError(() => convertModelField('deserialize', 'at', deserializeDate, invalid),
      LibErrorKind.Deserialization, IssueRepresentation.Wire, ['at']);
  }
});

test('convertModelItems runs each item under its index and passes the item only', () => {
  assert.deepEqual(convertModelItems('deserialize', deserializeDate, ['1970-01-01T00:00:00.000Z']), [new Date(0)]);
  assertConversionError(() => convertModelItems('deserialize', deserializeDate, ['1970-01-01T00:00:00.000Z', 'bad']),
    LibErrorKind.Deserialization, IssueRepresentation.Wire, [1]);
  assertConversionError(() => convertModelField('serialize', 'dates', (value: unknown) =>
    convertModelItems('serialize', serializeDate, value as unknown[]), [new Date(0), 'bad']),
  LibErrorKind.Serialization, IssueRepresentation.Model, ['dates', 1]);
});

test('convertModelTupleItems gives the item, its index and the array', () => {
  const positions = convertModelTupleItems('deserialize', (item, index, items) => `${String(item)}:${index}/${items.length}`, ['a', 'b']);
  assert.deepEqual(positions, ['a:0/2', 'b:1/2']);
  assertConversionError(() => convertModelTupleItems('deserialize', (item, index) =>
    index === 0 ? item : deserializeDate(item), ['x', 'bad']),
  LibErrorKind.Deserialization, IssueRepresentation.Wire, [1]);
});

test('the item loops send a LibError out as it is and keep holes', () => {
  const original = new LibError(LibErrorKind.Deserialization, 'Explicit callback failure', [{
    code: 'deserialization', message: 'Explicit callback failure', path: ['custom'],
    source: IssueSource.Custom, representation: IssueRepresentation.Wire,
  }]);
  assert.throws(() => convertModelItems('deserialize', () => { throw original; }, [1]), error => error === original);
  const holes: unknown[] = [];
  holes[2] = 'c';
  const converted = convertModelItems('deserialize', (item: unknown) => String(item).toUpperCase(), holes);
  assert.equal(converted.length, 3);
  assert.equal(0 in converted, false);
  assert.equal(converted[2], 'C');
  assertConversionError(() => convertModelItems('serialize', () => { throw new Error('boom'); }, [1]),
    LibErrorKind.Serialization, IssueRepresentation.Model, [0]);
  assertConversionError(() => convertModelField('serialize', 'after', () => { throw new Error('boom'); }, 1),
    LibErrorKind.Serialization, IssueRepresentation.Model, ['after']);
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
    ? 'serialization'
    : 'deserialization');
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
