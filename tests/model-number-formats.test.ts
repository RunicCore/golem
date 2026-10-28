import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { buildModelProjectWith } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { tsSource } from './source-template.js';

test('a model number field accepts the int32, int64, float and double formats, checks their range', async t => {
  // protects: T-555 number & Format<'int32'> on a model field generates and validates instead of stopping with RUNM1051
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { Format } from '@exprtlabs/golem/tags';`,
    fields: tsSource`small: number & Format<'int32'>; big: number & Format<'int64'>; single: number & Format<'float'>; wide: number & Format<'double'>; text: string & Format<'email'>`,
  }).text);
  await buildModelProjectWith(root, { mobx: false, validation: true });
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const inRange = { small: 2 ** 31 - 1, big: Number.MAX_SAFE_INTEGER, single: 1.5, wide: 1e300, text: 'a@b.co' };
  assert.equal(await getValidator(new A(inRange)).validate(), true);
  for (const outOfRange of [
    { small: 2 ** 31 },
    { small: -(2 ** 31) - 1 },
    { small: 1.5 },
    { big: 2 ** 53 },
    { big: 2 ** 64 },
    { single: 1e39 },
    { wide: Infinity },
  ]) {
    assert.equal(await getValidator(new A({ ...inRange, ...outOfRange } as never)).validate(), false, JSON.stringify(outOfRange));
  }
});

test('parse rejects an int64 value beyond the safe integer range instead of rounding it', async t => {
  // protects: QA int64 precision: {"id":9007199254740993} became 9007199254740992 without an error
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { Format } from '@exprtlabs/golem/tags';`,
    fields: tsSource`id: number & Format<'int64'>; ratio: number & Format<'double'>`,
  }).text);
  await buildModelProjectWith(root, { mobx: false, validation: true });
  await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const codec = requireObjectCodec<{ id: number }>(generatedCodecIdFromRoot(root, 'TA'));
  assert.equal(codec.parse('{"id":9007199254740991,"ratio":9007199254740993}').id, 9007199254740991);
  assert.equal(codec.parse('{"id":-9007199254740991,"ratio":1}').id, -9007199254740991);
  for (const body of ['{"id":9007199254740993,"ratio":1}', '{"id":-9007199254740993,"ratio":1}']) {
    assert.throws(() => codec.parse(body), (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.causedByInput === true
      && JSON.stringify(error.issues[0].path) === '["id"]'
      && /JSON numbers in JavaScript/.test(error.issues[0].message), body);
  }
});
