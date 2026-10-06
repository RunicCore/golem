import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runValidation, validateWith, type SchemaIssue, type Validator } from '@exprtlabs/golem/validation';

const issue: SchemaIssue = { code: 'custom', path: ['name'] };

test('runValidation keeps its asynchronous public contract for synchronous validators', async () => {
  const valid = runValidation(() => [], 'value');
  assert.equal(valid instanceof Promise, true);
  assert.deepEqual(await valid, { valid: true, issues: [] });

  const cause = new Error('synchronous public failure');
  const rejected = runValidation(() => { throw cause; }, 'value');
  assert.equal(rejected instanceof Promise, true);
  await assert.rejects(rejected, (error: unknown) => error === cause);
});

test('runValidation reports every issue unless the caller asks for the first only', async () => {
  const seen: unknown[] = [];
  const validator: Validator = (value, all) => {
    seen.push([value, all]);
    return [issue];
  };
  assert.deepEqual(await runValidation(validator, 'a'), { valid: false, issues: [issue] });
  assert.deepEqual(await validateWith(validator, 'b', false), { valid: false, issues: [issue] });
  assert.deepEqual(seen, [['a', true], ['b', false]]);
});

test('runValidation refuses a validator that does not return an array of issues', async () => {
  const oldStyle = (() => true) as unknown as Validator;
  await assert.rejects(runValidation(oldStyle, 'value'), (error: unknown) => error instanceof TypeError && error.message === 'A validator must return an array of issues.');
});
