import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRuntimeCompatible } from '#golem/runtime-compatibility';

const runtime = (version: string) => ({ name: '@exprtlabs/golem', version });
const generator = (version: string) => ({ name: '@exprtlabs/golem-openapi', version });

test('a runtime and a built-in generator of the same version pass', () => {
  assertRuntimeCompatible(runtime('1.0.0-rc'), generator('1.0.0-rc'));
  assertRuntimeCompatible(runtime('1.3.0'), generator('1.3.0'));
});

test('a different version fails in both directions and names both versions', () => {
  assert.throws(() => assertRuntimeCompatible(runtime('1.0.0-rc'), generator('1.0.0')),
    /@exprtlabs\/golem 1\.0\.0-rc and @exprtlabs\/golem-openapi 1\.0\.0 must have the same version/);
  assert.throws(() => assertRuntimeCompatible(runtime('1.3.0'), generator('1.0.0')), /1\.3\.0 and @exprtlabs\/golem-openapi 1\.0\.0 must have the same version/);
});
