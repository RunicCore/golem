import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { ModelValidationContext } from '@exprtlabs/golem/model';
import { emitCodecRuntime } from '@exprtlabs/golem/emitter';
import { createSchemaGraph } from '@exprtlabs/golem/schema-graph';
import { assertModelValue, IssueRepresentation, IssueSource } from '@exprtlabs/golem/serde';
import type { SchemaIssue, Validator } from '@exprtlabs/golem/validation-runtime';

import { instantiateRuntime, type RuntimeFunction } from './emitted-runtime.js';

// The order of every generated model assert and validate site (spec 7.1): a validation context decides alone; else the
// fast check answers a valid value; else the validator's route runs as before. The generated sites of a model `User`
// run on a validator and a fast check that each record the values they were called with.

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

/** The generated `validateUser` and `assertUser` of a model `User`, which call the recorded validator and fast check. */
function generatedSites(model: Recorded): Record<string, RuntimeFunction> {
  const graph = createSchemaGraph();
  graph.intern({ kind: 'object', properties: { name: { kind: 'string' } }, required: ['name'], additionalProperties: false }, 'User');
  graph.seal();
  const source = emitCodecRuntime(graph, { validatorName: () => 'userValidator', fastCheckName: () => 'userFastCheck' });
  return instantiateRuntime(source, { userValidator: model.validator, userFastCheck: model.isValid });
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
  const { validateUser, assertUser } = generatedSites(model);
  const value = { name: 'a' };
  assert.equal(validateUser(value), true);
  assert.equal(assertUser(value), value);
  assert.deepEqual({ fast: model.fastCalls, validator: model.validatorCalls }, { fast: [value, value], validator: [] });
});

test('a value the fast check rejects takes the validator route, with the same error as without the fast check', () => {
  const model = recordedModel();
  const { validateUser, assertUser } = generatedSites(model);
  const value = { other: 1 };
  assert.equal(validateUser(value, { failFast: false }), false);
  const fast = thrown(() => assertUser(value));
  const slow = thrown(() => assertModelValue(value, undefined, model.validator, 'TUser', IssueRepresentation.Model, IssueSource.TypeScript));
  assert.ok(fast instanceof LibError && slow instanceof LibError);
  assert.deepEqual({ kind: fast.kind, issues: fast.issues }, { kind: LibErrorKind.Validation, issues: slow.issues });
  assert.deepEqual({ fast: model.fastCalls.length, validator: model.validatorCalls.length }, { fast: 2, validator: 3 });
});

test('a validation context decides alone: the fast check does not run', () => {
  const model = recordedModel();
  const rejectAll: Validator = () => [NAME_REQUIRED];
  const context: ModelValidationContext = { resolve: () => rejectAll };
  const { validateUser, assertUser } = generatedSites(model);
  const value = { name: 'a' };
  assert.equal(validateUser(value, { validationContext: context }), false);
  assert.ok(thrown(() => assertUser(value, { validationContext: context })) instanceof LibError);
  assert.deepEqual({ fast: model.fastCalls, validator: model.validatorCalls }, { fast: [], validator: [] });
});
