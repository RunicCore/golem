import type { SchemaIssue } from './issue-messages.js';
import type { Validator } from './validation-runtime.js';

export interface ValidationResult {
  readonly valid: boolean;
  /** Empty exactly when `valid`; with `all` false it holds at most the first issue. */
  readonly issues: readonly SchemaIssue[];
}

/** Runs a generated validator; the result is always a Promise, whether or not the validator finished at once. */
export async function runValidation(
  validator: Validator,
  value: unknown,
  all = true,
): Promise<ValidationResult> {
  const issues = validator(value, all);
  return { valid: issues.length === 0, issues };
}
