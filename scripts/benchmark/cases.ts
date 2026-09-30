import type { Adapter, Operation } from './fixture-contract.js';

export const REPOSITORY_BLOB_URL = 'https://github.com/exprtlabs/codegen/blob/main';

export type PayloadId = 'simple' | 'nested' | 'array' | 'checkout';
export type OperationId = 'parse' | 'stringify' | 'validate';
export type AdapterId = 'codegen' | 'codegen-standalone' | 'codegen-runtime' | 'codegen-object' | 'class-transformer' | 'class-validator' | 'typia' | 'zod';
export type GroupId = 'plain' | 'classes' | 'validated-classes';
export type Support = 'full' | 'none';
export type ProjectKind = 'plain' | 'runtime' | 'standalone';

export interface PayloadSpec { readonly id: PayloadId; readonly fixture: string; readonly label: string; readonly description: string; readonly sourceFile: string }
export interface OperationSpec { readonly id: OperationId; readonly fixtureOperation: Operation; readonly label: string; readonly description: string }
export interface GroupSpec {
  readonly id: GroupId; readonly label: string; readonly description: string;
  readonly operations: Readonly<Record<OperationId, readonly AdapterId[]>>;
  /** What each operation does in this group, shown beside the operation name. */
  readonly operationDescriptions: Readonly<Partial<Record<OperationId, string>>>;
}
export interface AdapterSpec { readonly id: AdapterId; readonly fixtureAdapter: Adapter; readonly project: ProjectKind; readonly group: GroupId; readonly label: string; readonly library: string; readonly checked: boolean; readonly sourceFile: string }
export interface CaseSpec { readonly payload: PayloadId; readonly operation: OperationId; readonly adapter: AdapterId; readonly support: Support; readonly note?: string }

export const PAYLOADS: readonly PayloadSpec[] = [
  { id: 'simple', fixture: 'ObjectSimple', label: 'Simple object', description: 'Four 3D points. Measures per-call overhead.', sourceFile: 'scripts/benchmark/fixtures/upstream/shared.ts' },
  { id: 'nested', fixture: 'ObjectHierarchical-Constrained', label: 'Nested object', description: 'A nested API record with integer, length, pattern and array-size constraints.', sourceFile: 'scripts/benchmark/fixtures/upstream/shared.ts' },
  { id: 'array', fixture: 'ArrayHierarchical-1000', label: 'Large array', description: 'One company, 10 departments, 1,000 employees.', sourceFile: 'scripts/benchmark/fixtures/upstream/shared.ts' },
  { id: 'checkout', fixture: 'sdk-extend', label: 'Checkout', description: 'Money from a generated SDK type, hex code, dates, nested line items, flags, a union and optional fields, with value conversion.', sourceFile: 'scripts/benchmark/fixtures/features/payloads.ts' },
];

export const BENCH_OPERATIONS: readonly OperationSpec[] = [
  { id: 'parse', fixtureOperation: 'text-to-model', label: 'Parse', description: 'JSON text to the library\'s model value.' },
  { id: 'stringify', fixtureOperation: 'model-to-text', label: 'Stringify', description: 'Model value to JSON text.' },
  { id: 'validate', fixtureOperation: 'validate', label: 'Validate', description: 'Check an already-decoded value.' },
];

const F = 'scripts/benchmark/fixtures/upstream';

