import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GolemConfig, GolemJob } from './config.js';
import { GolemDiagnosticSeverity, compareText, hasErrorCode, isInsideDirectory, isRecord, stableJson } from './generator-core.js';
import type { GolemDiagnostic } from './generator-core.js';
import { loadedFilesUnder } from './load-record.js';
import type { EnabledExtension } from './rewrite-participant.js';
import { atomicWrite, digest, loadInventory } from './outputs.js';
import type { Inventory, InventoryEntry, OutputFiles } from './outputs.js';

/**
 * What one job read and wrote the last time it ran, kept in `.golem/jobs.json` beside `.golem/outputs.json`. A later run
 * skips a job whose record is still true. Every path is relative to the directory of golem.yaml, with `/` separators.
 */
export interface JobRecord {
  /** The digest of the JavaScript of the golem package that ran the job. */
  readonly golemCode: string;
  /**
   * The code the job loaded, by the block of the package that holds it: the package that registers the job's block, and each package that registers an extension on its hooks.
   * Code can change with the job's options and inputs unchanged. A file of a package that the process did not load, such as the build output of an app next to its generator, is not here.
   */
  readonly code: Readonly<Record<string, LoadedCode>>;
  /** The digest of every extension on the job's hooks (`hookCode`); empty when none fills a hook of the job. */
  readonly hookCode: string;
  /** Stable JSON of the program view the job received (`programView`): what it stubs and what later jobs write, which its options do not show. */
  readonly programView: string;
  /** JSON of the job's resolved options. */
  readonly options: string;
  /** Every input, by the digest it had when the job read it: a file's content, the file listing of a directory under the golem.yaml's directory, `directory` for one outside it, `missing` for an absent path, `untracked` for a reported input the job never announced that is a directory or changed while the job ran. A reported file the job never announced, and unchanged during the run, has the digest it had when the job returned. */
  readonly inputs: Readonly<Record<string, string>>;
  /** The manifests of the jobs before it that the job received as `manifestInputs`. */
  readonly manifestInputs: readonly string[];
  /** The inventory-recorded files the job wrote. */
  readonly outputs: readonly string[];
  /** The files core owns that it wrote from the job's artifacts (the codec key table), by the digest they had: they are no job output and no inventory entry. */
  readonly records: Readonly<Record<string, string>>;
  /** The manifests the job reported: its outputs that later jobs read as `manifestInputs`. */
  readonly manifests: readonly string[];
  /** The warnings the job reported. A later run that skips the job writes them again: its inputs are as they were, so they still hold. */
  readonly warnings: readonly GolemDiagnostic[];
}

/** The files of one package that the process had loaded when a job ended: each by its path from the package folder (`/` separators) and the digest of its content. */
export type LoadedCode = Readonly<Record<string, string>>;

const MISSING = 'missing';
/** A digest no read gives, so the next run finds the input changed and runs the job again. A reported input the job never announced gets it when golem cannot trust the digest from the return: a directory, whose listing shows no edit of a file inside it, or a file that changed while the job ran. */
const UNTRACKED = 'untracked';
const OUTSIDE_DIRECTORY = 'directory';
const RECORDS_VERSION = 3;

function jobsFile(config: GolemConfig): string {
  return path.join(path.dirname(config.inventoryFile), 'jobs.json');
}

/** A path as a record spells it. */
export function recordPath(config: GolemConfig, filename: string): string {
  return path.relative(config.directory, filename).split(path.sep).join('/');
}

export function absoluteRecordPath(config: GolemConfig, recorded: string): string {
  return path.resolve(config.directory, recorded);
}

