import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceImportPath } from '#golem/type-analysis/project';

test('a source in a dot-named folder beside the output is imported by a relative specifier', () => {
  // protects: T-993 '.shared/m.js' starts with a dot, so it kept no './' and read as a package name
  assert.equal(sourceImportPath('/app/src/.shared/m.ts', '/app/src/a.generated.ts'), './.shared/m.js');
});

test('a source above the output is imported with ../ and the emitted extension', () => {
  assert.equal(sourceImportPath('/app/m.mts', '/app/src/a.generated.ts'), '../m.mjs');
});
