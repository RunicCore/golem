import assert from 'node:assert/strict';
import { Item } from './build/item.model.js';
import { decodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { getValidator } from '@exprtlabs/codegen/validation';

const model = decodeGeneratedModel(Item, { title: 123, count: 'bad' });
assert.equal(await getValidator(model).validate({ failFast: false }), false);
assert.equal(getValidator(model).issues.length, 2);
assert.equal('$makeObservable' in model, false);
