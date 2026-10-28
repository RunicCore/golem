import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getValidator } from '@exprtlabs/golem/validation';
import { buildModelProjectWith, generatedModelFiles } from './model-project.js';
import { generatedJsonData } from './generated-data.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { tsSource } from './source-template.js';

test('a model number field accepts the int32, int64, float and double formats, writes them into the schema and checks their range', async t => {
  // protects: T-555 number & Format<'int32'> on a model field generates and validates instead of stopping with RUNM1051
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { Format } from '@exprtlabs/golem/tags';`,
    fields: tsSource`small: number & Format<'int32'>; big: number & Format<'int64'>; single: number & Format<'float'>; wide: number & Format<'double'>; text: string & Format<'email'>`,
  }).text);
  await buildModelProjectWith(root, { mobx: false, validation: true });
  const data = generatedJsonData(generatedModelFiles(root).map(artifact => artifact.content).join('\n'));
  for (const [field, format] of [['small', 'int32'], ['big', 'int64'], ['single', 'float'], ['wide', 'double']]) {
    assert.ok(data.includes(`"${field}":{"allOf":[{"type":"number"},{"format":"${format}"}]}`), `${field} schema`);
  }
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const inRange = { small: 2 ** 31 - 1, big: 2 ** 53, single: 1.5, wide: 1e300, text: 'a@b.co' };
  assert.equal(await getValidator(new A(inRange)).validate(), true);
  for (const outOfRange of [
    { small: 2 ** 31 },
    { small: -(2 ** 31) - 1 },
    { small: 1.5 },
    { big: 2 ** 64 },
    { single: 1e39 },
    { wide: Infinity },
  ]) {
    assert.equal(await getValidator(new A({ ...inRange, ...outOfRange } as never)).validate(), false, JSON.stringify(outOfRange));
  }
});
