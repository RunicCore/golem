import assert from 'node:assert/strict';
const model = await import('@exprtlabs/golem/model');
const validation = await import('@exprtlabs/golem/validation');
class Item {}
model.registerGeneratedModel(Item, { fields: [] });
const item = new Item();
assert.deepEqual(model.findGeneratedModelDefinition(item).fields, []);
assert.equal(await validation.getValidator(item).extend({ label: () => true }).validate(), true);
