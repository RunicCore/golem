import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SchemaIssue } from '@exprtlabs/golem/validation-runtime';
import { runValidation, validateWith } from '@exprtlabs/golem/validation';
import type { Validator } from '@exprtlabs/golem/validation-runtime';

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
