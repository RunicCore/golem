import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IssueCode,
  IssueRepresentation,
  IssueSource,
  LibError,
  LibErrorKind,
  mapValidationCode,
  type Issue,
} from '@exprtlabs/codegen/errors';

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
  assert.equal(IssueCode.Custom, 'custom');
  assert.equal(IssueCode.Serialization, 'serialization');
  assert.equal(IssueCode.Deserialization, 'deserialization');
});

test('maps schema keywords to issue codes and preserves custom keywords', () => {
  assert.equal(mapValidationCode('minimum'), IssueCode.Minimum);
  assert.equal(mapValidationCode('items'), IssueCode.Items);
  assert.equal(mapValidationCode('patternProperties'), IssueCode.PatternProperties);
  assert.equal(mapValidationCode('dependentSchemas'), IssueCode.DependentSchemas);
  assert.equal(mapValidationCode('exprtValidation'), IssueCode.Custom);
  assert.equal(mapValidationCode('unrecognizedKeyword'), IssueCode.Invalid);
});

test('LibError preserves causes and snapshots unusual paths and JSON parameters', () => {
  const path: (string | number)[] = ['a.b', 'c/d', '~key', 0];
  const params = {
    property: 'a.b',
    nested: { value: 1 },
    values: [true, 2],
  };
  const issue: Issue = {
    code: IssueCode.Custom,
    message: 'Rejected by the application rule',
    path,
    source: IssueSource.Custom,
    representation: IssueRepresentation.Model,
    params,
  };
  const cause = new Error('predicate failed');
  const error = new LibError(
    LibErrorKind.Validation,
    'Model validation failed.',
    [issue],
    { cause },
  );

  path.push('mutated');
  params.nested.value = 99;
  params.values.push(false);

  assert.equal(error.name, 'LibError');
  assert.equal(error.kind, LibErrorKind.Validation);
  assert.equal(error.cause, cause);
  assert.deepEqual(error.issues, [{
    code: IssueCode.Custom,
    message: 'Rejected by the application rule',
    path: ['a.b', 'c/d', '~key', 0],
    source: IssueSource.Custom,
    representation: IssueRepresentation.Model,
    params: {
      property: 'a.b',
      nested: { value: 1 },
      values: [true, 2],
    },
  }]);

  const snapshot = error.issues[0];
  assert.ok(snapshot);
  assert.ok(Object.isFrozen(error.issues));
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.path));
  assert.ok(snapshot.params);
  assert.ok(Object.isFrozen(snapshot.params));
  assert.ok(Object.isFrozen(snapshot.params.nested));
  assert.ok(Object.isFrozen(snapshot.params.values));

  const empty = new LibError(LibErrorKind.ValidationUnavailable, 'Validation is unavailable.');
  assert.deepEqual(empty.issues, []);
  assert.ok(Object.isFrozen(empty.issues));
});

test('LibError rejects non-JSON issue parameters instead of retaining mutable or cyclic values', () => {
  assert.throws(
    () => new LibError(LibErrorKind.Validation, 'Invalid issue', [{
      code: IssueCode.Custom,
      message: 'bad params',
      path: [],
      source: IssueSource.Custom,
      params: { value: Number.NaN },
    }]),
    /finite, acyclic JSON values/,
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => new LibError(LibErrorKind.Validation, 'Invalid issue', [{
      code: IssueCode.Custom,
      message: 'bad params',
      path: [],
      source: IssueSource.Custom,
      params: { value: cyclic as never },
    }]),
    /finite, acyclic JSON values/,
  );
});