function isJobRecord(value: unknown): value is JobRecord {
  const strings = (items: unknown): boolean => Array.isArray(items) && items.every(item => typeof item === 'string');
  return isRecord(value)
    && typeof value.golemCode === 'string'
    && isRecord(value.code) && Object.values(value.code).every(files => isRecord(files) && Object.values(files).every(hash => typeof hash === 'string'))
    && typeof value.hookCode === 'string'
    && typeof value.programView === 'string'
    && typeof value.options === 'string'
    && strings(value.manifestInputs)
    && isRecord(value.inputs) && Object.values(value.inputs).every(digest => typeof digest === 'string')
    && strings(value.outputs)
    && isRecord(value.records) && Object.values(value.records).every(recorded => typeof recorded === 'string')
    && strings(value.manifests)
    && Array.isArray(value.warnings) && value.warnings.every(isWarning);
}

function isWarning(value: unknown): value is GolemDiagnostic {
  return isRecord(value)
    && value.severity === GolemDiagnosticSeverity.Warning
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && ['file', 'path'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && ['line', 'column'].every(key => value[key] === undefined || typeof value[key] === 'number');
}

/** The records of the last run. A missing or unreadable file holds none: every job then runs. */
export function loadJobRecords(config: GolemConfig): Map<string, JobRecord> {
  const records = new Map<string, JobRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(jobsFile(config), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || hasErrorCode(error, 'ENOENT')) return records;
    throw error;
  }
  if (!isRecord(parsed) || parsed.version !== RECORDS_VERSION || !isRecord(parsed.jobs)) return records;
  for (const [id, record] of Object.entries(parsed.jobs)) {
    if (isJobRecord(record)) records.set(id, record);
  }
  return records;
}

export function saveJobRecords(config: GolemConfig, records: ReadonlyMap<string, JobRecord>, files?: OutputFiles): void {
  const jobs = Object.fromEntries([...records]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, record]) => [id, {
      golemCode: record.golemCode,
      code: Object.fromEntries(Object.entries(record.code).sort(([left], [right]) => compareText(left, right))),
      hookCode: record.hookCode,
      programView: record.programView,
      options: record.options,
      inputs: Object.fromEntries(Object.entries(record.inputs).sort(([left], [right]) => compareText(left, right))),
      manifestInputs: record.manifestInputs,
      outputs: record.outputs,
      records: record.records,
      manifests: record.manifests,
      warnings: record.warnings,
    }]));
  atomicWrite(jobsFile(config), `${JSON.stringify({ version: RECORDS_VERSION, jobs }, null, 2)}\n`, files);
}

/** The files the inventory records as generated, as absolute paths. */
export function inventoryPaths(config: GolemConfig, inventory: Inventory): Set<string> {
  return new Set(Object.keys(inventory.files).map(key => path.resolve(config.directory, key)));
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Whether `filename` is one of `directories` or lies under one. */
export function insideAny(directories: readonly string[], filename: string): boolean {
  return directories.some(directory => isInsideDirectory(directory, filename));
}

/**
 * The files of a directory, as sorted paths relative to it. Dot-directories (`.golem` among them) and node_modules are skipped, as the
 * output scan skips them, and so is a directory `excluded` names: the project's compiler output.
 */
function listFiles(directory: string, excluded: (filename: string) => boolean, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return [];
    throw error;
  }
  const listed: string[] = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || excluded(filename)) continue;
      listed.push(...listFiles(filename, excluded, `${prefix}${entry.name}/`));
    } else if (!excluded(filename)) listed.push(`${prefix}${entry.name}`);
  }
  return listed.sort();
}

/**
 * The digest of one input now: a file's content, the sorted listing of the files of a directory under `root` (a new model file
 * changes it) or `missing`, which also stands for such a directory that lists no file. A directory outside `root` is a path the
 * compiler probed, such as `/` above the project: only its existence is recorded, as a listing of it would walk what the job
 * does not own. `excluded` names generated files and directories, which a listing leaves out: a job's own output must not change what it reads.
 */
export function inputDigest(filename: string, excluded: (filename: string) => boolean, root: string): string {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(filename, { throwIfNoEntry: false });
  } catch (error) {
    if (!hasErrorCode(error, 'ENOTDIR')) throw error;
  }
  if (!stat) return MISSING;
  if (stat.isDirectory()) {
    if (!isInsideDirectory(root, filename)) return OUTSIDE_DIRECTORY;
    // A directory that holds only generated files lists as an absent one: a job's own output directory does not exist before its first run.
    const listed = listFiles(filename, excluded);
    return listed.length === 0 ? MISSING : hashText(listed.join('\n'));
  }
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return MISSING;
    throw error;
  }
}

