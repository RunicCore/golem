import { transformSync } from 'esbuild';

import * as ajv from '@exprtlabs/codegen/ajv';
import * as conversion from '@exprtlabs/codegen/conversion';
import * as serde from '@exprtlabs/codegen/serde';

/** Evaluate emitted `stringify*` functions with the public serde exports in scope. */
export function instantiate(source: string): Record<string, (value: never) => string> {
  const names = [...source.matchAll(/function (stringify\w+)/g)].map((match) => match[1]);
  const javascript = transformSync(source, { loader: 'ts', target: 'es2022' }).code;
  return new Function(
    'stringifyJsonString',
    'stringifyJsonNumber',
    'stringifyJsonBoolean',
    'stringifyJsonArray',
    'stringifyJsonScalar',
    `${javascript}\nreturn { ${names.join(', ')} };`,
  )(
    serde.stringifyJsonString,
    serde.stringifyJsonNumber,
    serde.stringifyJsonBoolean,
    serde.stringifyJsonArray,
    serde.stringifyJsonScalar,
  ) as Record<string, (value: never) => string>;
}

export type RuntimeFunction = (...values: unknown[]) => unknown;

/** Evaluate an emitted codec runtime with the public runtime exports in scope. */
export function instantiateRuntime(
  source: string,
  scope: Readonly<Record<string, unknown>> = {},
): Record<string, RuntimeFunction> {
  const exported = [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]);
  const javascript = transformSync(source.replace(/^export /gm, ''), { loader: 'ts', target: 'es2022' }).code;
  const bindings: Record<string, unknown> = { ...serde, ...ajv, ...conversion, ...scope };
  const names = Object.keys(bindings).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const create = new Function(...names, `${javascript}\nreturn { ${exported.join(', ')} };`) as RuntimeFunction;
  return create(...names.map((name) => bindings[name])) as Record<string, RuntimeFunction>;
}