/** Libraries are compared only within a group, where every adapter does the same job. */
export const GROUPS: readonly GroupSpec[] = [
  { id: 'plain', label: 'Plain objects, validated', description: 'JSON text to validated plain objects and back. Golem uses an IObject declaration.',
    operations: { parse: ['codegen-object', 'typia', 'zod'], stringify: ['codegen-object', 'typia', 'zod'], validate: ['codegen-object', 'typia', 'zod'] },
    operationDescriptions: { parse: 'JSON text to a checked plain object', stringify: 'plain object, checked, to JSON text', validate: 'check a plain object' } },
  { id: 'classes', label: 'Class instances', description: 'JSON text to class instances and back, without validation. Golem uses an IModel declaration.',
    operations: { parse: ['codegen', 'class-transformer'], stringify: ['codegen', 'class-transformer'], validate: [] },
    operationDescriptions: { parse: 'JSON text to instances of your classes', stringify: 'instances of your classes to JSON text' } },
  { id: 'validated-classes', label: 'Validated class instances', description: 'Class instances checked against their constraints.',
    operations: { parse: ['codegen-standalone', 'class-validator'], stringify: ['codegen-standalone', 'class-validator'], validate: ['codegen-standalone', 'codegen-runtime', 'class-validator'] },
    operationDescriptions: { parse: 'JSON text to checked instances of your classes', stringify: 'instances, checked, to JSON text', validate: 'check an instance' } },
];

export const BENCH_ADAPTERS: readonly AdapterSpec[] = [
  { id: 'codegen-object', fixtureAdapter: 'codegen-object', project: 'standalone', group: 'plain', label: 'Golem (IObject)', library: '@exprtlabs/golem', checked: true, sourceFile: `${F}/codegen-object.ts` },
  { id: 'typia', fixtureAdapter: 'typia', project: 'plain', group: 'plain', label: 'Typia', library: 'typia', checked: true, sourceFile: `${F}/typia.ts` },
  { id: 'zod', fixtureAdapter: 'zod', project: 'plain', group: 'plain', label: 'Zod', library: 'zod', checked: true, sourceFile: `${F}/zod.ts` },
  { id: 'codegen', fixtureAdapter: 'codegen', project: 'plain', group: 'classes', label: 'Golem (IModel)', library: '@exprtlabs/golem', checked: false, sourceFile: `${F}/codegen.ts` },
  { id: 'class-transformer', fixtureAdapter: 'class-transformer', project: 'plain', group: 'classes', label: 'class-transformer', library: 'class-transformer', checked: false, sourceFile: `${F}/class-transformer.ts` },
  { id: 'codegen-standalone', fixtureAdapter: 'codegen-standalone', project: 'standalone', group: 'validated-classes', label: 'Golem (IModel, validated)', library: '@exprtlabs/golem', checked: true, sourceFile: `${F}/codegen.ts` },
  { id: 'codegen-runtime', fixtureAdapter: 'codegen-runtime', project: 'runtime', group: 'validated-classes', label: 'Golem (IModel, runtime Ajv)', library: '@exprtlabs/golem', checked: true, sourceFile: `${F}/codegen.ts` },
  { id: 'class-validator', fixtureAdapter: 'class-validator', project: 'plain', group: 'validated-classes', label: 'class-validator', library: 'class-validator', checked: true, sourceFile: `${F}/class-validator.ts` },
];

const TYPIA_CHECKOUT = 'Typia checks JSON shapes but does not convert values, so the hex code and the dates would stay strings.';
const UNSUPPORTED: readonly CaseSpec[] = BENCH_OPERATIONS.map(o => ({ payload: 'checkout', operation: o.id, adapter: 'typia', support: 'none', note: TYPIA_CHECKOUT }));

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

export const CASES: readonly CaseSpec[] = buildCases();

export function timedCases(): readonly CaseSpec[] {
  return CASES.filter(c => c.support !== 'none');
}

export function payloadSpec(id: PayloadId): PayloadSpec {
  const found = PAYLOADS.find(p => p.id === id);
  if (!found) throw new Error(`Unknown payload: ${id}`);
  return found;
}

export function operationSpec(id: OperationId): OperationSpec {
  const found = BENCH_OPERATIONS.find(o => o.id === id);
  if (!found) throw new Error(`Unknown operation: ${id}`);
  return found;
}

export function adapterSpec(id: AdapterId): AdapterSpec {
  const found = BENCH_ADAPTERS.find(a => a.id === id);
  if (!found) throw new Error(`Unknown adapter: ${id}`);
  return found;
}
