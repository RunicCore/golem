export interface OpsPerSec { readonly median: number; readonly min: number; readonly max: number }

export interface ResultCase {
  readonly payload: string;
  readonly operation: string;
  readonly adapter: string;
  readonly support: 'full' | 'none';
  readonly note?: string;
  readonly opsPerSec?: OpsPerSec;
}

export interface BenchmarkResults {
  /** 3 requires `cost`, `noise` and `invalid`. A file of schema 2 (measured before them) still passes `isBenchmarkResults`, so the page keeps working until a full run writes schema 3. */
  readonly schema: 2 | 3;
  readonly measuredAt: string;
  readonly git: { readonly sha: string; readonly dirty: boolean };
  readonly environment: { readonly node: string; readonly os: string; readonly arch: string; readonly cpu: string; readonly cpus: number };
  readonly packages: Readonly<Record<string, string>>;
  /** `rounds` is absent in files measured before adapters alternated (one round). */
  readonly settings: { readonly warmupMs: number; readonly batchMs: number; readonly batches: number; readonly rounds?: number };
  readonly groups: readonly { readonly id: string; readonly label: string; readonly description: string }[];
  readonly payloads: readonly { readonly id: string; readonly label: string; readonly bytes: number; readonly description: string; readonly sourceUrl: string }[];
  readonly operations: readonly { readonly id: 'parse' | 'stringify' | 'validate'; readonly label: string; readonly description: string }[];
  readonly adapters: readonly { readonly id: string; readonly group: string; readonly label: string; readonly library: string; readonly checked: boolean; readonly sourceUrl: string }[];
  readonly cases: readonly ResultCase[];
  /**
   * The timings that only the golem cost table needs, in the same shape as `cases` (operations `decode` and `encode`
   * included). The cost table is derived from `cases` and `cost.cases` together (`tables.ts`). Required from schema 3.
   */
  readonly cost?: { readonly cases: readonly ResultCase[] };
  /**
   * The timings of invalid input (parse, decode and validate of IModel with validation on), each taken in a process of its own.
   * The cost table divides them by the valid timings. Required from schema 3.
   */
  readonly invalid?: { readonly cases: readonly ResultCase[] };
  /** The noise of the run: the host load average (1, 5 and 15 minutes) at the start and the end, and the control's spread (`controlSpread` in results.ts). Required from schema 3. */
  readonly noise?: { readonly loadAverage: { readonly start: readonly number[]; readonly end: readonly number[] }; readonly controlSpread: number };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOps(value: unknown): value is OpsPerSec {
  return isObject(value) && [value.median, value.min, value.max].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isResultCase(c: unknown): boolean {
  return isObject(c)
    && typeof c.payload === 'string' && typeof c.operation === 'string' && typeof c.adapter === 'string'
    && (c.support === 'full' || c.support === 'none')
    && (c.support === 'full' || typeof c.note === 'string')
    && (c.support === 'none' ? c.opsPerSec === undefined : isOps(c.opsPerSec));
}

function isLoad(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(isCount);
}

function isNoise(value: unknown): boolean {
  return isObject(value) && isCount(value.controlSpread) && isObject(value.loadAverage) && isLoad(value.loadAverage.start) && isLoad(value.loadAverage.end);
}

function hasMetadata(value: Record<string, unknown>): boolean {
  const { git, environment: env, packages, settings } = value;
  return isString(value.measuredAt)
    && isObject(git) && isString(git.sha) && typeof git.dirty === 'boolean'
    && isObject(env) && [env.node, env.os, env.arch, env.cpu].every(isString) && isCount(env.cpus)
    && isObject(packages) && Object.values(packages).every(isString)
    && isObject(settings) && [settings.warmupMs, settings.batchMs, settings.batches, settings.rounds ?? 1].every(isCount);
}

/** Structural check used by the docs page before trusting a file. */
export function isBenchmarkResults(value: unknown): value is BenchmarkResults {
  if (!isObject(value) || (value.schema !== 2 && value.schema !== 3) || !hasMetadata(value)) return false;
  if (value.schema === 3 && (value.cost === undefined || value.noise === undefined || value.invalid === undefined)) return false;
  if (!Array.isArray(value.groups) || !Array.isArray(value.payloads) || !Array.isArray(value.operations) || !Array.isArray(value.adapters) || !Array.isArray(value.cases)) return false;
  if (!value.groups.every(g => isObject(g) && isString(g.id) && isString(g.label) && isString(g.description))) return false;
  const groupIds = new Set(value.groups.map(g => (g as { id: string }).id));
  if (!value.adapters.every(a => isObject(a) && isString(a.group) && groupIds.has(a.group))) return false;
  if (value.noise !== undefined && !isNoise(value.noise)) return false;
  for (const section of [value.cost, value.invalid]) {
    if (section !== undefined && !(isObject(section) && Array.isArray(section.cases) && section.cases.every(isResultCase))) return false;
  }
  return value.cases.every(isResultCase);
}
