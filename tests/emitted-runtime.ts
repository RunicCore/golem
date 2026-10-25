import * as conversion from '@exprtlabs/golem/conversion';
import * as serde from '@exprtlabs/golem/serde';
import { emitCodecRuntimeCode, render } from '@exprtlabs/golem/internal/emitter';

import { runModule } from './support/run-module.js';

/** The codec runtime of a schema graph as text. */
export function emitCodecRuntimeText(...args: Parameters<typeof emitCodecRuntimeCode>): string {
  return render(emitCodecRuntimeCode(...args));
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
