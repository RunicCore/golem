/// <reference path="./golem-models.ts" preserve="true" />
/**
 * IObject/IModel JSON and object-plane conversion.
 *
 * Public calls are `stringify<T>(value)` / `parse<T>(text)`.
 * `validate<T>(value)` lives on `@exprtlabs/golem/validation`.
 * `golem build`, the golem Vite and esbuild plugins and the Node loader rewrite
 * the type argument to the generated function. An unrewritten call throws.
 * Tests that run no rewrite import generated functions directly.
 */

import type { GeneratedModelValidatorEnhancer, WireFormat } from './model.js';
import { untransformedCallError, type SerdeOptions, type ValidateOptions } from './object-codec.js';

export {
  assertModelValue,
  isValidModelValue,
  modelValueIssues,
  createObjectCodec,
  findCodecIdForConstructor,
  getIModelClass,
  getObjectCodec,
  objectCodecValidationReference,
  parseJson,
  registerIModelClass,
  registerObjectCodec,
  requireIModelClass,
  requireObjectCodec,
  resolveModelValidationContextValidator,
  resolveGeneratedModelSchemaRefs,
  serdeFailFast,
  serdeValidates,
  stringifyJsonArray,
  stringifyJsonBoolean,
  stringifyJsonNumber,
  stringifyJsonScalar,
  stringifyJsonString,
  validationFailure,
  validationUnavailable,
} from './object-codec.js';
export type { ObjectCodec, ObjectCodecImpl, SerdeOptions, ValidateOptions, ValidationPlane } from './object-codec.js';
export type { WireFormat } from './model.js';

/** The JSON schemas the layer holds for one codec id. */
export type GolemCodecSchemas = object;

/** The serde functions the layer holds for one codec id. */
export interface GolemSerdeBinding {
  readonly serialize: (value: unknown) => unknown;
  readonly deserialize: (value: unknown) => unknown;
}

/** The MobX hook of the layer: the type of `enhanceValidatorWithMobX`. */
export type GolemValidatorEnhancer = GeneratedModelValidatorEnhancer;

/** What `#golem-models` exports: the profile, the validator hook, and the schemas and serde bindings by codec id. */
export interface GolemLayer {
  readonly profile: { readonly validation: boolean; readonly mobx: boolean };
  readonly enhanceValidator?: GolemValidatorEnhancer;
  readonly schemas: Readonly<Record<string, GolemCodecSchemas>>;
  readonly serdeBindings: Readonly<Record<string, GolemSerdeBinding>>;
}
export { IssueRepresentation, IssueSource } from './errors.js';

function untransformed(name: string): never {
  throw untransformedCallError(name);
}

export function stringify<T>(_value: T, _options?: SerdeOptions): string {
  untransformed('stringify');
}

export function parse<T>(_text: string, _options?: SerdeOptions): T {
  untransformed('parse');
}

export function assertValue<T>(_value: unknown, _options?: ValidateOptions): T {
  untransformed('assertValue');
}

export function toWireFormat<T>(_value: T, _options?: SerdeOptions): WireFormat<T> {
  untransformed('toWireFormat');
}

export function fromWireFormat<T>(_wire: unknown, _options?: SerdeOptions): T {
  untransformed('fromWireFormat');
}
