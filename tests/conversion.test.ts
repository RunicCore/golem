import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  constructModel,
  convertModelField,
  convertModelItems,
  convertModelRecord,
  convertModelTupleItems,
  copyModelRecord,
  deserializeDate,
  serializeDate,
  withDeclaredFields,
} from '@exprtlabs/golem/internal/model-runtime';
import {
  IssueRepresentation,
  IssueSource,
  LibError,
  LibErrorKind,
  type IssuePath,
} from '@exprtlabs/golem/errors';

test('conversion scopes preserve LibError identity and restore paths after failure', () => {
  const original = new LibError(LibErrorKind.Deserialization, 'Explicit callback failure', [{
    code: 'deserialization', message: 'Explicit callback failure', path: ['custom'],
    source: IssueSource.Custom, representation: IssueRepresentation.Wire,
  }]);
  assert.throws(() => convertModelField('outer', (failure: LibError) => { throw failure; }, original), error => error === original);
  assertConversionError(() => convertModelField('items', (value: unknown) =>
    convertModelField(2, deserializeDate, value), 'invalid'),
  LibErrorKind.Deserialization, IssueRepresentation.Wire, ['items', 2]);
  for (const invalid of ['invalid', 1, null, {}]) {
    assertConversionError(() => convertModelField('at', deserializeDate, invalid),
      LibErrorKind.Deserialization, IssueRepresentation.Wire, ['at']);
  }
});

test('convertModelItems runs each item under its index and passes the item only', () => {
  assert.deepEqual(convertModelItems(deserializeDate, ['1970-01-01T00:00:00.000Z']), [new Date(0)]);
  assertConversionError(() => convertModelItems(deserializeDate, ['1970-01-01T00:00:00.000Z', 'bad']),
    LibErrorKind.Deserialization, IssueRepresentation.Wire, [1]);
  assertConversionError(() => convertModelField('dates', (value: unknown) =>
    convertModelItems(deserializeDate, value as unknown[]), ['1970-01-01T00:00:00.000Z', 'bad']),
  LibErrorKind.Deserialization, IssueRepresentation.Wire, ['dates', 1]);
});

test('convertModelTupleItems gives the item, its index and the array', () => {
  const positions = convertModelTupleItems((item, index, items) => `${String(item)}:${index}/${items.length}`, ['a', 'b']);
  assert.deepEqual(positions, ['a:0/2', 'b:1/2']);
  assertConversionError(() => convertModelTupleItems((item, index) =>
    index === 0 ? item : deserializeDate(item), ['x', 'bad']),
  LibErrorKind.Deserialization, IssueRepresentation.Wire, [1]);
});

test('the record loops drop undefined values, run each value under its key and keep a __proto__ key as data', () => {
  // protects: R-58 generic record copies come from the runtime (T-641)
  assert.deepEqual(convertModelRecord(deserializeDate, { a: '1970-01-01T00:00:00.000Z', b: undefined }), { a: new Date(0) });
  assertConversionError(() => convertModelField('dates', (value: unknown) =>
    convertModelRecord(deserializeDate, value as Record<string, unknown>), { ok: '1970-01-01T00:00:00.000Z', bad: 'x' }),
  LibErrorKind.Deserialization, IssueRepresentation.Wire, ['dates', 'bad']);
  assert.deepEqual(copyModelRecord({ a: 1, b: undefined, c: 3 }), { a: 1, c: 3 });
  assert.deepEqual(copyModelRecord({ a: 1 }, (value) => Number(value) + 1), { a: 2 });
  const hostile = JSON.parse('{"__proto__":1}') as Record<string, unknown>;
  for (const copy of [copyModelRecord(hostile), convertModelRecord((value) => value, hostile)]) {
    assert.deepEqual(Object.keys(copy), ['__proto__'], 'the key stays an own key');
    assert.equal(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value, 1);
    assert.equal(Object.getPrototypeOf(copy), Object.prototype, 'the prototype is unchanged');
  }
});

