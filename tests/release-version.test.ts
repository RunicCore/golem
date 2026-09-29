import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseConsistency } from '../scripts/release-version.js';
import { EXAMPLE_NAMES } from '../scripts/maintained-examples.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));

function writeJson(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseFixture(root: string, version = '1.0.0-rc'): void {
  writeJson(path.join(root, 'package.json'), { private: true, version });
  for (const [directory, name, dependencies] of [
    ['codegen', '@exprtlabs/codegen', {}],
    ['model-codegen', '@exprtlabs/model-codegen', { '@exprtlabs/codegen': version }],
    ['openapi-to-ts', '@exprtlabs/openapi-to-ts', { '@exprtlabs/codegen': version }],
    ['ts-to-openapi', '@exprtlabs/ts-to-openapi', { '@exprtlabs/codegen': version }],
  ] as const) {
    writeJson(path.join(root, 'packages', directory, 'package.json'), {
      name,
      version,
      publishConfig: { access: 'public', tag: 'rc' },
      dependencies,
    });
  }
  for (const directory of EXAMPLE_NAMES) {
    writeJson(path.join(root, 'examples', directory, 'package.json'), {
      name: `${directory}-example`,
      dependencies: { '@exprtlabs/codegen': version },
    });
  }
}

test('release consistency is anchored to the private workspace version', () => {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')) as { version: string };
  assert.equal(assertReleaseConsistency(workspace), rootManifest.version);
});

test('release consistency rejects public version and internal pin drift', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runic-release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  releaseFixture(root);

  writeJson(path.join(root, 'packages', 'model-codegen', 'package.json'), {
    name: '@exprtlabs/model-codegen',
    version: '1.0.0',
    publishConfig: { access: 'public', tag: 'rc' },
    dependencies: { '@exprtlabs/codegen': '1.0.0-rc' },
  });
  assert.throws(() => assertReleaseConsistency(root), /@exprtlabs\/model-codegen must use workspace version/);

  writeJson(path.join(root, 'packages', 'model-codegen', 'package.json'), {
    name: '@exprtlabs/model-codegen',
    version: '1.0.0-rc',
    publishConfig: { access: 'public', tag: 'rc' },
    dependencies: { '@exprtlabs/codegen': '^1.0.0-rc' },
  });
  assert.throws(() => assertReleaseConsistency(root), /must pin @exprtlabs\/codegen/);
});

test('release consistency rejects an example project missing from the maintained inventory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runic-release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  releaseFixture(root);
  assert.equal(assertReleaseConsistency(root), '1.0.0-rc');

  writeJson(path.join(root, 'examples', 'unlisted', 'package.json'), { name: 'unlisted-example' });
  assert.throws(() => assertReleaseConsistency(root), /must match the maintained example inventory/);

  fs.rmSync(path.join(root, 'examples', 'unlisted'), { recursive: true });
  fs.rmSync(path.join(root, 'examples', 'showcase'), { recursive: true });
  assert.throws(() => assertReleaseConsistency(root), /must match the maintained example inventory/);
});
