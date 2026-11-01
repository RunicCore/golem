import path from 'node:path';

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

/** One place a job looks for new files: the files below `folder` (absolute) with a name that ends with one of `suffixes`. */
interface WatchRule {
  /** Absolute. Without it, each of the job's `watchFolders` applies. */
  readonly folder?: string;
  readonly suffixes: readonly string[];
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
  /** Folders the job only reads and scans (it writes none of them). Each lies inside the tsconfig folder (F-42) and exists, unless an earlier job writes into it. They are never a write destination. Omitted means none. */
  readonly scanRoots?: readonly string[];
  /** Names of the hooks this job offers to extensions. */
  readonly hooks: readonly string[];
  /**
   * Where a new file reruns this job. A file added or removed inside `folder` whose name ends with one of `suffixes` reruns it. Without a `folder`, each folder of
   * `watchFolders` applies, so one entry can name every source below the folders the job owns, scans or reads. A file elsewhere is never seen.
   * A file that a job output holds never reruns a job by its name (`isJobOutput`). A file that the job read before reruns it without an entry. An empty list means none.
   */
  readonly watch: readonly WatchRule[];
}

/** Whether `filename` lies in an output that one of `jobs` writes: the output file itself, or a file below an output folder. Such a file is generated, so core never reruns a job because of it. */
function isJobOutput(jobs: readonly Pick<JobFacts, 'outputs'>[], filename: string): boolean {
  return jobs.some(({ outputs }) => outputs.some(output => (output.kind === 'file' ? output.path === filename : within(output.path, filename))));
}

type WatchedJob = Pick<JobFacts, 'watch' | 'ownedRoots' | 'scanRoots' | 'inputFolders'>;

/** The folders a rule applies to: its own, else the folders the job owns, scans or reads, and `observed`, the folders of the files it read in its last run. */
function ruleFolders(job: WatchedJob, { folder }: WatchRule, observed: readonly string[]): readonly string[] {
  return folder === undefined ? [...job.ownedRoots, ...job.scanRoots ?? [], ...job.inputFolders, ...observed] : [folder];
}

function ruleNames(job: WatchedJob, filename: string, observed: readonly string[]): boolean {
  return job.watch.some(rule => rule.suffixes.some(suffix => filename.endsWith(suffix)) && ruleFolders(job, rule, observed).some(folder => within(folder, filename)));
}

/**
 * The jobs a file reruns by name, for a file that no run has read: a job whose watch rule has the file inside its folder and its name ending with one of its suffixes.
 * A file that a job output holds is generated, so it reruns none. `observed` is each job's `observedFolders`; it lets a source added beside a file the job read outside
 * its own folders, such as in a shared folder, rerun it.
 */
export function watchingJobs<Job extends WatchedJob & Pick<JobFacts, 'id' | 'outputs'>>(jobs: readonly Job[], filename: string, observed: ReadonlyMap<string, readonly string[]>): Job[] {
  if (isJobOutput(jobs, filename)) return [];
  return jobs.filter(job => ruleNames(job, filename, observed.get(job.id) ?? []));
}

/** The folders of the files that job `id` read in its last run, from the run's map of each input to the jobs that read it. */
export function observedFolders(dependencies: ReadonlyMap<string, ReadonlySet<string>>, id: string): readonly string[] {
  const folders = new Set<string>();
  for (const [input, jobs] of dependencies) if (jobs.has(id)) folders.add(path.dirname(input));
  return [...folders];
}

/** The folders where a new file can match a watch rule of `job` without a run having read it: the watch lists them and their subfolders. */
export function watchFolders(job: WatchedJob): readonly string[] {
  return job.watch.flatMap(rule => ruleFolders(job, rule, []));
}

/** `plan-support` holds the same test, but it imports this file. */
function within(folder: string, filename: string): boolean {
  const relative = path.relative(folder, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
  /** Output paths of the later jobs, left out of the program this reader opens. The files of a later job that provides the models boundary are stubbed from the boundary instead. */
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
