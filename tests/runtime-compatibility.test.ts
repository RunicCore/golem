import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRuntimeCompatible, compareReleaseVersions } from '#codegen/runtime-compatibility';

test('release versions order by number, and a prerelease precedes its release', () => {
  assert.ok(compareReleaseVersions('1.0.0-rc', '1.0.0') < 0);
  assert.ok(compareReleaseVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0);
  assert.ok(compareReleaseVersions('1.2.0', '1.10.0') < 0);
  assert.equal(compareReleaseVersions('1.0.0', '1.0.0'), 0);
});

const runtime = (version: string) => ({ name: '@exprtlabs/golem', version });
const generator = (version: string) => ({ name: '@exprtlabs/golem-openapi', version });

test('a runtime at or above the generator version in the same major passes', () => {
  assertRuntimeCompatible(runtime('1.0.0-rc'), generator('1.0.0-rc'));
  assertRuntimeCompatible(runtime('1.3.0'), generator('1.0.0'));
});

test('an older runtime fails and names both versions', () => {
  assert.throws(() => assertRuntimeCompatible(runtime('1.0.0-rc'), generator('1.0.0')),
    /@exprtlabs\/golem 1\.0\.0-rc is older than @exprtlabs\/golem-openapi 1\.0\.0/);
});

test('a different major fails', () => {
  assert.throws(() => assertRuntimeCompatible(runtime('2.0.0'), generator('1.4.0')), /major version/);
});
