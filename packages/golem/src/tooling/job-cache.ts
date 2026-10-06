import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contains } from './config.js';
import type { GolemConfig, GolemJob } from './config.js';
import { hasErrorCode, isRecord } from './generator-api.js';
import { atomicWrite, loadInventory } from './outputs.js';
import type { Inventory, InventoryEntry } from './outputs.js';

/**
 * What one job read and wrote the last time it ran, kept in `.golem/jobs.json` beside `.golem/outputs.json`. A later run
 * skips a job whose record is still true. Every path is relative to the directory of golem.yaml, with `/` separators.
 */
export interface JobRecord {
  /** The digest of the JavaScript of the golem package that ran the job. */
  readonly golemCode: string;
  /** The digest of the JavaScript of the job's provider package, which can change with its options and inputs unchanged; empty when the package could not be resolved. */
  readonly providerCode: string;
  /** JSON of the job's resolved options. */
  readonly options: string;
  /** Every input, by the digest it had when the job read it: a file's content, the file listing of a directory under the golem.yaml's directory, `directory` for one outside it, `missing` for an absent path, `unstable` for a reported input the job never announced. */
  readonly inputs: Readonly<Record<string, string>>;
  /** The manifests of the jobs before it that the job received as `manifestInputs`. */
  readonly manifestInputs: readonly string[];
  readonly outputs: readonly string[];
  /** The manifests the job reported: its outputs that later jobs read as `manifestInputs`. */
  readonly manifests: readonly string[];
}

const MISSING = 'missing';
const UNSTABLE = 'unstable';
const OUTSIDE_DIRECTORY = 'directory';
const RECORDS_VERSION = 2;

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
    && typeof value.providerCode === 'string'
    && typeof value.options === 'string'
    && strings(value.manifestInputs)
    && isRecord(value.inputs) && Object.values(value.inputs).every(digest => typeof digest === 'string')
    && strings(value.outputs)
    && strings(value.manifests);
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

export function saveJobRecords(config: GolemConfig, records: ReadonlyMap<string, JobRecord>): void {
  const jobs = Object.fromEntries([...records]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, record]) => [id, {
      golemCode: record.golemCode,
      providerCode: record.providerCode,
      options: record.options,
      inputs: Object.fromEntries(Object.entries(record.inputs).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
      manifestInputs: record.manifestInputs,
      outputs: record.outputs,
      manifests: record.manifests,
    }]));
  atomicWrite(jobsFile(config), `${JSON.stringify({ version: RECORDS_VERSION, jobs }, null, 2)}\n`);
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
  return directories.some(directory => contains(directory, filename));
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
    if (!contains(root, filename)) return OUTSIDE_DIRECTORY;
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
 * The digest of the JavaScript in a package: the `.js`, `.cjs` and `.mjs` files under `directory`, node_modules left out, each by its
 * path relative to `directory` and its content, in path order. A version string does not stand for code: a generator that changes under
 * the same version, as one does during development or in a linked install, must run its jobs again.
 */
export function codeDigest(directory: string): string {
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

/** What the run supplies to a job besides its inputs: the digest of its provider package's code, and the manifests of the jobs before it (absolute paths). */
export interface JobSetup {
  /** Undefined when the provider package cannot be resolved. */
  readonly providerCode: string | undefined;
  readonly manifestInputs: readonly string[];
}

/** Whether the provider code and the manifest set are those the record holds. */
export function sameSetup(config: GolemConfig, record: JobRecord, setup: JobSetup): boolean {
  return record.providerCode === setup.providerCode
    && JSON.stringify(record.manifestInputs) === JSON.stringify(setup.manifestInputs.map(manifest => recordPath(config, manifest)));
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
 * Whether the job would produce what its record holds: the golem code, provider code, options and manifest set
 * match, every output still has the digest the inventory recorded for it and every input still has the digest it had when the job
 * read it. An output that is missing, edited or absent from the inventory is not current: the job runs again and rewrites it. The
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
  const excluded = (filename: string): boolean => generated.has(filename) || outputs.has(filename) || insideAny(ignoredDirectories, filename);
  return Object.entries(record.inputs)
    .every(([input, digest]) => inputDigest(absoluteRecordPath(config, input), excluded, config.directory) === digest);
}

/** Collects the inputs of one running job, each digested when the job reads it and never later: an edit after the read changes the file's digest, so the next run reruns the job. */
export class JobInputs {
  private readonly digests = new Map<string, string>();

  /** `excluded` is read at each call, so files an earlier job just wrote stay out of a listing. `root` is the golem.yaml's directory. */
  constructor(private readonly excluded: (filename: string) => boolean, private readonly root: string) {}

  read(filename: string): void {
    const resolved = path.resolve(filename);
    if (!this.digests.has(resolved)) this.digests.set(resolved, inputDigest(resolved, this.excluded, this.root));
  }

  /**
   * The record's inputs. A reported watch input the job never announced has no digest from the read: it is `unstable`,
   * which never matches, so the job runs again. `own` are the job's own outputs, which are not inputs.
   */
  finish(config: GolemConfig, watchInputs: readonly string[], own: ReadonlySet<string>): Record<string, string> {
    for (const input of watchInputs) {
      const resolved = path.resolve(input);
      if (!this.digests.has(resolved)) this.digests.set(resolved, UNSTABLE);
    }
    return Object.fromEntries([...this.digests]
      .filter(([input]) => !own.has(input))
      .map(([input, digest]) => [recordPath(config, input), digest]));
  }
}
