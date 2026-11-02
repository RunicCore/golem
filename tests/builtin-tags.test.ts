import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';

import { builtinTagsModelSource } from './fixture-templates/models/builtin-tags.js';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { getValidator } from '@exprtlabs/golem/validation';
import { nearestManifest } from '#golem/type-analysis/package-specifier';
import { isGolemSourceFile } from '#golem/type-analysis/tags';

const valid = {
  integer: 2,
  minimum: 3,
  maximum: 7,
  exclusiveMinimum: 4,
  exclusiveMaximum: 6,
  multipleOf: 4,
  minLength: 'abc',
  maxLength: 'abc',
  pattern: 'é',
  format: 'name@example.com',
  minItems: ['a', 'b'],
  maxItems: ['a', 'b', 'c'],
  uniqueItems: ['a', 'b'],
  aliasMin: 3,
  aliasMax: 7,
  aliasExclusiveMin: 4,
  aliasExclusiveMax: 6,
} as const;

const invalidCases: readonly {
  readonly field: keyof typeof valid;
  readonly value: unknown;
  readonly code: string;
}[] = [
  { field: 'integer', value: 1.5, code: 'type' },
  { field: 'minimum', value: 2, code: 'tooSmall' },
  { field: 'maximum', value: 8, code: 'tooBig' },
  { field: 'exclusiveMinimum', value: 3, code: 'tooSmall' },
  { field: 'exclusiveMaximum', value: 7, code: 'tooBig' },
  { field: 'multipleOf', value: 3, code: 'multipleOf' },
  { field: 'minLength', value: 'a', code: 'tooSmall' },
  { field: 'maxLength', value: 'abcdef', code: 'tooBig' },
  { field: 'pattern', value: '123', code: 'pattern' },
  { field: 'format', value: 'not-an-email', code: 'format' },
  { field: 'minItems', value: ['a'], code: 'tooSmall' },
  { field: 'maxItems', value: ['a', 'b', 'c', 'd'], code: 'tooBig' },
  { field: 'uniqueItems', value: ['a', 'a'], code: 'unique' },
  { field: 'aliasMin', value: 2, code: 'tooSmall' },
  { field: 'aliasMax', value: 8, code: 'tooBig' },
  { field: 'aliasExclusiveMin', value: 3, code: 'tooSmall' },
  { field: 'aliasExclusiveMax', value: 7, code: 'tooBig' },
];

// mobx does not change constraint execution, so each axis runs once.
for (const mobx of [false, true] as const) {
  test(`all built-in model tags execute independently with mobx=${mobx}`, async t => {
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-builtin-tags-', name: 'builtin-tags' });
    writeModelSources(sourceRoot, { 'a.model.ts': builtinTagsModelSource({ mobx }) });

    writeModelGolemYaml(root, { mobx, validation: true });
    await buildModelProject(root);
    const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));

    assert.equal(await getValidator(new A(valid)).validate(), true);
    for (const item of invalidCases) {
      const value = { ...valid, [item.field]: item.value };
      const model = new A(value);
      assert.equal(await getValidator(model).validate(), false, item.field);
      assert.equal(getValidator(model).issues[0]?.code, item.code, item.field);
      assert.deepEqual(getValidator(model).issues[0]?.path, [item.field], item.field);
    }
  });
}

test('a package.json above a file that is not valid JSON gives the file no owner and does not stop the run', (t) => {
  // protects: T-829 the owner lookup of a tag key reads app directories, and a broken manifest there is not a failure of the run
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-broken-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), '{');
  assert.equal(isGolemSourceFile(path.join(root, 'src/tags.ts'), 'tags'), false);
  // The miss is remembered for the walked directories: the second file is not parsed against the broken manifest again.
  const owners = new Map();
  assert.throws(() => nearestManifest(path.join(root, 'src/a.ts'), owners), /Cannot read .*package\.json/);
  assert.equal(nearestManifest(path.join(root, 'src/b.ts'), owners), undefined);
});
