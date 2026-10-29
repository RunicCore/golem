import assert from 'node:assert/strict';
import { validateInstance } from '@exprtlabs/golem/validation';
import { requireObjectCodec, findGeneratedModelDefinition } from '@exprtlabs/golem/internal/model-runtime';

const count = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(count) && count > 0, 'model count must be a positive integer');

for (let index = 0; index < count; index++) {
  const module = await import(`./build/item-${index}.model.js`);
  const Model = module[`Item${index}`];
  const instance = new Model({ label: 'valid', count: index });
  assert.deepEqual(await validateInstance(instance), []);
  const codecId = findGeneratedModelDefinition(instance)?.codecId;
  assert.ok(codecId);
  const codec = requireObjectCodec(codecId);
  assert.deepEqual(JSON.parse(codec.stringify(instance)), { label: 'valid', count: index });
  instance.label = 'x';
  const issues = await validateInstance(instance);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].path, ['label']);
}
