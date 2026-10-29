import type { SchemaIssue } from './issue-messages.js';
import type { Validator } from './validation-runtime.js';

/**
 * Runs a generated validator; the result is always a Promise, whether or not the validator finished at once.
 * `issues` is empty exactly when `valid`; with `all` false it holds at most the first issue.
 */
export async function runValidation(
  validator: Validator,
  value: unknown,
  all = true,
): Promise<{ readonly valid: boolean; readonly issues: readonly SchemaIssue[] }> {
  const issues: unknown = validator(value, all);
  // An override written for another contract (a boolean, a promise) must not read as "valid".
  if (!Array.isArray(issues)) throw new TypeError('A validator must return an array of issues.');
  return { valid: issues.length === 0, issues };
}
