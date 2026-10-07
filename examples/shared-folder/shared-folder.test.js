import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// This test runs after both builds in `npm test`.
test('after the builds, the shared folder holds only the files of its author', () => {
  // Drop OS metadata files only, so a stray file that golem wrote still fails.
  const osMetadata = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  const shared = fs.readdirSync(new URL('./shared', import.meta.url)).filter((name) => !osMetadata.has(name)).sort();
  assert.deepEqual(shared, ['address.ts', 'customer.ts', 'money.ts', 'package.json', 'rules.ts']);
});
