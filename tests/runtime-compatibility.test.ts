import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRuntimeCompatible } from '#golem/runtime-compatibility';

const runtime = (version: string) => ({ name: '@exprtlabs/golem', version });
const generator = (version: string) => ({ name: '@exprtlabs/golem-openapi', version });

test('a runtime and a built-in generator of the same version pass', () => {
  // protects: T-653 a built-in generator works with the runtime of its own version only
  assertRuntimeCompatible(runtime('1.0.0-rc'), generator('1.0.0-rc'));
  assertRuntimeCompatible(runtime('1.3.0'), generator('1.3.0'));
});

test('a different version fails in both directions, names both versions and tells the install command', () => {
  // protects: T-653 a built-in generator works with the runtime of its own version only
  assert.throws(() => assertRuntimeCompatible(runtime('1.0.0-rc'), generator('1.0.0')),
    /@exprtlabs\/golem 1\.0\.0-rc and @exprtlabs\/golem-openapi 1\.0\.0 must have the same version\. Run: npm install -D @exprtlabs\/golem-openapi@1\.0\.0-rc$/);
  assert.throws(() => assertRuntimeCompatible(runtime('1.3.0'), generator('1.0.0')), /1\.3\.0 and @exprtlabs\/golem-openapi 1\.0\.0 must have the same version\. Run: npm install -D @exprtlabs\/golem-openapi@1\.3\.0$/);
});
