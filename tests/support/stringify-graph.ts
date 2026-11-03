import { code, emitStringifyFunction, join, type Code, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import type { SchemaGraph } from '@exprtlabs/golem/internal/schema-graph';

import { NO_MODEL_BASES } from '../emitted-runtime.js';

/** The stringify functions of every node of a graph, in dependency order. */
export function emitGraphStringify(graph: SchemaGraph, serde?: StringifySerdeResolver): Code {
  return join(graph.topo().map((node) => emitStringifyFunction(node, graph, serde, { modelBases: NO_MODEL_BASES })), code`\n`);
}
