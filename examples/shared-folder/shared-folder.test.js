import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// This test runs after both builds in `npm test`.
test('after the builds, the shared folder holds only the files of its author', () => {
  const shared = fs.readdirSync(new URL('./shared', import.meta.url)).sort();
  assert.deepEqual(shared, ['address.ts', 'customer.ts', 'money.ts', 'package.json', 'rules.ts']);
});
