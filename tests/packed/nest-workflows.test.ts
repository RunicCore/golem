import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, command, npm } from '../support/process.js';
import { startRegistry, type PackedRegistry } from '../../scripts/packed-registry.js';
import { copyFixture } from '../fixture-project.js';

let registry: PackedRegistry;
before(async () => { registry = await startRegistry(); });
after(async () => { await registry?.close(); });

const ADAPTERS: readonly ('express' | 'fastify')[] = ['express', 'fastify'];

test(`packed Nest consumer round trips on ${ADAPTERS.join(' and ')}`, async t => {
  const root = registry.create(t, 'nest-app');
  copyFixture(root, 'packed/nest-app');
  await npm(root, ['install']);
  await cli(root, ['generate']);
  await cli(root, ['check']);
  await cli(root, ['build']);
  await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
  for (const name of ['@exprtlabs/golem-model', '@exprtlabs/golem-openapi', '@exprtlabs/golem-ts-openapi', 'typescript']) {
    assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} must not be a production dependency`);
  }
  for (const adapter of ADAPTERS) {
    // verify.mjs checks create/read/list/delete, class construction, query
    // arrays, invalid body and query, malformed JSON, rejection before the
    // controller runs, and codec identity. It throws on any failure.
    await t.test(adapter, async () => {
      await command(root, process.execPath, ['verify.mjs'], { env: { TEST_HTTP_ADAPTER: adapter }, timeout: 120_000 });
    });
  }
});
