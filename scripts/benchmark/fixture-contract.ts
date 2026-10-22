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

export interface ComparisonFixture {
  readonly name: string;
  readonly payload: unknown;
  readonly operations: Partial<Record<Operation, () => unknown>>;
  consume(value: unknown): number;
  verify(): Promise<void>;
}

export interface ComparisonModule {
  createComparisonFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]>;
}

/* Golem-only feature correctness (feature-check.ts). */
export const MODES = ['conversion-only', 'validating'] as const;
export type Mode = typeof MODES[number];
export const FEATURE_FIXTURES = ['reuse', 'nested-10', 'nested-200', 'compose', 'tagged', 'combined', 'sdk-extend'] as const;

export interface Fixture {
  readonly name: string;
  readonly payload?: unknown;
  readonly payloadBytes: number;
  readonly operations: Partial<Record<Operation, () => Promise<number>>>;
  verify(): Promise<void>;
}

export interface FixtureModule {
  createFixtures(validation: boolean): Promise<readonly Fixture[]>;
}
