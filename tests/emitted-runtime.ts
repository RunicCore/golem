import * as conversion from '@exprtlabs/golem/conversion';
import * as serde from '@exprtlabs/golem/serde';
import { emitCodecRuntimeCode, render, type ModelBases } from '@exprtlabs/golem/internal/emitter';

import { runModule } from './support/run-module.js';

/** The bases of a generator that declares none: a model narrows nothing. */
export const NO_MODEL_BASES: ModelBases = { basesOf: () => [] };

/** The codec runtime of a schema graph as text; a test that declares no bases gets none. */
export function emitCodecRuntimeText(graph: Parameters<typeof emitCodecRuntimeCode>[0], options: Parameters<typeof emitCodecRuntimeCode>[1] = {}): string {
  return render(emitCodecRuntimeCode(graph, { modelBases: NO_MODEL_BASES, ...options }));
}

/** Evaluate emitted `stringify*` functions with the public serde exports in scope. */
export function instantiate(source: string): Record<string, (value: never) => string> {
  const names = [...source.matchAll(/function (stringify\w+)/g)].map((match) => match[1]);
  return runModule(source, {
    stringifyJsonString: serde.stringifyJsonString,
    stringifyJsonNumber: serde.stringifyJsonNumber,
    stringifyJsonBoolean: serde.stringifyJsonBoolean,
    stringifyJsonArray: serde.stringifyJsonArray,
    stringifyJsonScalar: serde.stringifyJsonScalar,
  }, { exports: names }) as Record<string, (value: never) => string>;
}

export type RuntimeFunction = (...values: unknown[]) => unknown;

/** Evaluate an emitted codec runtime with the public runtime exports in scope. */
export function instantiateRuntime(
  source: string,
  scope: Readonly<Record<string, unknown>> = {},
): Record<string, RuntimeFunction> {
  const exported = [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]);
  return runModule(source.replace(/^export /gm, ''), { ...serde, ...conversion, ...scope }, { exports: exported }) as Record<string, RuntimeFunction>;
}