test('the item loops send a LibError out as it is and keep holes', () => {
  const original = new LibError(LibErrorKind.Deserialization, 'Explicit callback failure', [{
    code: 'deserialization', message: 'Explicit callback failure', path: ['custom'],
    source: IssueSource.Custom, representation: IssueRepresentation.Wire,
  }]);
  assert.throws(() => convertModelItems(() => { throw original; }, [1]), error => error === original);
  const holes: unknown[] = [];
  holes[2] = 'c';
  const converted = convertModelItems((item: unknown) => String(item).toUpperCase(), holes);
  assert.equal(converted.length, 3);
  assert.equal(0 in converted, false);
  assert.equal(converted[2], 'C');
  assertConversionError(() => convertModelItems(() => { throw new Error('boom'); }, [1]),
    LibErrorKind.Deserialization, IssueRepresentation.Wire, [0]);
  assertConversionError(() => convertModelField('after', () => { throw new Error('boom'); }, 1),
    LibErrorKind.Deserialization, IssueRepresentation.Wire, ['after']);
});

const refuse = (): never => { throw new Error('refused'); };
const converterScopes: readonly (readonly [string, IssuePath, () => unknown])[] = [
  ['field', ['at'], () => convertModelField('at', refuse, 1)],
  ['array items', [0], () => convertModelItems(refuse, [1])],
  ['tuple items', [0], () => convertModelTupleItems(refuse, [1])],
  ['record values', ['a'], () => convertModelRecord(refuse, { a: 1 })],
];
for (const [scope, path, run] of converterScopes) {
  test(`${scope}: a throwing application deserializer is bad input`, () => {
    // protects: R-70 T-660 a deserializer throw on wire input has causedByInput true
    assert.equal(assertConversionError(run, LibErrorKind.Deserialization, IssueRepresentation.Wire, path).causedByInput, true);
  });
}

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
  // A Date instance is no wire value: only the text is read.
  assert.throws(() => deserializeDate(new Date('2026-01-01T00:00:00.000Z')), (error: unknown) => error instanceof LibError && error.causedByInput === true);
});

test('deserializeDate rejects an existing Invalid Date like an unparsable string', () => {
  // protects: bug an existing Invalid Date passed through deserializeDate and a later serializeDate threw
  const error = assertConversionError(
    () => convertModelField('at', deserializeDate, new Date(Number.NaN)),
    LibErrorKind.Deserialization,
    IssueRepresentation.Wire,
    ['at'],
  );
  assert.equal(error.causedByInput, true);
  assert.equal(error.message, 'Expected a date-time string.');
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

test('a class instance keeps its own and accessor fields; a name only Object.prototype or a method holds is no field, and __proto__ is data', () => {
  // protects: T-711 withDeclaredFields reads own properties and accessors below Object.prototype, and writes with defineModelProperty
  class Account {
    id = 1;
    constructor(public toString?: string) { void toString; }
    get label(): string { return 'main'; }
    method(): void {}
  }
  const account = new Account();
  assert.deepEqual(withDeclaredFields(account, ['id', 'label', 'method', 'toString', 'constructor', 'valueOf', 'hasOwnProperty']), { id: 1, label: 'main' });
  const named = new Account('mine');
  assert.deepEqual(withDeclaredFields(named, ['toString']), { toString: 'mine' });
  const hostile = Object.assign(new Account(), { constructor: 'own' });
  assert.deepEqual(withDeclaredFields(hostile, ['constructor']), { constructor: 'own' });
  const proto = new Account();
  Object.defineProperty(proto, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
  const declared = withDeclaredFields(proto, ['__proto__']) as object;
  assert.equal(Object.getPrototypeOf(declared), Object.prototype);
  assert.deepEqual(Object.keys(declared), ['__proto__']);
  assert.equal(withDeclaredFields(new Account(), ['__proto__']) instanceof Object, true);
  assert.deepEqual(Object.keys(withDeclaredFields(new Account(), ['__proto__']) as object), []);
});

test('a model constructor that throws is a LibError that is not bad input, in a field and at the root', () => {
  // protects: T-660 a constructor that threw inside convertModelField was reported as bad input
  class Failing { constructor() { throw new Error('db down'); } }
  const nested = assertConversionError(() => convertModelField('leaf', () => constructModel(Failing, {}), 1), LibErrorKind.Deserialization, IssueRepresentation.Wire, ['leaf']);
  assert.deepEqual([nested.message, nested.causedByInput, (nested.cause as Error).message], ['db down', false, 'db down']);
  const original = new LibError(LibErrorKind.Validation, 'invalid');
  assert.throws(() => constructModel(class { constructor() { throw original; } }, {}), (error) => error === original);
  assert.equal((constructModel(class { constructor(readonly value: unknown) {} }, 7) as { value: unknown }).value, 7);
});
