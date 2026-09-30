import assert from 'node:assert/strict';
import type { AFields } from './a.model.generated.js';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { getValidator } from '@exprtlabs/golem/validation';
import { A } from './a.model.js';
import * as rules from './rules.js';

const [codecIdJson, acceptedJson, rejectedJson] = process.argv.slice(2);
if (!codecIdJson || !acceptedJson || !rejectedJson) {
  throw new Error('codec id and case data are passed to the verifier');
}
const accepted = JSON.parse(acceptedJson) as Partial<AFields>[];
const rejected = JSON.parse(rejectedJson) as Partial<AFields>[];
const aCodec = requireObjectCodec(JSON.parse(codecIdJson) as string);
for (const value of accepted) {
  const model = new A(value);
  rules.reset();
  assert.equal(await getValidator(model).validate(), true, JSON.stringify({ value, issues: getValidator(model).issues }));
  const modelCalls = rules.calls;
  rules.reset();
  const wire = encodeGeneratedModel(model);
  assert.deepEqual(wire, value);
  assert.equal(rules.calls, 0, 'toJSON must not execute model predicates');
  rules.reset();
  const decoded = decodeGeneratedModel(A, wire);
  assert.ok(decoded instanceof A);
  assert.equal(rules.calls, 0, 'fromJSON copies a class after parse and does not re-run Ajv');
  const usesModelPredicate = value.choice !== undefined
    || value.cond !== undefined
    || value.counts !== undefined
    || value.annotated !== undefined;
  if (usesModelPredicate) assert.ok(modelCalls > 0, JSON.stringify(value));
}
for (const value of rejected) {
  const model = new A(value);
  assert.equal(await getValidator(model).validate(), false);
  assert.throws(() => aCodec.assert(value));
  if (value.builtin === 2) {
    assert.throws(() => aCodec.assert(encodeGeneratedModel(model)), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
    assert.throws(() => aCodec.assert(value), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
  } else {
    assert.doesNotThrow(() => aCodec.toWireFormat(model, { validate: false }));
  }
}
