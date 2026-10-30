import { LibError, LibErrorKind, IssueSource, IssueRepresentation, toIssue } from '../errors.js';
import type { OperationRuntimeValidators } from '../schema-registry-validation.js';
import { serdeValidates, type ValidationLevel } from '../object-codec.js';
import { runValidation } from '../validation-runner.js';
import type { Validator } from '../validation-runtime.js';
import type { InboundChecks } from './body-codecs.js';
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

  const resolved = generatedValidators(operation, codecs);
  runtime.operationValidatorCache.set(operation, resolved);
  return resolved;
}

/** The validators that the generated codecs of an operation hold. */
function generatedValidators(operation: string, codecs: OperationCodecs): OperationRuntimeValidators {
  if (!codecs.input) throw new LibError(LibErrorKind.ValidationUnavailable, `Missing generated input validator for ${operation}`);
  return { input: codecs.input, ...(codecs.requestHeaders ? { requestHeaders: codecs.requestHeaders } : {}), responses: new Map(Object.entries(codecs.responses ?? {})), responseHeaders: new Map(Object.entries(codecs.responseHeaders ?? {})) };
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

/**
 * The check `readResponse` runs on each body or stream item at `level` and on each response header at `headerLevel`, before it is decoded;
 * responses without content have no body check. None when both levels are `false`.
 */
export function responseCheck(validators: OperationRuntimeValidators, level: ValidationLevel = true, headerLevel: ValidationLevel = false): ResponseCheck | undefined {
  if (level === false && headerLevel === false) return undefined;
  return (response, value, header) => {
    if (header !== undefined) {
      return headerLevel === false ? Promise.resolve() : assertValid(validators.responseHeaders?.get(`${response.status}:${header}`), value, headerLevel === 'sanity');
    }
    return level === false || response.contentType === null
      ? Promise.resolve()
      : assertValid(validators.responses.get(`${response.status}:${response.contentType}`), value, level === 'sanity');
  };
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
  return levelsOf(runtime.options.validate, call, sdkLevel);
}

function levelsOf(client: ValidateOption | undefined, call: ValidateOption | undefined, sdkLevel: true | 'sanity'): CallLevels {
  const fromCall = sidesOf(call);
  const fromClient = sidesOf(client);
  const level = (side: keyof Sides, unnamed: ValidationLevel): ValidationLevel => {
    const named = fromCall[side] === undefined ? fromClient[side] : fromCall[side];
    return named === undefined ? unnamed : serdeValidates({ validate: named as ValidationLevel }, sdkLevel);
  };
  return { request: level('request', sdkLevel), response: level('response', sdkLevel), requestHeaders: level('requestHeaders', false), responseHeaders: level('responseHeaders', false) };
}

/**
 * The checks of an inbound operation, at the levels of `validate` (the rule of `callLevels`: the binding's option, then the SDK's `sdkLevel`).
 * The wire request is checked as the client checks its wire input; the response of the application is checked as the client checks a response.
 */
export function inboundChecks(operation: string, codecs: OperationCodecs, validate: ValidateOption | undefined, sdkLevel: true | 'sanity'): InboundChecks {
  const levels = levelsOf(undefined, validate, sdkLevel);
  const validators = generatedValidators(operation, codecs);
  const response = responseCheck(validators, levels.response, levels.responseHeaders);
  return {
    request: (request) => validateOperationInput(operation, request, validators, levels),
    ...(response ? { response } : {}),
  };
}
