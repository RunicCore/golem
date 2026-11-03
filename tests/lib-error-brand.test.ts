import assert from 'node:assert/strict';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

// A second load of the same module: the URL query makes Node build another module instance, as a standalone SDK does.
const second = await import(`${import.meta.resolve('@exprtlabs/golem/errors')}?second-copy`) as { LibError: typeof LibError; LibErrorKind: typeof LibErrorKind };

test('an error from a second golem copy passes instanceof LibError, in both directions', () => {
  // protects: T-686 LibError passes instanceof across runtime copies
  assert.notEqual(second.LibError, LibError);
  const foreign = new second.LibError(second.LibErrorKind.Validation, 'bad input');
  const local = new LibError(LibErrorKind.Validation, 'bad input');
  assert.equal(foreign instanceof LibError, true);
  assert.equal(local instanceof second.LibError, true);
  assert.equal(foreign instanceof second.LibError, true);
  assert.equal(local instanceof LibError, true);
});

test('the foreign error keeps kind, issues and causedByInput readable', () => {
  // protects: T-686 the Nest interceptor reads causedByInput from a foreign error
  const foreign = new second.LibError(second.LibErrorKind.InvalidJson, 'bad json', [{ code: 'invalid_json', path: ['a', 0], message: 'x', source: 'json' as never }]);
  assert.equal(foreign instanceof LibError && foreign.kind, 'invalid_json');
  assert.equal(foreign instanceof LibError && foreign.causedByInput, true);
  assert.deepEqual(foreign instanceof LibError && foreign.issues.map(issue => [issue.code, issue.path]), [['invalid_json', ['a', 0]]]);
});

test('values without the brand fail instanceof LibError', () => {
  // protects: T-686 the brand does not widen instanceof to other values
  for (const value of [new Error('plain'), new TypeError('type'), { kind: 'validation', issues: [], causedByInput: true }, null, undefined, 'LibError', 1]) {
    assert.equal(value instanceof LibError, false);
  }
});

test('a subclass keeps the prototype check, so instanceof of a subclass is not true for every LibError', () => {
  // protects: T-686 a user's LibError subclass is not matched by every golem error
  class AppError extends LibError {}
  const app = new AppError(LibErrorKind.Response, 'app');
  const plain = new LibError(LibErrorKind.Response, 'plain');
  const foreign = new second.LibError(second.LibErrorKind.Response, 'foreign');
  assert.equal(app instanceof AppError, true);
  assert.equal(app instanceof LibError, true);
  assert.equal(app instanceof second.LibError, true);
  assert.equal(plain instanceof AppError, false);
  assert.equal(foreign instanceof AppError, false);
});
