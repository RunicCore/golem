import type { Adapter, Operation } from './fixture-contract.js';

/** Series colors the benchmark page defines (`--cg-series-N` in docs/.vitepress/theme/tokens.css); a group lists at most this many libraries. */
export const BENCH_SERIES_COUNT = 4;

export const REPOSITORY_BLOB_URL = 'https://github.com/RunicCore/golem/blob/master';

export type PayloadId = 'simple' | 'nested' | 'array' | 'checkout' | 'serde-none' | 'serde-many';
/** The operations of the compare table. */
export type CompareOperationId = 'parse' | 'stringify' | 'validate';
/** The operations that only the golem cost table times: value to and from a plain object, with no JSON text. */
export type CostOperationId = 'decode' | 'encode';
export type OperationId = CompareOperationId | CostOperationId;
export type AdapterId = 'golem' | 'golem-validated' | 'golem-object' | 'golem-object-off' | 'control' | 'class-transformer' | 'class-validator' | 'typia' | 'zod' | 'ajv';
export type GroupId = 'plain' | 'classes' | 'validated-classes';
export type Support = 'full' | 'none';
export type ProjectKind = 'plain' | 'validating';

export interface PayloadSpec { readonly id: PayloadId; readonly fixture: string; readonly label: string; readonly description: string; readonly sourceFile: string }
export interface OperationSpec<Id extends OperationId = OperationId> { readonly id: Id; readonly fixtureOperation: Operation; readonly label: string; readonly description: string }
export interface GroupSpec {
  readonly id: GroupId; readonly label: string; readonly description: string;
  readonly operations: Readonly<Record<CompareOperationId, readonly AdapterId[]>>;
  /** What each operation does in this group, shown beside the operation name. */
  readonly operationDescriptions: Readonly<Partial<Record<CompareOperationId, string>>>;
}
/**
 * `group` is the compare group of the adapter; an adapter with no group is in no compare table and only the cost table times it.
 * `plainObjects` marks a groupless adapter whose parse returns plain objects (the adapters of the `plain` group do already).
 */
export interface AdapterSpec { readonly id: AdapterId; readonly fixtureAdapter: Adapter; readonly project: ProjectKind; readonly group: GroupId | null; readonly plainObjects?: true; readonly label: string; readonly library: string; readonly checked: boolean; readonly sourceFile: string }
export interface CaseSpec { readonly payload: PayloadId; readonly operation: OperationId; readonly adapter: AdapterId; readonly support: Support; readonly note?: string }

export const PAYLOADS: readonly PayloadSpec[] = [
  { id: 'simple', fixture: 'ObjectSimple', label: 'Simple object', description: 'Four 3D points. Measures per-call overhead.', sourceFile: 'scripts/benchmark/fixtures/upstream/shared.ts' },
  { id: 'nested', fixture: 'ObjectHierarchical-Constrained', label: 'Nested object', description: 'A nested API record with integer, length, pattern and array-size constraints.', sourceFile: 'scripts/benchmark/fixtures/upstream/shared.ts' },
  { id: 'array', fixture: 'ArrayHierarchical-1000', label: 'Large array', description: 'One company, 10 departments, 1,000 employees.', sourceFile: 'scripts/benchmark/fixtures/upstream/shared.ts' },
  { id: 'checkout', fixture: 'sdk-extend', label: 'Checkout', description: 'Money from a generated SDK type, hex code, dates, nested line items, flags, a union and optional fields, with value conversion.', sourceFile: 'scripts/benchmark/fixtures/features/payloads.ts' },
];

/**
 * The payloads that only the golem cost table times: one shape of 21 fields, with every field converting (serde-many) or
 * none converting (serde-none). The compare table does not list them.
 */
export const COST_PAYLOADS: readonly PayloadSpec[] = [
  { id: 'serde-none', fixture: 'serde-none', label: 'Serde none', description: 'Twenty-one fields on plain strings and numbers: nothing converts.', sourceFile: 'scripts/benchmark/fixtures/features/payloads.ts' },
  { id: 'serde-many', fixture: 'serde-many', label: 'Serde many', description: 'The same shape with every field converting: money, hex codes, permission bits, yes/no flags, dates and date tuples.', sourceFile: 'scripts/benchmark/fixtures/features/payloads.ts' },
];

