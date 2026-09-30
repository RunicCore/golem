import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, command, npm } from '../support/process.js';
import { assertExecutedConsumerTests, copyExample } from '../support/consumer.js';
import { startRegistry, type PackedRegistry } from '../../scripts/packed-registry.js';
import { NEST_VERSION } from '../../scripts/third-party-installs.js';
import { copyFixtureFile } from '../fixture-project.js';

let registry: PackedRegistry;
before(async () => { registry = await startRegistry(); });
after(async () => { await registry?.close(); });

for (const standalone of [false, true]) {
  test(`packed Nest consumer round trips on Express and Fastify, standalone=${standalone}`, { timeout: 420_000 }, async t => {
    const root = registry.create(t, `nest-workflows-${standalone}`);
    copyExample(root, 'nest-openapi');
    const packageFile = path.join(root, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    // This adapter is a dependency of the test consumer, not of the package.
    manifest.dependencies['@nestjs/platform-fastify'] = NEST_VERSION;
    if (standalone) {
      for (const name of ['ajv', 'ajv-formats']) {
        manifest.devDependencies[name] = manifest.dependencies[name];
        delete manifest.dependencies[name];
      }
    }
    fs.writeFileSync(packageFile, JSON.stringify(manifest, null, 2));
    await npm(root, ['install']);
    fs.appendFileSync(path.join(root, 'runic-codegen.yaml'), `\najvStandalone: ${standalone}\n`);
    copyFixtureFile(root, 'packed/nest-workflows/adapter-entry.ts', 'src/app-adapter.test.ts');
    const configFile = path.join(root, 'tsconfig.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.compilerOptions.allowJs = true;
    config.include.push('src/**/*.js', 'sdk/**/*.js');
    fs.writeFileSync(configFile, JSON.stringify(config));
    await cli(root, ['generate']);
    await cli(root, ['check']);
    await command(root, path.join(root, 'node_modules/.bin/ttsc'), ['-p', 'tsconfig.json']);
    await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
    for (const name of ['@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', '@exprtlabs/ts-to-openapi', 'typescript', 'ttsc']) {
      assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, `${name} must not be a production dependency`);
    }
    for (const adapter of ['express', 'fastify']) {
      // Express with the default (non-standalone) validator is covered by the
      // nest-openapi maintained example in examples.test.ts, which runs the
      // same round trip through production pruning.
      if (adapter === 'express' && !standalone) continue;
      await t.test(adapter, async () => {
        // The example suite covers successful create/read/list/delete, class
        // construction, query arrays, invalid body/query, malformed JSON,
        // rejection before controller side effects, and codec identity.
        const result = await command(root, process.execPath, ['--test', '--test-reporter=tap', '.build/src/app-adapter.test.js'], {
          env: { TEST_HTTP_ADAPTER: adapter }, timeout: 120_000,
        });
        assertExecutedConsumerTests(result.stdout, `packed Nest ${adapter} adapter round trip`);
      });
    }
  });
}
