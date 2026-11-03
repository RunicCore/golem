// The plan entry of golem-model (`golem.plan`): it reads the `model` block of golem.yaml and declares the models job. It is light: it imports no TypeScript, no yaml and no generator code.
import fs from 'node:fs';
import path from 'node:path';
import type { GolemPlanEntry, JobFacts, ModelBoundaryValue, CodecsHostValue, GeneratorSession, GolemProfile, InputObserver, PlanContext, PlannedJob } from '@exprtlabs/golem/generator-api';
import type { Code } from '@exprtlabs/golem/internal/emitter';
import type { SchemaGraph, SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import { canonicalPath, checkedSuffixes, CODECS_HOST, displayPath, isInsideDirectory, isRecord, MODEL_BOUNDARY } from '@exprtlabs/golem/internal/plan-support';

/** Default directory for shared model files, relative to the models job root. */
export const DEFAULT_MODEL_OUTPUT = 'src/generated/models';

export function defaultModelOutput(root: string): string {
  return path.join(root, DEFAULT_MODEL_OUTPUT);
}

export interface ModelContext {
  readonly root: string;
  /** The golem.yaml's directory, whose `.golem/` holds the codec keys; defaults to `root`. */
  readonly directory?: string;
  /** File-name endings that make a file below `root/src` a model source; defaults to `.model.ts` and `.models.ts`. */
  readonly suffixes?: readonly string[];
  readonly output?: string;
  readonly sources?: readonly string[];
  /** The tsconfig the job's program opens from, absolute: the one the golem.yaml names. Omitted means the nearest `tsconfig.json` from `root` upward. */
  readonly tsconfig?: string;
  readonly profile: GolemProfile;
  /** The `golem.yaml` default for the `exact` option of a model that sets none; omitted means `true`. */
  readonly exact?: boolean;
  readonly manifestInputs?: readonly string[];
  /** The absolute output folders of the golem-mode SDK jobs in the same golem.yaml: the model job writes one codecs file for each (`sdkCodecsFile`). */
  readonly sdkOutputs?: readonly string[];
  readonly onInput?: InputObserver;
  readonly session?: GeneratorSession;
}

/** What the generator receives: the context of the models job without what the host adds. */
export type ModelOptions = Omit<ModelContext, 'onInput' | 'session'>;

/** The golem.yaml key of the block that this package registers (`golem.block` in its package.json). */
export const MODEL_BLOCK = 'model';

/** The hook where an extension changes the code the model job emits for a validator. Its participant type belongs to this package. */
export const VALIDATOR_ENHANCER_HOOK = 'model.validatorEnhancer';

/**
 * The participant of `VALIDATOR_ENHANCER_HOOK`. It takes nothing and returns the Code of the enhancer function that a class model passes as `enhanceValidator`,
 * which the generated file calls with each validator of a model that validates. At most one extension fills the hook.
 */
export type ValidatorEnhancerParticipant = () => Code;

/** The hook where an extension adds data, keyed by its name, to the codec the model job emits. Its participant type is `CodecDataParticipant`. */
export const CODEC_DATA_HOOK = 'model.codecData';

/**
 * The participant of `CODEC_DATA_HOOK`. It takes the schema graph and one node, and returns the value for that node's codec, or undefined for none. The
 * value must be JSON data. The model job writes it as `data: { <extension name>: <value> }`, and the extension adds the type of its key to
 * `CodecExtensionData` of `@exprtlabs/golem/internal/model-runtime` by declaration merging.
 */
export type CodecDataParticipant = (graph: SchemaGraph, node: SchemaNode) => unknown;

/** The file-name endings of a model file when the block lists none. */
export const DEFAULT_MODEL_SUFFIXES: readonly string[] = ['.model.ts', '.models.ts'];

/** The error for a `model.sources` entry whose real path is outside the golem.yaml folder: the yaml and the API stop with this text. */
export function outsideModelsRootMessage(entry: string, root: string): string {
  return `RUNM1075: model.sources entry ${displayPath(entry)} is outside the golem.yaml folder ${displayPath(root)}. The model block generates only files inside that folder.`;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

/** The block as a record: an empty `model:` is a block with every default. */
function blockOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new TypeError('model must be an object.');
  for (const key of Object.keys(value)) {
    if (!['sources', 'suffixes', 'output'].includes(key)) throw new Error(`Unknown model key: ${key}.`);
  }
  return value;
}

/** The folders the job owns, the narrowest first: a path with more segments lies inside, or apart from, the paths with fewer. */
function narrowToWide(folders: readonly string[]): readonly string[] {
  const unique = [...new Set(folders)];
  return unique.map((folder, index) => ({ folder, index, depth: folder.split(path.sep).length }))
    .sort((left, right) => right.depth - left.depth || left.index - right.index)
    .map(({ folder }) => folder);
}

export const plan: GolemPlanEntry<ModelOptions> = {
  declare({ directory, tsconfig, profile, exact, block, onInput }: PlanContext): readonly PlannedJob<ModelOptions>[] {
    const value = blockOf(block);
    // The job scans from the folder of golem.yaml.
    const root = canonicalPath(directory);
    onInput?.(root);
    const output = canonicalPath(value.output === undefined ? defaultModelOutput(root) : path.resolve(directory, nonempty(value.output, 'model.output')));
    if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new Error('model.output must be a directory.');
    let sources: string[] | undefined;
    if (value.sources !== undefined) {
      if (!Array.isArray(value.sources) || !value.sources.length) throw new Error('model.sources must be a nonempty array.');
      sources = value.sources.map((source): string => {
        const requested = path.resolve(directory, nonempty(source, 'model source'));
        onInput?.(requested);
        const resolved = canonicalPath(requested);
        onInput?.(resolved);
        return resolved;
      });
      if (new Set(sources).size !== sources.length) throw new Error('Duplicate model sources.');
      // The paths are real paths already, so a link to a file outside the root shows as that file.
      for (const source of sources) if (!isInsideDirectory(root, source)) throw new Error(outsideModelsRootMessage(source, root));
    }
    const sourceSuffixes = checkedSuffixes(value.suffixes, 'model.suffixes');
    const options: ModelOptions = {
      root, directory, output, tsconfig, profile,
      ...(exact === undefined ? {} : { exact }),
      ...(sources ? { sources } : {}),
      ...(sourceSuffixes ? { suffixes: sourceSuffixes } : {}),
    };
    const facts: JobFacts = {
      id: 'model',
      // The model folder is the job's own: nothing else writes in it, and the app imports its files.
      outputs: [{ path: output, kind: 'folder', importedByApp: true }],
      // A companion lies beside its source, anything else below the root.
      ownedRoots: narrowToWide([...(sources ?? []).map(source => path.dirname(source)), root]),
      // A source may be a file that an earlier job writes, so the job reads it after that job. A source in the job's own output is its own to write.
      inputFiles: (sources ?? []).filter(source => !isInsideDirectory(output, source)),
      inputFolders: [],
      readsProgram: true,
      provides: [MODEL_BOUNDARY, CODECS_HOST],
      needs: [],
      hooks: [VALIDATOR_ENHANCER_HOOK, CODEC_DATA_HOOK],
      // A job with a list of sources reads those and no others. Otherwise a file with a model ending in a folder the job owns or has read is a source, whether or not a run has read it.
      watch: sources ? [] : [{ suffixes: sourceSuffixes ?? DEFAULT_MODEL_SUFFIXES }],
    };
    const modelBoundary: ModelBoundaryValue = { root, directory, output, suffixes: sourceSuffixes ?? DEFAULT_MODEL_SUFFIXES };
    const codecsHost: CodecsHostValue = { modelsOutput: output, configDirectory: directory };
    return [{ facts, options, provided: { [MODEL_BOUNDARY]: modelBoundary, [CODECS_HOST]: codecsHost } }];
  },

  /** The job writes the codecs file of each golem SDK, so it reads the SDK folders of the jobs that need the codecs host. That orders it after them. */
  link(job, { consumers }) {
    const sdkOutputs = [...new Set((consumers[CODECS_HOST] ?? []).flatMap(consumer => consumer.outputs.filter(output => output.kind === 'folder').map(output => output.path)))].sort();
    if (!sdkOutputs.length) return job;
    return { facts: { ...job.facts, inputFolders: sdkOutputs }, options: { ...job.options, sdkOutputs } };
  },
};
