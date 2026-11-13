import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { code, identifier, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { emitCodecRuntimeText, instantiateRuntime } from './emitted-runtime.js';

// A named array (a recursive array alias is a named node of the schema graph) beside another array in an untagged union: the wire
// value cannot tell which of the two arrays takes it, so generation stops (F-39: golem rejects bad input, never coerces it).

const closed = (properties: Record<string, ModelTypeDescriptor>): ModelTypeDescriptor => ({ kind: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const treeArray: ModelTypeDescriptor = { kind: 'array', item: closed({ label: { kind: 'string' } }) };
const treeObject = closed({ label: { kind: 'string' } });
const codes: ModelTypeDescriptor = { kind: 'array', item: closed({ code: { kind: 'string' } }) };

/** The runtime of a holder whose `items` is a union of a reference to the named node `Tree`, with a serde of its own, and another array. */
function runtimeSource(body: ModelTypeDescriptor): string {
  const graph = createSchemaGraph();
  const treeNode = graph.intern(body, 'Tree');
  const reference = { kind: 'generated-model', id: treeNode.codecId, serde: { id: 'tree', wire: { kind: 'array', item: { kind: 'string' } } } } as ModelTypeDescriptor;
  graph.intern(closed({ items: { kind: 'union', variants: [reference, codes] } }), 'Box');
  graph.seal();
  const resolver: StringifySerdeResolver = {
    deserialize: (_serde, value) => code`decodeTree(${value} as never)`,
    serialize: (_serde, value) => code`encodeTree(${value} as never)`,
  };
  return emitCodecRuntimeText(graph, { serde: resolver, validatorName: (id) => identifier(`validate_${id.replace(/[^\w$]/g, '_')}`) });
}

test('a named array with a serde of its own beside another array stops generation', () => {
  // protects: T-905 an array value took the inline array, so the serde of the reference never read its own array wire form
  assert.throws(() => runtimeSource(treeArray), /Union has ambiguous conversions/);
});

test('a named object with a serde of its own beside an array is decoded by its serde', () => {
  // protects: T-905 the rule above does not reach a serde reference whose node is no array: it reads its object value as before
  const runtime = instantiateRuntime(runtimeSource(treeObject), { decodeTree: () => 'decoded', encodeTree: () => 'encoded' });
  assert.deepEqual(runtime.fromWireFormatBox({ items: { kind: 'tree' } }, { validate: false }), { items: 'decoded' });
});
