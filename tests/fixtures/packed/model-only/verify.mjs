import assert from 'node:assert/strict';
import { Item } from './build/item.model.js';
import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator } from '@exprtlabs/golem/validation';

// The script runs without the build rewrite, so it calls the codec the rewrite would bind.
const modelCodec = (model) => requireObjectCodec(findGeneratedModelDefinition(model).codecId);

const model = modelCodec(Item).fromWireFormat({ title: 123, count: 'bad' }, { construct: Item, validate: false });
assert.equal(await getValidator(model).validate({ failFast: false }), false);
assert.equal(getValidator(model).issues.length, 2);
assert.equal('$makeObservable' in model, false);
