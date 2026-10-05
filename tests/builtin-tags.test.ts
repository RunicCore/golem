import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { builtinTagsModelSource } from './fixture-templates/models/builtin-tags.js';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { getValidator } from '@exprtlabs/golem/validation';

function materializeStandalone(root: string, sourceRoot: string): void {
  const artifact = generatedModelFiles(root).find((item) => item.path.endsWith('/models.validators.generated.js'));
  assert.ok(artifact, 'standalone validator artifact');
  const target = path.join(root, 'build', path.relative(sourceRoot, artifact.path));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(artifact.path, target);
}

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
  { field: 'minimum', value: 2, code: 'minimum' },
  { field: 'maximum', value: 8, code: 'maximum' },
  { field: 'exclusiveMinimum', value: 3, code: 'exclusiveMinimum' },
  { field: 'exclusiveMaximum', value: 7, code: 'exclusiveMaximum' },
  { field: 'multipleOf', value: 3, code: 'multipleOf' },
  { field: 'minLength', value: 'a', code: 'minLength' },
  { field: 'maxLength', value: 'abcdef', code: 'maxLength' },
  { field: 'pattern', value: '123', code: 'pattern' },
  { field: 'format', value: 'not-an-email', code: 'format' },
  { field: 'minItems', value: ['a'], code: 'minItems' },
  { field: 'maxItems', value: ['a', 'b', 'c', 'd'], code: 'maxItems' },
  { field: 'uniqueItems', value: ['a', 'a'], code: 'uniqueItems' },
  { field: 'aliasMin', value: 2, code: 'minimum' },
  { field: 'aliasMax', value: 8, code: 'maximum' },
  { field: 'aliasExclusiveMin', value: 3, code: 'exclusiveMinimum' },
  { field: 'aliasExclusiveMax', value: 7, code: 'exclusiveMaximum' },
];

// mobx does not change constraint execution, so each axis runs once.
const profiles = [
  { mobx: false, ajvStandalone: false },
  { mobx: true, ajvStandalone: true },
] as const;

for (const { mobx, ajvStandalone } of profiles) {
  test(`all built-in model tags execute independently with mobx=${mobx} and ${ajvStandalone ? 'standalone' : 'runtime'} Ajv`, async t => {
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-builtin-tags-', name: 'builtin-tags' });
    writeModelSources(sourceRoot, { 'a.model.ts': builtinTagsModelSource({ mobx }) });

    writeModelGolemYaml(root, { mobx, validation: true, ajvStandalone });
    await buildModelProject(root);
    if (ajvStandalone) materializeStandalone(root, sourceRoot);
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
