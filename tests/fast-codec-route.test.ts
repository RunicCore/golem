import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { ModelValidationContext } from '@exprtlabs/golem/model';
import { assertModelValue, assertModelValueFast, isValidModelValueFast, IssueRepresentation, IssueSource } from '@exprtlabs/golem/serde';
import type { SchemaIssue, Validator } from '@exprtlabs/golem/validation-runtime';

// The order of every generated model assert and validate site (spec 7.1): a validation context decides alone; else the
// fast check answers a valid value; else the validator's route runs as before. The validator and the fast check are the
// arguments a generated codec passes; each records the values it was called with.

const NAME_REQUIRED: SchemaIssue = { path: ['name'], code: 'required', key: 'name' };

interface Recorded {
  readonly validator: Validator;
  readonly isValid: (value: unknown) => boolean;
  readonly validatorCalls: unknown[];
  readonly fastCalls: unknown[];
}

/** A model whose values are valid when they hold a `name`, as its validator and its fast check both say. */
function recordedModel(): Recorded {
  const validatorCalls: unknown[] = [];
  const fastCalls: unknown[] = [];
  const named = (value: unknown): boolean => value !== null && typeof value === 'object' && 'name' in value;
  return {
    validatorCalls,
    fastCalls,
    validator: (value) => {
      validatorCalls.push(value);
      return named(value) ? [] : [NAME_REQUIRED];
    },
    isValid: (value) => {
      fastCalls.push(value);
      return named(value);
    },
  };
}

function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

test('a valid value is answered by the fast check, and the validator does not run', () => {
  const model = recordedModel();
  const value = { name: 'a' };
  assert.equal(isValidModelValueFast(value, undefined, model.isValid, model.validator, 'TUser'), true);
  assertModelValueFast(value, undefined, model.isValid, model.validator, 'TUser', IssueRepresentation.Model, IssueSource.TypeScript);
  assert.deepEqual({ fast: model.fastCalls, validator: model.validatorCalls }, { fast: [value, value], validator: [] });
});

test('a value the fast check rejects takes the validator route, with the same error as without the fast check', () => {
  const model = recordedModel();
  const value = { other: 1 };
  assert.equal(isValidModelValueFast(value, { failFast: false }, model.isValid, model.validator, 'TUser'), false);
  const fast = thrown(() => assertModelValueFast(value, undefined, model.isValid, model.validator, 'TUser', IssueRepresentation.Model, IssueSource.TypeScript));
  const slow = thrown(() => assertModelValue(value, undefined, model.validator, 'TUser', IssueRepresentation.Model, IssueSource.TypeScript));
  assert.ok(fast instanceof LibError && slow instanceof LibError);
  assert.deepEqual({ kind: fast.kind, issues: fast.issues }, { kind: LibErrorKind.Validation, issues: slow.issues });
  assert.deepEqual({ fast: model.fastCalls.length, validator: model.validatorCalls.length }, { fast: 2, validator: 3 });
});

test('a validation context decides alone: the fast check does not run', () => {
  const model = recordedModel();
  const rejectAll: Validator = () => [NAME_REQUIRED];
  const context: ModelValidationContext = { resolve: () => rejectAll };
  const value = { name: 'a' };
  assert.equal(isValidModelValueFast(value, { validationContext: context }, model.isValid, model.validator, 'TUser'), false);
  assert.ok(thrown(() => assertModelValueFast(value, { validationContext: context }, model.isValid, model.validator, 'TUser', IssueRepresentation.Model, IssueSource.TypeScript)) instanceof LibError);
  assert.deepEqual({ fast: model.fastCalls, validator: model.validatorCalls }, { fast: [], validator: [] });
});
