import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// This test runs after both builds in `npm test`.
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('after the builds, the shared folder holds only the files of its author', () => {
  // Drop OS metadata files only, so a stray file that golem wrote still fails.
  const osMetadata = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  const shared = fs.readdirSync(new URL('./shared', import.meta.url)).filter((name) => !osMetadata.has(name)).sort();
  assert.deepEqual(shared, ['address.ts', 'customer.model.ts', 'money.ts', 'package.json', 'rules.ts']);
});

test('each app generates its own file for the shared model, in its own models.output', () => {
  const web = read('./apps/web/src/generated/models/shared/customer.model.generated.ts');
  const worker = read('./apps/worker/src/generated/models/shared/customer.model.generated.ts');
  assert.ok(web.includes('export abstract class TCustomerBaseModel'));
  assert.ok(worker.includes('export abstract class TCustomerBaseModel'));
  // The web profile validates, so its file imports the validators. The worker profile does not.
  assert.ok(web.includes('models.validators.generated.js'));
  assert.ok(!worker.includes('models.validators.generated.js'));
});