/** Every payload a run can time. */
export const ALL_PAYLOADS: readonly PayloadSpec[] = [...PAYLOADS, ...COST_PAYLOADS];

export const BENCH_OPERATIONS: readonly OperationSpec<CompareOperationId>[] = [
  { id: 'parse', fixtureOperation: 'text-to-model', label: 'Parse', description: 'JSON text to the library\'s model value.' },
  { id: 'stringify', fixtureOperation: 'model-to-text', label: 'Stringify', description: 'Model value to JSON text.' },
  { id: 'validate', fixtureOperation: 'validate', label: 'Validate', description: 'Check an already-decoded value.' },
];

/** Timed for the cost table only, beside the compare operations. */
export const COST_OPERATIONS: readonly OperationSpec<CostOperationId>[] = [
  { id: 'decode', fixtureOperation: 'object-to-model', label: 'Decode', description: 'A plain wire object to the model value.' },
  { id: 'encode', fixtureOperation: 'model-to-object', label: 'Encode', description: 'Model value to a plain wire object.' },
];

const F = 'scripts/benchmark/fixtures/upstream';

/** Libraries are compared only within a group, where every adapter does the same job. */
export const GROUPS: readonly GroupSpec[] = [
  { id: 'plain', label: 'Plain objects, validated', description: 'JSON text to validated plain objects and back. Golem uses an IObject declaration.',
    operations: { parse: ['golem-object', 'typia', 'zod', 'ajv'], stringify: ['golem-object', 'typia', 'zod', 'ajv'], validate: ['golem-object', 'typia', 'zod', 'ajv'] },
    operationDescriptions: { parse: 'JSON text to a checked plain object', stringify: 'plain object, checked, to JSON text', validate: 'check a plain object' } },
  { id: 'classes', label: 'Class instances', description: 'JSON text to class instances and back, without validation. Golem uses an IModel declaration.',
    operations: { parse: ['golem', 'class-transformer'], stringify: ['golem', 'class-transformer'], validate: [] },
    operationDescriptions: { parse: 'JSON text to instances of your classes', stringify: 'instances of your classes to JSON text' } },
  { id: 'validated-classes', label: 'Validated class instances', description: 'Class instances checked against their constraints.',
    operations: { parse: ['golem-validated', 'class-validator'], stringify: ['golem-validated', 'class-validator'], validate: ['golem-validated', 'class-validator'] },
    operationDescriptions: { parse: 'JSON text to checked instances of your classes', stringify: 'instances, checked, to JSON text', validate: 'check an instance' } },
];

export const BENCH_ADAPTERS: readonly AdapterSpec[] = [
  { id: 'golem-object', fixtureAdapter: 'golem-object', project: 'validating', group: 'plain', label: 'Golem (IObject)', library: '@exprtlabs/golem', checked: true, sourceFile: `${F}/golem-object.ts` },
  { id: 'golem-object-off', fixtureAdapter: 'golem-object-off', project: 'plain', group: null, plainObjects: true, label: 'Golem (IObject, validation off)', library: '@exprtlabs/golem', checked: false, sourceFile: `${F}/golem-object.ts` },
  { id: 'control', fixtureAdapter: 'control', project: 'plain', group: null, plainObjects: true, label: 'Native JSON (control)', library: 'JSON', checked: false, sourceFile: `${F}/control.ts` },
  { id: 'typia', fixtureAdapter: 'typia', project: 'plain', group: 'plain', label: 'Typia', library: 'typia', checked: true, sourceFile: `${F}/typia.ts` },
  { id: 'zod', fixtureAdapter: 'zod', project: 'plain', group: 'plain', label: 'Zod', library: 'zod', checked: true, sourceFile: `${F}/zod.ts` },
  { id: 'ajv', fixtureAdapter: 'ajv', project: 'plain', group: 'plain', label: 'Ajv', library: 'ajv', checked: true, sourceFile: `${F}/ajv.ts` },
  { id: 'golem', fixtureAdapter: 'golem', project: 'plain', group: 'classes', label: 'Golem (IModel)', library: '@exprtlabs/golem', checked: false, sourceFile: `${F}/golem.ts` },
  { id: 'class-transformer', fixtureAdapter: 'class-transformer', project: 'plain', group: 'classes', label: 'class-transformer', library: 'class-transformer', checked: false, sourceFile: `${F}/class-transformer.ts` },
  { id: 'golem-validated', fixtureAdapter: 'golem-validated', project: 'validating', group: 'validated-classes', label: 'Golem (IModel, validated)', library: '@exprtlabs/golem', checked: true, sourceFile: `${F}/golem.ts` },
  { id: 'class-validator', fixtureAdapter: 'class-validator', project: 'plain', group: 'validated-classes', label: 'class-transformer + class-validator', library: 'class-validator', checked: true, sourceFile: `${F}/class-validator.ts` },
];

