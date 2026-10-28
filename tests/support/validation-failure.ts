import assert from 'node:assert/strict';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

/** Run `run`, which must throw the validation failure of a generated codec: fails with `expected <expectation>` when it returns, and returns the LibError for the test to inspect. */
export function validationFailure(run: () => unknown, expectation: string): LibError {
  let failure: unknown;
  let returned = false;
  try {
    run();
    returned = true;
  } catch (error) {
    failure = error;
  }
  assert.ok(!returned, `expected ${expectation}`);
  assert.ok(failure instanceof LibError);
  assert.equal(failure.kind, LibErrorKind.Validation);
  return failure;
}
