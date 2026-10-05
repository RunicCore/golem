import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GolemConfig, GolemJob } from './config.js';
import { hasErrorCode, isRecord } from './generator-api.js';
import { atomicWrite, loadInventory } from './outputs.js';
import type { Inventory } from './outputs.js';
import { GOLEM_VERSION } from './version.js';

/**
 * What one job read and wrote the last time it ran, kept in `.golem/jobs.json` beside `.golem/outputs.json`. A later run
 * skips a job whose record is still true. Every path is relative to the directory of golem.yaml, with `/` separators.
 */
export interface JobRecord {
  /** The golem version that ran the job. */
  readonly golem: string;
  /** JSON of the job's resolved options. */
  readonly options: string;
  /** Every input, by the digest it had when the job read it: a file's content, a directory's file listing, `missing` for an absent path, `unstable` for a file edited after the job started. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: readonly string[];
  /** The manifests the job reported: its outputs that later jobs read as `manifestInputs`. */
  readonly manifests: readonly string[];
}

const MISSING = 'missing';
const UNSTABLE = 'unstable';
const RECORDS_VERSION = 1;

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
    && typeof value.golem === 'string'
    && typeof value.options === 'string'
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
      golem: record.golem,
      options: record.options,
      inputs: Object.fromEntries(Object.entries(record.inputs).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
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

/** The files of a directory, as sorted paths relative to it. Dot-directories and node_modules are skipped, as the output scan skips them. */
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
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      listed.push(...listFiles(filename, excluded, `${prefix}${entry.name}/`));
    } else if (!excluded(filename)) listed.push(`${prefix}${entry.name}`);
  }
  return listed.sort();
}

/**
 * The digest of one input now: a file's content, the sorted listing of a directory's files (a new model file changes
 * it) or `missing`, which also stands for a directory that lists no file. `excluded` names generated files, which a listing leaves out: a job's own output must not change
 * what it reads.
 */
export function inputDigest(filename: string, excluded: (filename: string) => boolean): string {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(filename, { throwIfNoEntry: false });
  } catch (error) {
    if (!hasErrorCode(error, 'ENOTDIR')) throw error;
  }
  if (!stat) return MISSING;
  if (stat.isDirectory()) {
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
 * Whether the job would produce what its record holds: the golem version and options match, every output exists and
 * every input still has the digest it had when the job read it. `generated` is the files the inventory records,
 * which directory listings leave out; it defaults to the inventory on disk.
 */
export function jobIsCurrent(
  config: GolemConfig,
  job: GolemJob,
  record: JobRecord | undefined,
  generated: ReadonlySet<string> = inventoryPaths(config, loadInventory(config)),
): boolean {
  if (!record || record.golem !== GOLEM_VERSION || record.options !== JSON.stringify(job.options)) return false;
  const outputs = new Set(record.outputs.map(output => absoluteRecordPath(config, output)));
  if (![...outputs].every(output => fs.existsSync(output))) return false;
  const excluded = (filename: string): boolean => generated.has(filename) || outputs.has(filename);
  return Object.entries(record.inputs)
    .every(([input, digest]) => inputDigest(absoluteRecordPath(config, input), excluded) === digest);
}

/** Collects the inputs of one running job, each digested when the job reads it and never later: an edit after the read changes the file's digest, so the next run reruns the job. */
export class JobInputs {
  private readonly digests = new Map<string, string>();
  private readonly startedAt = Date.now();

  /** `excluded` is read at each call, so files an earlier job just wrote stay out of a listing. */
  constructor(private readonly excluded: (filename: string) => boolean) {}

  read(filename: string): void {
    const resolved = path.resolve(filename);
    if (!this.digests.has(resolved)) this.digests.set(resolved, inputDigest(resolved, this.excluded));
  }

  /**
   * The record's inputs. A reported watch input the job never announced is digested now; a file written since the job
   * started may have been read in its older state, so it is `unstable` and the job reruns. `own` are the job's own
   * outputs, which are not inputs.
   */
  finish(config: GolemConfig, watchInputs: readonly string[], own: ReadonlySet<string>): Record<string, string> {
    for (const input of watchInputs) {
      const resolved = path.resolve(input);
      if (this.digests.has(resolved)) continue;
      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      this.digests.set(resolved, stat?.isFile() && stat.mtimeMs >= this.startedAt ? UNSTABLE : inputDigest(resolved, this.excluded));
    }
    return Object.fromEntries([...this.digests]
      .filter(([input]) => !own.has(input))
      .map(([input, digest]) => [recordPath(config, input), digest]));
  }
}
