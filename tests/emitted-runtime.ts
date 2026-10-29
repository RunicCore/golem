import * as runtime from '@exprtlabs/golem/internal/model-runtime';
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

/** Evaluate emitted `stringify*` functions with the model runtime exports in scope. */
export function instantiate(source: string): Record<string, (value: never) => string> {
  const names = [...source.matchAll(/function (stringify\w+)/g)].map((match) => match[1]);
  return runModule(source, {
    stringifyJsonString: runtime.stringifyJsonString,
    stringifyJsonNumber: runtime.stringifyJsonNumber,
    stringifyJsonBoolean: runtime.stringifyJsonBoolean,
    stringifyJsonArray: runtime.stringifyJsonArray,
    stringifyJsonScalar: runtime.stringifyJsonScalar,
  }, { exports: names }) as Record<string, (value: never) => string>;
}

export type RuntimeFunction = (...values: unknown[]) => unknown;

/** Evaluate an emitted codec runtime with the model runtime exports in scope. */
export function instantiateRuntime(
  source: string,
  scope: Readonly<Record<string, unknown>> = {},
): Record<string, RuntimeFunction> {
  const exported = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((match) => match[1]);
  return runModule(source.replace(/^export /gm, ''), { ...runtime, ...scope }, { exports: exported }) as Record<string, RuntimeFunction>;
}
