// The plan entry of golem-openapi-ts (`golem.plan`): it reads the `openapi-ts` block of golem.yaml and declares one job for each entry of `sdks`. It is light: it imports no TypeScript, no yaml and no generator code.
import fs from 'node:fs';
import path from 'node:path';
import type { Code } from '@exprtlabs/golem/internal/emitter';
import type { CodecsHostValue, GolemDiagnostic, GolemPlanEntry, InputObserver, JobFacts, GolemProfile, PlanContext, PlannedJob } from '@exprtlabs/golem/generator-api';
import { canonicalPath, CODECS_HOST, isRecord, sdkCodecsFile } from '@exprtlabs/golem/internal/plan-support';

export interface OpenApiContext {
  readonly input: string;
  readonly output: string;
  readonly name?: string;
  readonly remoteHosts?: readonly string[];
  readonly maxRefBytes?: number;
  readonly maxRefDocuments?: number;
  readonly refTimeoutMs?: number;
  /** `temporal` maps `format: date-time`, `date` and `duration` to Temporal types; the default is `date`. */
  readonly dates?: 'date' | 'temporal';
  /** `standalone` (the default) is an SDK that needs no models job; `golem` leaves validators and conversion to the models job of the same golem.yaml. */
  readonly mode?: 'standalone' | 'golem';
  /** Mode `golem` only: the absolute path of the file the models job writes for this SDK and the operation modules import (`sdkCodecsFile`). The config sets it. */
  readonly codecsFile?: string;
  readonly profile: GolemProfile;
  readonly onInput?: InputObserver;
}

/** What the generator receives: the context of an SDK job without what the host adds. */
export type OpenApiOptions = Omit<OpenApiContext, 'onInput'>;

/** The hook where an extension wraps the operations that an SDK job emits. Its participant type belongs to this package. */
export const OPERATION_WRAPPER_HOOK = 'client.operationWrapper';

/** What an extension on `client.operationWrapper` makes of the operations: the type each operation function returns and the function that creates it. */
export interface OperationWrapper {
  readonly operationType: Code;
  readonly createOperation: Code;
}

/** The answer of a participant of `OPERATION_WRAPPER_HOOK`: the wrapper, or the diagnostic that stops the job for the mode it was asked about. */
export type OperationWrapperResult = { readonly wrapper: OperationWrapper } | { readonly diagnostic: GolemDiagnostic };

/** The participant of `OPERATION_WRAPPER_HOOK`. It takes the mode of the SDK job. At most one extension fills the hook. */
export type OperationWrapperParticipant = (mode: 'standalone' | 'golem') => OperationWrapperResult;

const BLOCK_KEYS: readonly string[] = ['sdks', 'extensions'];
const SDK_KEYS: readonly string[] = ['input', 'output', 'name', 'remoteHosts', 'maxRefBytes', 'maxRefDocuments', 'refTimeoutMs', 'dates', 'mode'];

function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}.`);
  }
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function positive(value: unknown, fallback: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return result;
}

/** The `sdks` list of the block: nothing when the block lists none, else a nonempty array. */
function sdksOf(block: unknown): readonly unknown[] {
  if (block === undefined || block === null) return [];
  keys(block, BLOCK_KEYS, 'openapi-ts');
  if (block.sdks === undefined) return [];
  if (!Array.isArray(block.sdks) || !block.sdks.length) throw new Error('openapi-ts.sdks must be a nonempty array of jobs.');
  return block.sdks;
}

/** The settings of the extensions the block turns on. Core has checked that each name is registered; the package checks what each holds. */
function checkExtensions(block: unknown): void {
  if (!isRecord(block) || block.extensions === undefined) return;
  if (!isRecord(block.extensions)) throw new TypeError('openapi-ts.extensions must be an object.');
  const mobx = block.extensions.mobx;
  if (mobx !== undefined && mobx !== null) keys(mobx, [], 'openapi-ts.extensions.mobx');
}

export const plan: GolemPlanEntry<OpenApiOptions> = {
  declare({ directory, profile, block, onInput }: PlanContext): readonly PlannedJob<OpenApiOptions>[] {
    checkExtensions(block);
    return sdksOf(block).map((entry, index): PlannedJob<OpenApiOptions> => {
      const label = `openapi-ts.sdks[${index}]`;
      keys(entry, SDK_KEYS, label);
      const requested = path.resolve(directory, nonempty(entry.input, `${label}.input`));
      onInput?.(requested);
      const input = canonicalPath(requested);
      onInput?.(input);
      const output = canonicalPath(path.resolve(directory, nonempty(entry.output, `${label}.output`)));
      if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new Error(`${label}.output must be a directory.`);
      if (entry.remoteHosts !== undefined && !Array.isArray(entry.remoteHosts)) throw new Error(`${label}.remoteHosts must be an array of nonempty hostnames.`);
      const remoteHosts = (entry.remoteHosts ?? []).map((host: unknown) => nonempty(host, `${label}.remoteHosts`));
      if (entry.dates !== undefined && entry.dates !== 'date' && entry.dates !== 'temporal') throw new Error(`${label}.dates must be "date" or "temporal".`);
      if (entry.mode !== undefined && entry.mode !== 'standalone' && entry.mode !== 'golem') throw new Error(`${label}.mode must be "standalone" or "golem".`);
      const mode = entry.mode ?? 'standalone';
      const options: OpenApiOptions = {
        input, output, profile, remoteHosts, mode,
        ...(entry.name === undefined ? {} : { name: nonempty(entry.name, `${label}.name`) }),
        ...(entry.dates === undefined ? {} : { dates: entry.dates }),
        maxRefBytes: positive(entry.maxRefBytes, 5 * 1024 * 1024, `${label}.maxRefBytes`),
        maxRefDocuments: positive(entry.maxRefDocuments, 256, `${label}.maxRefDocuments`),
        refTimeoutMs: positive(entry.refTimeoutMs, 10000, `${label}.refTimeoutMs`),
      };
      const facts: JobFacts = {
        id: `openapi:${path.relative(directory, output) || '.'}`,
        outputs: [{ path: output, kind: 'folder' }],
        ownedRoots: [],
        inputFiles: [input],
        inputFolders: [],
        readsProgram: false,
        provides: [],
        // A golem SDK imports the codecs file that the host of the codecs writes for it.
        needs: mode === 'golem' ? [CODECS_HOST] : [],
        hooks: [OPERATION_WRAPPER_HOOK],
        watch: [],
      };
      return { facts, options };
    });
  },

  /** A golem SDK imports the file that the codecs host writes for it; the job writes only the import. */
  link(job, { needed }) {
    const host = needed[CODECS_HOST] as CodecsHostValue | undefined;
    if (host === undefined) return job;
    return { facts: job.facts, options: { ...job.options, codecsFile: sdkCodecsFile({ ...host, sdkOutput: job.options.output }) } };
  },
};
