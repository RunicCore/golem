import { runValidation, type ValidationResult } from './validation-runner.js';
import type { Validator } from './validation-runtime.js';

export type { ValidationResult };

/** The validators of one operation: its input and the body of each response, keyed `<status>:<content type>`. */
export interface OperationRuntimeValidators {
  readonly input: Validator;
  readonly responses: ReadonlyMap<string, Validator>;
}

export async function validateWith(
  validator: Validator,
  value: unknown,
  all = true,
): Promise<ValidationResult> {
  return runValidation(validator, value, all);
}
