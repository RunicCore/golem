import { runValidation } from './validation-runner.js';

export interface ValidationResult {
  valid: boolean;
  errors?: readonly unknown[] | null;
}

export interface RuntimeValidator {
  (value: unknown): boolean | Promise<boolean>;
  readonly errors?: readonly unknown[] | null;
}

/**
 * Adapter boundary for a JSON Schema implementation that supports the emitted
 * schemaDialect. Constraints not representable in TypeScript remain enforced
 * by this runtime engine.
 */
export interface RuntimeValidationEngine {
  addSchema(schema: object | boolean, id: string): void;
  getSchema(reference: string): RuntimeValidator | undefined;
}

export interface OperationRuntimeValidators {
  readonly input: RuntimeValidator;
  readonly responses: ReadonlyMap<string, RuntimeValidator>;
}

export async function validateWith(
  validator: RuntimeValidator,
  value: unknown,
): Promise<ValidationResult> {
  return runValidation(validator, value);
}
