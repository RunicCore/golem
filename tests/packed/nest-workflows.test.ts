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

const RUNS: readonly { readonly standalone: boolean; readonly adapters: readonly ('express' | 'fastify')[] }[] = [
  { standalone: false, adapters: ['express', 'fastify'] },
  { standalone: true, adapters: ['express'] },
];

for (const { standalone, adapters } of RUNS) {
  test(`packed Nest consumer round trips on ${adapters.join(' and ')}, standalone=${standalone}`, { timeout: 420_000 }, async t => {
    const root = registry.create(t, `nest-app-${standalone}`);
    copyFixture(root, 'packed/nest-app');
    if (standalone) {
      const packageFile = path.join(root, 'package.json');
      const manifest: { dependencies: Record<string, string>; devDependencies: Record<string, string> } = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      for (const name of ['ajv', 'ajv-formats']) {
        manifest.devDependencies[name] = manifest.dependencies[name];
        delete manifest.dependencies[name];
      }
      fs.writeFileSync(packageFile, JSON.stringify(manifest, null, 2));
    }
    await npm(root, ['install']);
    fs.appendFileSync(path.join(root, 'runic-codegen.yaml'), `\najvStandalone: ${standalone}\n`);
    await cli(root, ['generate']);
    await cli(root, ['check']);
    await command(root, path.join(root, 'node_modules/.bin/ttsc'), ['-p', 'tsconfig.json']);
    await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
    for (const name of ['@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', '@exprtlabs/ts-to-openapi', 'typescript', 'ttsc']) {
      assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} must not be a production dependency`);
    }
    for (const adapter of adapters) {
      // verify.mjs checks create/read/list/delete, class construction, query
      // arrays, invalid body and query, malformed JSON, rejection before the
      // controller runs, and codec identity. It throws on any failure.
      await t.test(adapter, async () => {
        await command(root, process.execPath, ['verify.mjs'], { env: { TEST_HTTP_ADAPTER: adapter }, timeout: 120_000 });
      });
    }
  });
}
