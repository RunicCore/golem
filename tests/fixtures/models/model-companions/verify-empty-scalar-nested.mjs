import assert from 'node:assert/strict';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { Empty } from './build/empty.model.js';
import { Scalar } from './build/scalar.model.js';
import { Nested } from './build/nested.model.js';

for (const [model, values] of [
  [Empty, {}],
  [Scalar, { title: 'hello' }],
  [Nested, { data: { title: 'nested' } }],
]) {
  assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(model, values)), values);
  assert.throws(() => decodeGeneratedModel(model, null), (error) => error?.kind === 'deserialization' && error.causedByInput === true);
}
