/**
 * Types shared by the benchmark harness and the fixture modules. This file is
 * copied into each temporary project's src/ as fixture-contract.ts, so it must
 * not import anything.
 */
export const OPERATIONS = ['object-to-model', 'model-to-object', 'text-to-model', 'model-to-text', 'validate'] as const;
export type Operation = typeof OPERATIONS[number];

/** Keys the fixture modules switch on. */
export const ADAPTERS = ['golem', 'golem-validated', 'golem-object', 'golem-object-off', 'control', 'class-transformer', 'class-validator', 'typia', 'zod', 'ajv'] as const;
export type Adapter = typeof ADAPTERS[number];

/** The reading operations on one broken variant of a payload. */
export type InvalidOperations = Partial<Record<Operation, () => unknown>>;

export interface ComparisonFixture {
  readonly name: string;
  readonly payload: unknown;
  readonly operations: Partial<Record<Operation, () => unknown>>;
  /**
   * A factory of the reading operations on one broken variant of the payload, for a validating build: each call must be rejected.
   * The worker calls it only in `invalid` mode, so a process that times valid input never builds a broken value (R5).
   */
  readonly invalidOperations?: () => InvalidOperations;
  consume(value: unknown): number;
  verify(): Promise<void>;
}

/**
 * An invalid-input call: `call` must throw an error that `isRejection` accepts, and the timed work is the throw and the catch.
 * Any other error is a program fault and propagates, so it is never timed as a rejection. It returns a positive number to consume.
 * @public The benchmark fixtures import it after project.ts copies them beside this file.
 */
export function rejects(call: () => unknown, isRejection: (error: unknown) => boolean): () => number {
  return () => {
    try { call(); } catch (error) {
      if (!isRejection(error)) throw error;
      return 1 + (error instanceof Error ? error.message.length : 0);
    }
    throw new Error('Invalid input was accepted');
  };
}

/**
 * An invalid-input check: `validate` must return false.
 * @public The benchmark fixtures import it after project.ts copies them beside this file.
 */
export function rejectsValidate(validate: () => boolean): () => number {
  return () => {
    if (validate()) throw new Error('Invalid input was accepted');
    return 1;
  };
}

export interface ComparisonModule {
  createComparisonFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]>;
}
