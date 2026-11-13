import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { code, identifier, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { emitCodecRuntimeText, instantiateRuntime } from './emitted-runtime.js';

// A named array (a recursive array alias is a named node of the schema graph) beside another array in an untagged union: the wire
// value cannot tell which of the two arrays takes it, so generation stops (F-39: golem rejects bad input, never coerces it).

const closed = (properties: Record<string, ModelTypeDescriptor>): ModelTypeDescriptor => ({ kind: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tree: ModelTypeDescriptor = { kind: 'array', item: closed({ label: { kind: 'string' } }) };
const codes: ModelTypeDescriptor = { kind: 'array', item: closed({ code: { kind: 'string' } }) };

/** The graph of a holder whose `items` is a union of a reference to the named array `Tree` and another array. */
function graphOf(reference: (treeId: string) => ModelTypeDescriptor) {
  const graph = createSchemaGraph();
  const treeNode = graph.intern(tree, 'Tree');
  graph.intern(closed({ items: { kind: 'union', variants: [reference(treeNode.codecId), codes] } }), 'Box');
  graph.seal();
  return graph;
}

const resolver: StringifySerdeResolver = {
  deserialize: (_serde, value) => code`decodeTree(${value} as never)`,
  serialize: (_serde, value) => code`encodeTree(${value} as never)`,
};

test('a named array with a serde of its own beside another array is decoded by its serde', () => {
  // protects: T-905 the serde of the reference was not read, so the union returned the value as it was and skipped the serde
  const treeWithSerde = (id: string): ModelTypeDescriptor => ({ kind: 'generated-model', id, serde: { id: 'tree', wire: { kind: 'array', item: { kind: 'string' } } } } as ModelTypeDescriptor);
  const source = emitCodecRuntimeText(graphOf(treeWithSerde), { serde: resolver, validatorName: (id) => identifier(`validate_${id.replace(/[^\w$]/g, '_')}`) });
  const runtime = instantiateRuntime(source, { decodeTree: () => 'decoded', encodeTree: () => 'encoded' });
  assert.deepEqual(runtime.fromWireFormatBox({ items: { kind: 'tree' } }, { validate: false }), { items: 'decoded' });
});
