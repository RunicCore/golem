import type { ModelRuntimeValidator } from './model.js';
import { copyValidationErrors } from './validation-issues.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly unknown[];
}

interface ActiveRun {
  completion?: Promise<void>;
  release?: () => void;
}

const activeRuns = new WeakMap<ModelRuntimeValidator, ActiveRun>();

function completion(run: ActiveRun): Promise<void> {
  return run.completion ??= new Promise<void>(resolve => { run.release = resolve; });
}

function snapshot(valid: boolean, validator: ModelRuntimeValidator): ValidationResult {
  return { valid, errors: copyValidationErrors(validator.errors ?? []) };
}

/** Sync-capable validation run. Public `runValidation` always returns a Promise. */
export function runValidationNow(
  validator: ModelRuntimeValidator,
  value: unknown,
): ValidationResult | Promise<ValidationResult> {
  const previous = activeRuns.get(validator);
  if (previous) {
    return completion(previous).then(() => runValidationNow(validator, value));
  }
  const current: ActiveRun = {};
  activeRuns.set(validator, current);
  const finish = (): void => {
    current.release?.();
    if (activeRuns.get(validator) === current) activeRuns.delete(validator);
  };
  try {
    const result = validator(value);
    if (typeof result === 'boolean') {
      const outcome = snapshot(result, validator);
      finish();
      return outcome;
    }
    if (result === null || typeof result !== 'object' || typeof result.then !== 'function') {
      throw new TypeError('A validation engine must return a boolean result.');
    }
    return Promise.resolve(result).then(
      (valid) => {
        try {
          if (typeof valid !== 'boolean') throw new TypeError('A validation engine must return a boolean result.');
          return snapshot(valid, validator);
        } finally {
          finish();
        }
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    );
  } catch (error) {
    finish();
    throw error;
  }
}

/** Ajv validators publish mutable `.errors`: capture them before another caller can run. */
export async function runValidation(
  validator: ModelRuntimeValidator,
  value: unknown,
): Promise<ValidationResult> {
  return runValidationNow(validator, value);
}
