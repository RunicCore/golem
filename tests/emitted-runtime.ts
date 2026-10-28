import * as conversion from '@exprtlabs/golem/conversion';
import * as serde from '@exprtlabs/golem/serde';
import { code, emitCodecRuntimeCode, join, MODULE_CONSTANT_HELPERS, placeHelpers, render, type Code, type ModelBases } from '@exprtlabs/golem/internal/emitter';

import { runModule } from './support/run-module.js';

/** The bases of a generator that declares none: a model narrows nothing. */
export const NO_MODEL_BASES: ModelBases = { basesOf: () => [] };

/** A Code as text, with the definitions of the helpers that a file defines for the code it holds (union selectors). */
export function renderWithHelpers(root: Code): string {
  return render(join([...placeHelpers(root, [], MODULE_CONSTANT_HELPERS), root], code``));
}

/** The codec runtime of a schema graph as text; a test that declares no bases gets none. */
export function emitCodecRuntimeText(graph: Parameters<typeof emitCodecRuntimeCode>[0], options: Omit<Parameters<typeof emitCodecRuntimeCode>[1], 'modelBases'> = {}): string {
  return renderWithHelpers(emitCodecRuntimeCode(graph, { ...options, modelBases: NO_MODEL_BASES }));
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
