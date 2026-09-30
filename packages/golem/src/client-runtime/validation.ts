import { LibError, LibErrorKind, IssueSource, IssueRepresentation } from '../errors.js';
import type { OperationRuntimeValidators, RuntimeValidator } from '../schema-registry-validation.js';
import { issuesFromErrors } from '../validation-issues.js';
import { runValidation } from '../validation-runner.js';
import type { ClientRuntime, OperationValidationSources, ResponseCheck } from './core.js';

// Exported from `@exprtlabs/golem/validation`, which only SDKs generated with validation import; `@exprtlabs/golem/client` never reaches this module.

async function assertValid(validator: RuntimeValidator | undefined, value: unknown): Promise<void> {
  if (!validator) return;
  try {
    const result = await runValidation(validator, value);
    if (!result.valid) {
      throw new LibError(LibErrorKind.Validation, 'API data validation failed.', issuesFromErrors(result.errors, value, IssueSource.OpenAPI, IssueRepresentation.Wire));
    }
  } catch (error) {
    if (error instanceof LibError) throw error;
    throw new LibError(LibErrorKind.Validation, 'API data validation could not finish.', [], { cause: error, causedByInput: false });
  }
}

/** The operation's validators: a caller override, then the generated standalone set, then the runtime's engine. Resolved once per runtime. */
export function operationValidators(
  runtime: ClientRuntime,
  operation: string,
  resolveSources: () => OperationValidationSources,
): OperationRuntimeValidators {
  const cached = runtime.operationValidatorCache.get(operation);
  if (cached) return cached;
  const override = runtime.operationValidatorOverrides?.get(operation);
  if (override) {
    runtime.operationValidatorCache.set(operation, override);
    return override;
  }

  const sources = resolveSources();
  if (sources.standaloneValidators) {
    const resolved = sources.standaloneValidators();
    runtime.operationValidatorCache.set(operation, resolved);
    return resolved;
  }
  const engine = runtime.validationEngine;
  if (!engine) {
    throw new LibError(LibErrorKind.ValidationUnavailable, `Missing validation engine for operation ${operation}`);
  }
  for (const [id, schema] of sources.schemas) {
    if (!engine.getSchema(id)) engine.addSchema(schema, id);
  }
  const input = engine.getSchema(sources.inputReference);
  if (!input) {
    throw new LibError(LibErrorKind.ValidationUnavailable, `Runtime validator could not compile operation input: ${operation}`);
  }
  const responses = new Map<string, RuntimeValidator>();
  for (const item of sources.responseReferences) {
    const validator = engine.getSchema(item.reference);
    if (!validator) {
      throw new LibError(LibErrorKind.ValidationUnavailable, `Runtime validator could not compile operation response: ${operation} ${item.status} ${item.contentType}`);
    }
    responses.set(`${item.status}:${item.contentType}`, validator);
  }
  const resolved = { input, responses };
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