/**
 * The digest of the JavaScript in golem's own package: the `.js`, `.cjs` and `.mjs` files under `directory`, node_modules left out, each by its
 * path relative to `directory` and its content, in path order. A version string does not stand for code: golem under the same version,
 * as it is during development or in a linked install, must run its jobs again.
 */
function codeDigest(directory: string): string {
  const files: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
      } else if (/\.[cm]?js$/.test(entry.name)) files.push(`${prefix}${entry.name}`);
    }
  };
  walk(directory, '');
  const digest = crypto.createHash('sha256');
  for (const file of files.sort()) digest.update(`${file}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')}\n`);
  return digest.digest('hex');
}

let golemCodeDigest: string | undefined;

/** The digest of the golem package that is running, found from this module: `dist/tooling` sits two directories below the package. Computed once. */
export function golemCode(): string {
  golemCodeDigest ??= codeDigest(fileURLToPath(new URL('../../', import.meta.url)));
  return golemCodeDigest;
}

/**
 * The digest of what the extensions on a job's hooks contribute: for each hook and extension that fills it, in the order of golem.yaml, the package that registers the
 * extension, its name and its options. It changes when an extension is added, removed, reordered or given other options. Its code is in the record's `code`.
 * Empty for a job with no filled hook.
 */
export function hookCode(filled: readonly { readonly hook: string; readonly extension: EnabledExtension }[]): string {
  if (!filled.length) return '';
  return hashText(JSON.stringify(filled.map(({ hook, extension }) => [hook, extension.package, extension.name, stableJson(extension.options)])));
}

/** The files under `folder` that the process has loaded (`loadedFilesUnder`), each digested now. A file that is gone is left out. */
export function loadedCode(folder: string): LoadedCode {
  const files: Record<string, string> = {};
  for (const filename of loadedFilesUnder(folder)) {
    const fileHash = fileDigest(filename);
    if (fileHash !== undefined) files[path.relative(folder, filename).split(path.sep).join('/')] = fileHash;
  }
  return files;
}

/**
 * What the run supplies to a job besides its inputs: the folder of the package behind each block whose code the job loads (its own block, and the block of each
 * extension on its hooks), the digest of its hook extensions (`hookCode`), its program view (`programViewOf`), and the manifests of the jobs before it (absolute paths).
 */
export interface JobSetup {
  readonly codeFolders: ReadonlyMap<string, string>;
  readonly hookCode: string;
  readonly programView: string;
  readonly manifestInputs: readonly string[];
}

/** The program view of `job` as the record holds it: stable JSON, `null` when the job has none. */
export function programViewOf(config: GolemConfig, job: GolemJob): string {
  return stableJson(config.jobPlan.programViews[job.id] ?? null);
}

/** Whether the record holds the code of exactly these packages, and every file in it is as it was: a changed or missing file is not. */
function codeIsCurrent(record: JobRecord, folders: ReadonlyMap<string, string>): boolean {
  const recorded = Object.entries(record.code);
  return recorded.length === folders.size && recorded.every(([block, files]) => {
    const folder = folders.get(block);
    return folder !== undefined && Object.entries(files).every(([file, expected]) => fileDigest(path.join(folder, file)) === expected);
  });
}

/** Whether the loaded code, hook extensions, program view and manifest set are those the record holds. */
export function sameSetup(config: GolemConfig, record: JobRecord, setup: JobSetup): boolean {
  return codeIsCurrent(record, setup.codeFolders)
    && record.hookCode === setup.hookCode
    && record.programView === setup.programView
    && JSON.stringify(record.manifestInputs) === JSON.stringify(setup.manifestInputs.map(manifest => recordPath(config, manifest)));
}

