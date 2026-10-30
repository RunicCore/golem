import { LibError, LibErrorKind, IssueSource, IssueRepresentation, toIssue } from '../errors.js';
import type { OperationRuntimeValidators } from '../schema-registry-validation.js';
import { serdeValidates, type ValidationLevel } from '../object-codec.js';
import { runValidation } from '../validation-runner.js';
import type { Validator } from '../validation-runtime.js';
import type { ClientRuntime, OperationCodecs, ResponseCheck, ValidateOption } from './core.js';

// Exported from `@exprtlabs/golem/validation` and `@exprtlabs/golem/internal/client-validation-runtime`, which only SDKs generated with validation import; `@exprtlabs/golem/client` and `@exprtlabs/golem/internal/client-runtime` never reach this module.

async function assertValid(validator: Validator | undefined, value: unknown, sanity: boolean): Promise<void> {
  if (!validator) return;
  try {
    const result = await runValidation(validator, value, true, sanity);
    if (!result.valid) {
      throw new LibError(LibErrorKind.Validation, 'API data validation failed.', result.issues.map((issue) => toIssue(issue, IssueSource.OpenAPI, IssueRepresentation.Wire)));
    }
  } catch (error) {
    if (error instanceof LibError) throw error;
    throw new LibError(LibErrorKind.Validation, 'API data validation could not finish.', [], { cause: error, causedByInput: false });
  }
}

/** The operation's validators: a caller override, then those of its generated codecs. Resolved once per runtime. */
export function operationValidators(
  runtime: ClientRuntime,
  operation: string,
  codecs: OperationCodecs,
): OperationRuntimeValidators {
  const cached = runtime.operationValidatorCache.get(operation);
  if (cached) return cached;
  const override = runtime.operationValidatorOverrides?.get(operation);
  if (override) {
    runtime.operationValidatorCache.set(operation, override);
    return override;
  }

  if (!codecs.input) throw new LibError(LibErrorKind.ValidationUnavailable, `Missing generated input validator for ${operation}`);
  const resolved = { input: codecs.input, ...(codecs.requestHeaders ? { requestHeaders: codecs.requestHeaders } : {}), responses: new Map(Object.entries(codecs.responses ?? {})) };
  runtime.operationValidatorCache.set(operation, resolved);
  return resolved;
}

/**
 * The wire input of a call: the input at the request level, and its header parameters at the request header level. Generated
 * validators check the two apart, so `header` is not part of the input they check; an override without header validator is
 * given the whole input.
 */
export async function validateOperationInput(
  operation: string,
  value: object,
  validators: OperationRuntimeValidators | undefined,
  levels: Pick<CallLevels, 'request' | 'requestHeaders'>,
): Promise<void> {
  const validator = validators?.input;
  if (levels.request !== false) {
    if (!validator) throw new LibError(LibErrorKind.ValidationUnavailable, `Missing generated input validator for ${operation}`);
    const { header, ...rest } = value as { readonly header?: unknown };
    await assertValid(validator, validators?.requestHeaders ? rest : value, levels.request === 'sanity');
    if (levels.requestHeaders !== false && validators?.requestHeaders) await assertValid(validators.requestHeaders, header ?? {}, levels.requestHeaders === 'sanity');
    return;
  }
  const { header } = value as { readonly header?: unknown };
  if (levels.requestHeaders !== false && validators?.requestHeaders) await assertValid(validators.requestHeaders, header ?? {}, levels.requestHeaders === 'sanity');
}

/** The check `readResponse` runs on each body or stream item at `level`, before it is decoded; responses without content are not checked. None at `false`. */
export function responseCheck(validators: OperationRuntimeValidators, level: ValidationLevel = true): ResponseCheck | undefined {
  if (level === false) return undefined;
  const sanity = level === 'sanity';
  return (response, value) => response.contentType === null
    ? Promise.resolve()
    : assertValid(validators.responses.get(`${response.status}:${response.contentType}`), value, sanity);
}

/** The validation level of each side of one call. */
export interface CallLevels {
  readonly request: ValidationLevel;
  readonly response: ValidationLevel;
  readonly requestHeaders: ValidationLevel;
  readonly responseHeaders: ValidationLevel;
}

type Sides = { readonly [Side in keyof CallLevels]?: unknown };

const SIDES: readonly string[] = ['request', 'response', 'requestHeaders', 'responseHeaders'];

/** The level of each side that `option` names; a level alone names the request and the response, never the headers. */
function sidesOf(option: unknown): Sides {
  if (option === undefined) return {};
  if (typeof option !== 'object' || option === null || Array.isArray(option)) return { request: option, response: option };
  const stray = Object.keys(option).find((key) => !SIDES.includes(key));
  if (stray !== undefined) throw new TypeError(`The validate option names ${SIDES.join(', ')}; got ${JSON.stringify(stray)}.`);
  return option;
}

/**
 * The levels of one call. Each side takes the level the call names, else the client's, else the SDK's `sdkLevel` (off for a header
 * side), which also caps them (`serdeValidates` decides: a level above the cap throws `ValidationUnavailable`, an unknown value a `TypeError`).
 */
export function callLevels(runtime: ClientRuntime, call: ValidateOption | undefined, sdkLevel: true | 'sanity'): CallLevels {
  const fromCall = sidesOf(call);
  const fromClient = sidesOf(runtime.options.validate);
  const level = (side: keyof Sides, unnamed: ValidationLevel): ValidationLevel => {
    const named = fromCall[side] === undefined ? fromClient[side] : fromCall[side];
    return named === undefined ? unnamed : serdeValidates({ validate: named as ValidationLevel }, sdkLevel);
  };
  return { request: level('request', sdkLevel), response: level('response', sdkLevel), requestHeaders: level('requestHeaders', false), responseHeaders: level('responseHeaders', false) };
}
