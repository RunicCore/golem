import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadValidatedDocument, writeSdk as writeSdkFiles } from '#openapi/generator';
import { openApiFixture, tscBin, writeGeneratedSdk } from './helpers.js';
const providerRoot = openApiFixture('fixtures/providers');
const providers = [
  ['MoMo-style', 'momo.yaml'],
  ['NAPAS IBFT-style', 'napas-ibft.yaml'],
  ['VNPay QR-style', 'vnpay-qr.yaml'],
];

for (const [name, basename] of providers) {
  test(`${name} provider contract validates, generates, and compiles`, async (t) => {
    const filename = path.join(providerRoot, basename);
    assert.ok(
      fs.existsSync(filename),
      `missing package-local provider fixture: ${filename}`,
    );
    const document = await loadValidatedDocument(filename, {});
    const output = createFixtureProject(t, `runic-openapi-${basename}-`);
    writeGeneratedSdk(writeSdkFiles, document, {
      output,
      name: `${name}Conformance`,
      profile: { mobx: true, validation: true },
    });
    const compiled = spawnSync(process.execPath, [tscBin(), 
      '--target', 'ES2022',
      '--module', 'ESNext',
      '--moduleResolution', 'bundler',
      '--lib', 'ES2023,DOM,DOM.Iterable',
      '--skipLibCheck',
      '--noEmit',
      path.join(output, 'index.ts'),
    ], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  });
}