/** The digest of a file's content, or undefined when it does not exist. */
function fileDigest(filename: string): string | undefined {
  try {
    return digest(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EISDIR')) return undefined;
    throw error;
  }
}

/** Whether the file still holds what the inventory recorded for it. */
function outputIsRecorded(entry: InventoryEntry | undefined, filename: string): boolean {
  if (!entry) return false;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') === entry.digest;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EISDIR')) return false;
    throw error;
  }
}

/**
 * Whether the job would produce what its record holds: the golem code, the code the job loaded, hook extensions, program view, options and manifest set
 * match, every output still has the digest the inventory recorded for it and every input still has the digest it had when the job
 * read it. An output that is missing, edited or absent from the inventory, or a core record that is missing or edited, is not current: the job runs again and rewrites it. The
 * files the inventory records are left out of directory listings; `inventory` defaults to the one on disk.
 */
export function jobIsCurrent(
  config: GolemConfig,
  job: GolemJob,
  record: JobRecord | undefined,
  setup: JobSetup,
  inventory: Inventory = loadInventory(config),
  ignoredDirectories: readonly string[] = [],
): boolean {
  if (!record || record.golemCode !== golemCode() || record.options !== JSON.stringify(job.options) || !sameSetup(config, record, setup)) return false;
  // A job that announced no input hides what it reads: nothing can show that it is still true.
  if (Object.keys(record.inputs).length === 0) return false;
  const outputs = new Set(record.outputs.map(output => absoluteRecordPath(config, output)));
  const entries = new Map(Object.entries(inventory.files).map(([key, entry]) => [path.resolve(config.directory, key), entry]));
  const generated = new Set(entries.keys());
  if (![...outputs].every(output => outputIsRecorded(entries.get(output), output))) return false;
  if (!Object.entries(record.records).every(([recorded, expected]) => fileDigest(absoluteRecordPath(config, recorded)) === expected)) return false;
  const excluded = (filename: string): boolean => generated.has(filename) || outputs.has(filename) || insideAny(ignoredDirectories, filename);
  return Object.entries(record.inputs)
    .every(([input, digest]) => inputDigest(absoluteRecordPath(config, input), excluded, config.directory) === digest);
}

/** Collects the inputs of one running job, each digested when the job reads it and never later: an edit after the read changes the file's digest, so the next run reruns the job. */
export class JobInputs {
  private readonly digests = new Map<string, string>();
  private readonly started = Date.now();

  /** `excluded` is read at each call, so files an earlier job just wrote stay out of a listing. `root` is the golem.yaml's directory. */
  constructor(private readonly excluded: (filename: string) => boolean, private readonly root: string) {}

  read(filename: string): void {
    const resolved = path.resolve(filename);
    if (!this.digests.has(resolved)) this.digests.set(resolved, inputDigest(resolved, this.excluded, this.root));
  }

  /**
   * The record's inputs. A reported watch input the job never announced was not digested at a read: it is digested now, when the
   * job has returned. A directory, or a file whose modification time is not before the start of the job (it may have changed after
   * the job read it), gets `untracked`, so the next run runs the job again. `own` are the job's own outputs, which are not inputs.
   */
  finish(config: GolemConfig, watchInputs: readonly string[], own: ReadonlySet<string>): Record<string, string> {
    for (const input of watchInputs) {
      const resolved = path.resolve(input);
      if (own.has(resolved) || this.digests.has(resolved)) continue;
      if (this.isUntracked(resolved)) this.digests.set(resolved, UNTRACKED);
      else this.read(resolved);
    }
    return Object.fromEntries([...this.digests]
      .filter(([input]) => !own.has(input))
      .map(([input, digest]) => [recordPath(config, input), digest]));
  }

  private isUntracked(filename: string): boolean {
    try {
      const stat = fs.statSync(filename, { throwIfNoEntry: false });
      return stat !== undefined && (stat.isDirectory() || stat.mtimeMs >= this.started);
    } catch (error) {
      if (hasErrorCode(error, 'ENOTDIR')) return false;
      throw error;
    }
  }
}
