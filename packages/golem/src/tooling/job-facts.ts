/**
 * What a job declares to core. A package's plan entry returns these facts for each job it adds; core derives the job order and checks outputs and contracts from them
 * (`job-rules.ts`). A fact names no package and no job kind. Every path is absolute and canonical: the caller resolves links before it declares a fact.
 */

/** A contract that core's rewrite needs by name: the models boundary. At most one job provides it, and the rewrite runs without it. */
export const MODEL_BOUNDARY = 'ModelBoundary';

/** A contract that core's SDK codec files need by name: the host of the codec files of golem SDKs. */
export const CODECS_HOST = 'CodecsHost';

/** A destination a job writes, and nothing else writes: a document file, an SDK folder. */
export interface JobOutput {
  readonly path: string;
  /** A `file` is one path; a `folder` is every path under it. */
  readonly kind: 'file' | 'folder';
  /** The app's program imports files of this output, so it lies inside the tsconfig folder (F-42). */
  readonly importedByApp?: boolean;
}

export interface JobFacts {
  /** Unique among the jobs of one config. It names the job in every message. */
  readonly id: string;
  /** Destinations only this job writes. They never overlap another, and none lies in golem.yaml or the `.golem/` folder. */
  readonly outputs: readonly JobOutput[];
  /** Folders the job owns without an exclusive claim: the models job owns its model folder, and an SDK inside the app is allowed. Each lies inside the tsconfig folder. */
  readonly ownedRoots: readonly string[];
  /** Files the job reads. A file that another job's output holds orders the reader after that job. */
  readonly inputFiles: readonly string[];
  /** Folders the job reads. Another job's output inside one, or one inside another job's folder output, orders the reader after that job. */
  readonly inputFolders: readonly string[];
  /** The job opens the app's program (a TypeScript program). This decides its order against the other jobs and how it sees their outputs. */
  readonly readsProgram: boolean;
  /** Names of the contracts this job provides. */
  readonly provides: readonly string[];
  /** Names of the contracts this job needs. A needed contract with no provider stops loading. */
  readonly needs: readonly string[];
  /** Names of the contracts this job wants: link() receives the value when exactly one job provides it. No provider is no error; two providers stay one. Omitted means none. */
  readonly wants?: readonly string[];
  /** Folders the job only reads and scans (it writes none of them). Each exists and lies inside the tsconfig folder (F-42). They are never a write destination. Omitted means none. */
  readonly scanRoots?: readonly string[];
  /** Names of the hooks this job offers to extensions. */
  readonly hooks: readonly string[];
  /** Patterns of the files whose change reruns this job. */
  readonly watch: readonly string[];
}

/** What core knows about the config as a whole, outside any job. */
export interface JobRuleContext {
  /** The golem.yaml file. No job output lies in it. */
  readonly configFile: string;
  /** The directory of the tsconfig that golem.yaml names. Roots and outputs that the app imports lie inside it. */
  readonly tsconfigDirectory: string;
}

/** What one program reader sees of the jobs that run after it. */
export interface ProgramView {
  /** Ids of the jobs after this reader that provide the models boundary. Core stubs their companion files from the boundary. */
  readonly stubbedProviders: readonly string[];
  /** Output paths of every other later job, left out of the program this reader opens. */
  readonly laterOutputs: readonly string[];
}

/** The result of the generic rules over one set of job facts. */
export interface JobPlan {
  /** Job ids in run order. */
  readonly order: readonly string[];
  /** The id of the job that provides each contract. */
  readonly providers: Readonly<Record<string, string>>;
  /** For each job that reads the program: what the later jobs leave in or out of it. */
  readonly programViews: Readonly<Record<string, ProgramView>>;
}
