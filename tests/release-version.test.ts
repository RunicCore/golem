import test, { type TestContext } from 'node:test';
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

/** An empty temporary root for a release fixture, removed when the test ends. */
function fixtureRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function releaseFixture(root: string, version = '1.0.0', tag = 'latest'): void {
  writeJson(path.join(root, 'package.json'), { private: true, version });
  for (const [directory, name, dependencies] of [
    ['golem', '@exprtlabs/golem', {}],
    ['golem-model', '@exprtlabs/golem-model', { '@exprtlabs/golem': version }],
    ['golem-openapi-ts', '@exprtlabs/golem-openapi-ts', { '@exprtlabs/golem': version }],
    ['golem-ts-openapi', '@exprtlabs/golem-ts-openapi', { '@exprtlabs/golem': version }],
  ] as const) {
    writeJson(path.join(root, 'packages', directory, 'package.json'), {
      name,
      version,
      publishConfig: { access: 'public', tag },
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
  const root = fixtureRoot(t);
  releaseFixture(root);

  writeJson(path.join(root, 'packages', 'golem-model', 'package.json'), {
    name: '@exprtlabs/golem-model',
    version: '1.0.1',
    publishConfig: { access: 'public', tag: 'latest' },
    dependencies: { '@exprtlabs/golem': '1.0.0' },
  });
  assert.throws(() => assertReleaseConsistency(root), /@exprtlabs\/golem-model must use workspace version/);

  writeJson(path.join(root, 'packages', 'golem-model', 'package.json'), {
    name: '@exprtlabs/golem-model',
    version: '1.0.0',
    publishConfig: { access: 'public', tag: 'latest' },
    dependencies: { '@exprtlabs/golem': '^1.0.0' },
  });
  assert.throws(() => assertReleaseConsistency(root), /must pin @exprtlabs\/golem to /);
});

test('release consistency rejects an example project missing from the maintained inventory', t => {
  const root = fixtureRoot(t);
  releaseFixture(root);
  assert.equal(assertReleaseConsistency(root), '1.0.0');

  writeJson(path.join(root, 'examples', 'unlisted', 'package.json'), { name: 'unlisted-example' });
  assert.throws(() => assertReleaseConsistency(root), /must match the maintained example inventory/);

  fs.rmSync(path.join(root, 'examples', 'unlisted'), { recursive: true });
  fs.rmSync(path.join(root, 'examples', 'models'), { recursive: true });
  assert.throws(() => assertReleaseConsistency(root), /must match the maintained example inventory/);
});

test('release consistency requires the dist-tag of the release version: latest for a stable version, the channel for a prerelease', t => {
  // protects: P-16 a prerelease must not publish under latest, and a stable release must
  const root = fixtureRoot(t);
  const cases: readonly [string, string, RegExp | undefined][] = [
    ['1.0.0', 'latest', undefined],
    ['1.0.0', 'rc', /must publish publicly with the latest tag/],
    ['1.0.0-rc.2', 'rc', undefined],
    ['1.0.0-rc.2', 'latest', /must publish publicly with the rc tag/],
  ];
  for (const [version, tag, failure] of cases) {
    releaseFixture(root, version, tag);
    if (failure) assert.throws(() => assertReleaseConsistency(root), failure, `${version} published as ${tag}`);
    else assert.equal(assertReleaseConsistency(root), version, `${version} published as ${tag}`);
  }
});
