/**
 * IObject/IModel JSON and object-plane conversion.
 *
 * Public calls are `stringify<T>(value)` / `parse<T>(text)`.
 * `validate<T>(value)` lives on `@exprtlabs/golem/validation`.
 * `golem build`, the golem Vite and esbuild plugins and the Node loader rewrite
 * the type argument to the generated function. An unrewritten call throws.
 * Tests that run no rewrite import generated functions directly.
 */

import type { WireFormat } from './model.js';
import { untransformedCallError, type AllowGetterOptions, type SerdeOptions, type ValidateOptions } from './object-codec.js';

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
  serdeFailFast,
  serdeValidates,
  serdeWithoutValidation,
  stringifyJsonArray,
  stringifyJsonBoolean,
  stringifyJsonNumber,
  stringifyJsonScalar,
  stringifyJsonString,
  validationFailure,
  validationUnavailable,
  validationUnavailableStub,
} from './object-codec.js';
export { withoutInstanceState } from './presence.js';
export type { AllowGetterOptions, ObjectCodec, ObjectCodecImpl, SerdeOptions, ValidateOptions, ValidationPlane } from './object-codec.js';
export type { WireFormat } from './model.js';
export { IssueRepresentation, IssueSource } from './errors.js';

function untransformed(name: string): never {
  throw untransformedCallError(name);
}

export function stringify<T>(_value: T, _options?: SerdeOptions & AllowGetterOptions): string {
  untransformed('stringify');
}

export function parse<T>(_text: string, _options?: SerdeOptions): T {
  untransformed('parse');
}

export function assertValue<T>(_value: unknown, _options?: ValidateOptions & AllowGetterOptions): T {
  untransformed('assertValue');
}

export function toWireFormat<T>(_value: T, _options?: SerdeOptions & AllowGetterOptions): WireFormat<T> {
  untransformed('toWireFormat');
}

export function fromWireFormat<T>(_wire: unknown, _options?: SerdeOptions): T {
  untransformed('fromWireFormat');
}