const noConversion = (library: string): string => `${library} checks every rule but does not convert values, so the hex code and the dates would stay strings.`;
const UNSUPPORTED: readonly CaseSpec[] = (['typia', 'ajv'] as const).flatMap(adapter => BENCH_OPERATIONS.map(o =>
  ({ payload: 'checkout', operation: o.id, adapter, support: 'none', note: noConversion(adapterSpec(adapter).label) } satisfies CaseSpec)));

function buildCases(): readonly CaseSpec[] {
  const cases: CaseSpec[] = [];
  for (const group of GROUPS) {
    for (const operation of BENCH_OPERATIONS) {
      for (const payload of PAYLOADS) {
        for (const adapter of group.operations[operation.id]) {
          const unsupported = UNSUPPORTED.find(u => u.payload === payload.id && u.operation === operation.id && u.adapter === adapter);
          cases.push(unsupported ?? { payload: payload.id, operation: operation.id, adapter, support: 'full' });
        }
      }
    }
  }
  return cases;
}

/** The cases of the compare table, in table order. */
export const COMPARE_CASES: readonly CaseSpec[] = buildCases();

/**
 * The adapters of the cost table's validation columns. "Off" is a build with validation off, "on" a build with
 * validation on; the IModel pair is the class model, the IObject pair the plain-object codec.
 */
export const VALIDATION_COLUMNS = {
  imodel: { off: 'golem', on: 'golem-validated' },
  iobject: { off: 'golem-object-off', on: 'golem-object' },
} as const satisfies Record<string, Record<'off' | 'on', AdapterId>>;

/** The operations of a cost table row, in row order. */
export const COST_ROW_OPERATIONS: readonly OperationId[] = ['parse', 'stringify', 'decode', 'encode', 'validate'];

/**
 * The cases only the cost table times: every cost row of the four adapters that the compare table does not time already.
 * Validate has no "off" mode: a build with validation off has nothing to call.
 */
export const COST_CASES: readonly CaseSpec[] = ALL_PAYLOADS.flatMap(payload => COST_ROW_OPERATIONS.flatMap(operation =>
  Object.values(VALIDATION_COLUMNS).flatMap(pair => (['off', 'on'] as const)
    .filter(mode => operation !== 'validate' || mode === 'on')
    .map(mode => ({ payload: payload.id, operation, adapter: pair[mode], support: 'full' }) satisfies CaseSpec)
    .filter(c => !COMPARE_CASES.some(k => k.payload === c.payload && k.operation === c.operation && k.adapter === c.adapter)))));

/** The control times native JSON on the compare table's payloads; the spread of these numbers is the run's noise band. */
export const CONTROL_ID = 'control' satisfies AdapterId;
export const CONTROL_CASES: readonly CaseSpec[] = PAYLOADS.flatMap(payload =>
  (['parse', 'stringify'] as const).map(operation => ({ payload: payload.id, operation, adapter: CONTROL_ID, support: 'full' }) satisfies CaseSpec));

/** Every case a run can time. */
export const CASES: readonly CaseSpec[] = [...COMPARE_CASES, ...COST_CASES, ...CONTROL_CASES];

export function timedCases(): readonly CaseSpec[] {
  return CASES.filter(c => c.support !== 'none');
}

export function payloadSpec(id: PayloadId): PayloadSpec {
  const found = ALL_PAYLOADS.find(p => p.id === id);
  if (!found) throw new Error(`Unknown payload: ${id}`);
  return found;
}

export function operationSpec(id: OperationId): OperationSpec {
  const found = [...BENCH_OPERATIONS, ...COST_OPERATIONS].find(o => o.id === id);
  if (!found) throw new Error(`Unknown operation: ${id}`);
  return found;
}

export function adapterSpec(id: AdapterId): AdapterSpec {
  const found = BENCH_ADAPTERS.find(a => a.id === id);
  if (!found) throw new Error(`Unknown adapter: ${id}`);
  return found;
}
