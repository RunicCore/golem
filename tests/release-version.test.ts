import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertReleaseConsistency } from '../scripts/release-version.js';
import { EXAMPLE_NAMES } from '../scripts/maintained-examples.js';

function writeJson(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseFixture(root: string, version = '1.0.0-rc'): void {
  writeJson(path.join(root, 'package.json'), { private: true, version });
  for (const [directory, name, dependencies] of [
    ['golem', '@exprtlabs/golem', {}],
    ['golem-model', '@exprtlabs/golem-model', { '@exprtlabs/golem': version }],
    ['golem-openapi', '@exprtlabs/golem-openapi', { '@exprtlabs/golem': version }],
    ['golem-ts-openapi', '@exprtlabs/golem-ts-openapi', { '@exprtlabs/golem': version }],
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
      dependencies: { '@exprtlabs/golem': version },
    });
  }
}

test('release consistency rejects public version and internal pin drift', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  releaseFixture(root);

  writeJson(path.join(root, 'packages', 'golem-model', 'package.json'), {
    name: '@exprtlabs/golem-model',
    version: '1.0.0',
    publishConfig: { access: 'public', tag: 'rc' },
    dependencies: { '@exprtlabs/golem': '1.0.0-rc' },
  });
  assert.throws(() => assertReleaseConsistency(root), /@exprtlabs\/golem-model must use workspace version/);

  writeJson(path.join(root, 'packages', 'golem-model', 'package.json'), {
    name: '@exprtlabs/golem-model',
    version: '1.0.0-rc',
    publishConfig: { access: 'public', tag: 'rc' },
    dependencies: { '@exprtlabs/golem': '^1.0.0-rc' },
  });
  assert.throws(() => assertReleaseConsistency(root), /must pin @exprtlabs\/golem to /);
});

test('release consistency rejects an example project missing from the maintained inventory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  releaseFixture(root);
  assert.equal(assertReleaseConsistency(root), '1.0.0-rc');

  writeJson(path.join(root, 'examples', 'unlisted', 'package.json'), { name: 'unlisted-example' });
  assert.throws(() => assertReleaseConsistency(root), /must match the maintained example inventory/);

  fs.rmSync(path.join(root, 'examples', 'unlisted'), { recursive: true });
  fs.rmSync(path.join(root, 'examples', 'showcase'), { recursive: true });
  assert.throws(() => assertReleaseConsistency(root), /must match the maintained example inventory/);
});
