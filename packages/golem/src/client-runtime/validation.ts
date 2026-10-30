import { LibError, LibErrorKind, IssueSource, IssueRepresentation, toIssue } from '../errors.js';
import type { OperationRuntimeValidators } from '../schema-registry-validation.js';
import { runValidation } from '../validation-runner.js';
import type { Validator } from '../validation-runtime.js';
import type { ClientRuntime, OperationCodecs, ResponseCheck } from './core.js';

// Exported from `@exprtlabs/golem/validation` and `@exprtlabs/golem/internal/client-validation-runtime`, which only SDKs generated with validation import; `@exprtlabs/golem/client` and `@exprtlabs/golem/internal/client-runtime` never reach this module.

async function assertValid(validator: Validator | undefined, value: unknown): Promise<void> {
  if (!validator) return;
  try {
    const result = await runValidation(validator, value);
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
  const resolved = { input: codecs.input, responses: new Map(Object.entries(codecs.responses ?? {})) };
  runtime.operationValidatorCache.set(operation, resolved);
  return resolved;
}

export function validateOperationInput(
  operation: string,
  value: unknown,
  validators: OperationRuntimeValidators | undefined,
): Promise<void> {
  const validator = validators?.input;
  if (!validator) throw new LibError(LibErrorKind.ValidationUnavailable, `Missing generated input validator for ${operation}`);
  return assertValid(validator, value);
}

/** The check `readResponse` runs on each decoded body or stream item; responses without content are not checked. */
export function responseCheck(validators: OperationRuntimeValidators): ResponseCheck {
  return (response, value) => response.contentType === null
    ? Promise.resolve()
    : assertValid(validators.responses.get(`${response.status}:${response.contentType}`), value);
}
