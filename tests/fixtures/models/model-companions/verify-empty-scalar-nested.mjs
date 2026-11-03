import assert from 'node:assert/strict';
import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { Empty } from './build/empty.model.js';
import { Scalar } from './build/scalar.model.js';
import { Nested } from './build/nested.model.js';


// The script runs without the build rewrite, so it calls the codec the rewrite would bind.
const modelCodec = (model) => requireObjectCodec(findGeneratedModelDefinition(model).codecId);

for (const [model, values] of [
  [Empty, {}],
  [Scalar, { title: 'hello' }],
  [Nested, { data: { title: 'nested' } }],
]) {
  const codec = modelCodec(model);
  assert.deepEqual(codec.toWireFormat(codec.fromWireFormat(values, { construct: model })), values);
  assert.throws(() => codec.fromWireFormat(null, { construct: model }), (error) => error?.kind === 'validation' && error.causedByInput === true);
}
