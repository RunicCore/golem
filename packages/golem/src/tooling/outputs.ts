import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { canonicalPath, compareText, displayPath, errorMessage, hasErrorCode, isInsideDirectory, isRecord } from './generator-core.js';
import type { GolemArtifact } from './generator-core.js';
import { codecKeysPath } from './generated-paths.js';
import { MODEL_BOUNDARY } from './job-facts.js';
import type { GolemConfig, GolemJob } from './config.js';

export interface InventoryEntry {
  job: string;
  owner: string;
  digest: string;
  /** Destination relative to the configuration directory. */
  destination: string;
  /** A job's `file` output is one exact file; its `folder` outputs and owned roots are directories. */
  destinationKind: 'file' | 'directory';
}
export interface Inventory { version: 1; files: Record<string, InventoryEntry> }
interface ExpectedArtifact { filename: string; content: string; destination: string; destinationKind: InventoryEntry['destinationKind'] }
interface Destination { path: string; kind: InventoryEntry['destinationKind'] }

export const digest = (content: string): string => crypto.createHash('sha256').update(content).digest('hex');
const portable = (filename: string): string => filename.split(path.sep).join('/');

/** Return the deepest symlink in an existing prefix, including the final path. */
function symlinkInPath(filename: string): string | undefined {
  const absolute = path.resolve(filename);
  const root = path.parse(absolute).root;
  let current = root;
  let link: string | undefined;
  const relative = path.relative(root, absolute);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return link;
      throw error;
    }
    if (stat.isSymbolicLink()) link = current;
  }
  return link;
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function relativePath(config: GolemConfig, filename: string): string {
  const relative = portable(path.relative(canonicalPath(config.directory), canonicalPath(filename)));
  return relative || '.';
}

function inventoryKey(config: GolemConfig, filename: string): string {
  return portable(path.relative(canonicalPath(config.directory), canonicalPath(filename)));
}

function inventoryPath(config: GolemConfig, key: string): string {
  return path.resolve(config.directory, key);
}

/** Resolve a configured destination against the canonical configuration root. */
function configuredDestinationPath(destination: string): string {
  return canonicalPath(path.resolve(destination));
}

/** Keep the inventory under the canonical configuration directory. */
function inventoryBoundaryPath(config: GolemConfig): string {
  const requested = path.resolve(config.inventoryFile);
  const configuredRoot = path.resolve(config.directory);
  if (isInsideDirectory(configuredRoot, requested)) {
    return path.join(canonicalPath(configuredRoot), path.relative(configuredRoot, requested));
  }
  return canonicalPath(requested);
}

function assertInventoryPath(config: GolemConfig): void {
  const boundary = inventoryBoundaryPath(config);
  const link = symlinkInPath(boundary);
  if (link !== undefined) {
    throw new Error(`Generated inventory path uses symbolic link: ${displayPath(config.inventoryFile)}`);
  }
  if (!isInsideDirectory(canonicalPath(config.directory), canonicalPath(boundary))) {
    throw new Error(`Generated inventory escapes its configuration directory: ${displayPath(config.inventoryFile)}`);
  }
}

function validateRelativePath(filename: string, label: string, allowDot = false): string {
  if (!filename || path.isAbsolute(filename)) throw new Error(`Invalid generated ${label}: ${filename}`);
  const normalized = portable(path.normalize(filename));
  if ((!allowDot && normalized === '.') || normalized !== portable(filename)) {
    throw new Error(`Invalid generated ${label}: ${filename}`);
  }
  return normalized;
}

function assertDestinationPath(filename: string, destination: string, label: string): void {
  let finalStat: fs.Stats | undefined;
  try { finalStat = fs.lstatSync(filename); }
  catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; }
  if (finalStat?.isSymbolicLink()) {
    throw new Error(`Refusing non-regular generated output: ${displayPath(filename)}`);
  }
  const destinationLink = symlinkInPath(destination);
  if (destinationLink !== undefined) {
    throw new Error(`Refusing generated ${label} destination through symbolic link: ${displayPath(destination)}`);
  }
  const canonicalDestination = canonicalPath(destination);
  const canonicalFilename = canonicalPath(filename);
  if (!isInsideDirectory(canonicalDestination, canonicalFilename)) {
    const link = symlinkInPath(filename);
    throw new Error(`Generated output escapes its ${label} destination${link === undefined ? '' : ` through symbolic link ${displayPath(link)}`}: ${displayPath(filename)}`);
  }
}

/**
 * The destinations a job declares: its exclusive outputs (a `file` is one exact file, a `folder` a directory) and its owned roots.
 * The narrower destinations come first, so the inventory keeps recording them as the destination of their files.
 */
function jobDestinations(job: GolemJob): readonly Destination[] {
  return [
    ...job.facts.outputs.map((output): Destination => ({ path: output.path, kind: output.kind === 'file' ? 'file' : 'directory' })),
    ...job.facts.ownedRoots.map((root): Destination => ({ path: root, kind: 'directory' })),
  ];
}

function insideDestination(destination: Destination, filename: string): boolean {
  if (destination.kind === 'file') return samePath(filename, destination.path);
  if (isInsideDirectory(path.resolve(destination.path), filename)) return true;
  try {
    return isInsideDirectory(canonicalPath(destination.path), canonicalPath(filename));
  } catch { return false; }
}

function artifactDestination(config: GolemConfig, job: GolemJob, filename: string): { destination: string; destinationKind: InventoryEntry['destinationKind'] } {
  const found = jobDestinations(job).find(candidate => insideDestination(candidate, filename));
  if (found === undefined) {
    throw new Error(`Generated output escapes the ${job.id} destination: ${displayPath(filename)}`);
  }
  const configured = configuredDestinationPath(found.path);
  assertDestinationPath(filename, configured, 'job');
  return { destination: relativePath(config, configured), destinationKind: found.kind };
}

function inventoryDestination(config: GolemConfig, filename: string, entry: InventoryEntry): string {
  const destination = recordedDestinationPath(config, entry.destination);
  if (entry.destinationKind === 'file' && path.resolve(filename) !== path.resolve(destination)) {
    // A file output is exactly its one file.
    throw new Error(`Generated output escapes its exact file destination: ${displayPath(filename)}`);
  }
  return destination;
}

function recordedDestinationPath(config: GolemConfig, destination: string): string {
  const absolute = path.resolve(canonicalPath(config.directory), destination);
  if (canonicalPath(absolute) !== absolute) {
    throw new Error(`Generated output destination moved through a symbolic link: ${displayPath(absolute)}`);
  }
  return absolute;
}

function assertProtectedPath(config: GolemConfig, filename: string): void {
  if (samePath(filename, config.configFile) || samePath(filename, config.inventoryFile)) {
    throw new Error(`Generated output collision: ${displayPath(filename)}`);
  }
}

function knownOwner(content: string, owners: ReadonlySet<string>): string | undefined {
  for (const owner of owners) if (marker(content, owner)) return owner;
  return undefined;
}

/** A recorded file is deleted only while it still holds its recorded content or carries its owner's marker. */
function assertDeletable(filename: string, entry: InventoryEntry): void {
  const current = readFile(filename);
  if (current === undefined || digest(current) === entry.digest || marker(current, entry.owner)) return;
  throw new Error(`Refusing to delete ${displayPath(filename)}: it no longer holds the generated content of ${entry.owner}. Move it, or delete it yourself.`);
}

function readFile(filename: string): string | undefined {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular generated output: ${displayPath(filename)}`);
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Whether `content` carries the ownership marker of the package `owner`: a first line `<comment> Generated by <owner>` in a `/*`, `//`, `#` or `<!--` comment, or a
 * JSON document whose `x-generator` or `generator.name` is the owner. The check treats each file alike, whatever its name.
 */
export function marker(content: string, owner: string): boolean {
  // The owner name ends at whitespace (a line end too), a full stop or the end of the text, so `foo` does not match `foo-bar`.
  for (const comment of ['/*', '//', '#', '<!--']) {
    const header = `${comment} Generated by ${owner}`;
    if (content.startsWith(header) && /^(?:\s|\.|$)/.test(content.slice(header.length, header.length + 1))) return true;
  }
  try {
    const manifest: unknown = JSON.parse(content);
    return isRecord(manifest) && (manifest['x-generator'] === owner || (isRecord(manifest.generator) && manifest.generator.name === owner));
  } catch { return false; }
}

export function loadInventory(config: GolemConfig): Inventory {
  assertInventoryPath(config);
  const content = readFile(config.inventoryFile);
  if (content === undefined) return { version: 1, files: {} };
  let inventory: unknown;
  try { inventory = JSON.parse(content); } catch { throw new Error(`Invalid generated inventory: ${displayPath(config.inventoryFile)}`); }
  if (!isRecord(inventory) || inventory.version !== 1 || !isRecord(inventory.files)) throw new Error(`Invalid generated inventory: ${displayPath(config.inventoryFile)}`);
  const files: Record<string, InventoryEntry> = Object.create(null);
  for (const [filename, entry] of Object.entries(inventory.files)) {
    const key = validateRelativePath(filename, 'inventory path');
    const shown = displayPath(inventoryPath(config, key));
    if (!isRecord(entry) || typeof entry.owner !== 'string' || !entry.owner || typeof entry.job !== 'string' || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error(`Invalid generated inventory entry: ${shown}`);
    if (!entry.job) throw new Error(`Invalid generated inventory entry: ${shown}`);
    if (typeof entry.destination !== 'string') throw new Error(`Invalid generated inventory entry: ${shown}`);
    const destination = validateRelativePath(entry.destination, 'inventory destination', true);
    // The entry records its owner, so a retired package's files stay known.
    const kind = entry.destinationKind;
    if (kind !== 'file' && kind !== 'directory') throw new Error(`Invalid generated inventory destination kind: ${shown}`);
    const absolute = inventoryPath(config, key);
    assertProtectedPath(config, absolute);
    const recorded: InventoryEntry = { job: entry.job, owner: entry.owner, digest: entry.digest, destination, destinationKind: kind };
    try { assertDestinationPath(absolute, inventoryDestination(config, absolute, recorded), 'recorded'); }
    catch (error) { throw new Error(`Invalid generated inventory entry: ${shown}. ${error instanceof Error ? error.message : String(error)}`); }
    files[key] = recorded;
  }
  return { version: 1, files };
}

/**
 * The calls that change a file when a run writes outputs. A run uses the real ones; a test passes its own to fault one of them
 * (ENOSPC on a write, EXDEV or EIO on a rename) or to act at the moment a file is published. An error from a call is the error
 * the real call would raise.
 */
export interface OutputFiles {
  /** Creates `filename` with `content`; it fails when the file exists. */
  readonly create: (filename: string, content: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly unlink: (filename: string) => void;
}

export const realOutputFiles: OutputFiles = {
  create: (filename, content) => { fs.writeFileSync(filename, content, { flag: 'wx' }); },
  rename: (from, to) => { fs.renameSync(from, to); },
  unlink: filename => { fs.unlinkSync(filename); },
};

export function atomicWrite(filename: string, content: string, files: OutputFiles = realOutputFiles): boolean {
  if (readFile(filename) === content) return false;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    files.create(temporary, content);
    files.rename(temporary, filename);
  } catch (error) {
    // The create or rename failure is the cause; a failed cleanup is told beside it and never replaces it.
    try { files.unlink(temporary); } catch (cleanup) {
      if (!hasErrorCode(cleanup, 'ENOENT')) {
        // The thrown error keeps the `code` of the first failure, so a caller that tells failures apart by it still can.
        throw Object.assign(new Error(`${errorMessage(error).replace(/\.$/, '')}. Golem could not remove the temporary file ${displayPath(temporary)} either: ${errorMessage(cleanup)}`, { cause: error }), isRecord(error) && error.code !== undefined ? { code: error.code } : {});
      }
    }
    throw error;
  }
  return true;
}

function saveInventory(config: GolemConfig, inventory: Inventory, files: OutputFiles): void {
  assertInventoryPath(config);
  const recorded = Object.fromEntries(Object.entries(inventory.files)
    .sort(([a], [b]) => compareText(a, b))
    .map(([filename, entry]) => [filename, {
      job: entry.job,
      owner: entry.owner,
      digest: entry.digest,
      destination: entry.destination,
      destinationKind: entry.destinationKind,
    }]));
  atomicWrite(config.inventoryFile, `${JSON.stringify({ version: 1, files: recorded }, null, 2)}\n`, files);
}

/** `golem check` only: a file that carries a generator's marker, sits in a job's destination and no inventory entry or artifact names. A run that writes does not look. */
function assertNoUnrecordedOutputs(config: GolemConfig, inventory: Inventory, job: GolemJob, expected: ReadonlyMap<string, ExpectedArtifact>, compilerOutputs: readonly string[]): void {
  // The packages whose ownership header marks a generated file: the package of every configured job.
  const owners = new Set(config.jobs.map(candidate => candidate.package));
  const drift: string[] = [];
  const visited = new Set<string>();
  const visit = (directory: string): void => {
    const canonicalDirectory = canonicalPath(directory);
    if (visited.has(canonicalDirectory)) return;
    visited.add(canonicalDirectory);
    // The compiler output of the project is the build's own: a generated file compiled there is no drift.
    if (compilerOutputs.some(output => isInsideDirectory(canonicalPath(output), canonicalDirectory))) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (hasErrorCode(error, 'ENOENT')) return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(filename); continue; }
      if (!entry.isFile()) continue;
      const key = inventoryKey(config, filename);
      if (expected.has(key) || inventory.files[key]) continue;
      if (knownOwner(fs.readFileSync(filename, 'utf8'), owners) !== undefined) drift.push(filename);
    }
  };
  for (const destination of jobDestinations(job)) {
    if (destination.kind === 'directory') { visit(destination.path); continue; }
    const filename = path.resolve(destination.path);
    const key = inventoryKey(config, filename);
    const current = readFile(filename);
    if (current !== undefined && !expected.has(key) && !inventory.files[key] && knownOwner(current, owners) !== undefined) drift.push(filename);
  }
  if (drift.length) throw new Error(`Unrecorded generated output drift for ${job.id}:\n${drift.sort().map(filename => `  ${displayPath(filename)}`).join('\n')}`);
}

/** The files a run changed on disk: written with new content, or deleted. A file already as the run would write it is in neither list. */
export interface FileChanges {
  readonly written: readonly string[];
  readonly removed: readonly string[];
}

const NO_CHANGES: FileChanges = { written: [], removed: [] };

/**
 * The codec key table is core's own record under `.golem/`: no job's output and no inventory entry. Core writes it from the
 * artifacts of the one job that provides the models boundary, and removes it when that job returns none.
 */
function providesCodecKeys(config: GolemConfig, job: GolemJob): boolean {
  return config.jobPlan.providers[MODEL_BOUNDARY] === job.id;
}

/** The files core owns that it writes from the artifacts of `job`: no job output and no inventory entry. Today only the codec key table. */
export function coreRecordsOf(config: GolemConfig, job: GolemJob): readonly string[] {
  return providesCodecKeys(config, job) ? [codecKeysPath(config.directory)] : [];
}

/** `compilerOutputs` are the folders the project's compiler writes (outDir, declarationDir): the check for unrecorded files leaves them out. */
export function applyJob(config: GolemConfig, inventory: Inventory, job: GolemJob, artifacts: readonly GolemArtifact[], check = false, files: OutputFiles = realOutputFiles, compilerOutputs: readonly string[] = []): FileChanges {
  assertInventoryPath(config);
  if (!Array.isArray(artifacts)) throw new Error(`${job.package} returned invalid artifacts.`);
  const expected = new Map<string, ExpectedArtifact>();
  const recordFile = codecKeysPath(config.directory);
  let record: string | undefined;
  for (const artifact of artifacts) {
    if (!artifact || !path.isAbsolute(artifact.path) || typeof artifact.content !== 'string') throw new Error(`${job.package} returned an invalid artifact.`);
    const filename = path.normalize(artifact.path);
    const key = inventoryKey(config, filename);
    if (!key || expected.has(key)) throw new Error(`Generated output collision: ${displayPath(filename)}`);
    assertProtectedPath(config, filename);
    if (providesCodecKeys(config, job) && samePath(filename, recordFile)) {
      if (record !== undefined) throw new Error(`Generated output collision: ${displayPath(filename)}`);
      assertDestinationPath(filename, path.dirname(recordFile), 'record');
      record = artifact.content;
      continue;
    }
    const { destination, destinationKind } = artifactDestination(config, job, filename);
    assertDestinationPath(filename, recordedDestinationPath(config, destination), 'job');
    if (!marker(artifact.content, job.package)) throw new Error(`Missing generator ownership marker: ${displayPath(filename)}`);
    const old = inventory.files[key];
    if (old && (old.job !== job.id || old.owner !== job.package)) throw new Error(`Generated output is owned by another job: ${displayPath(filename)}`);
    // A file golem never recorded is replaced only when it carries this generator's marker.
    const current = old ? undefined : readFile(filename);
    if (current !== undefined && !marker(current, job.package)) {
      throw new Error(`Refusing to overwrite ${displayPath(filename)}: it was not generated by ${job.package}. Remove or rename it, or change the job's output path.`);
    }
    expected.set(key, { filename, content: artifact.content, destination, destinationKind });
  }
  if (check) assertNoUnrecordedOutputs(config, inventory, job, expected, compilerOutputs);
  const stale: string[] = [];
  const deletions: Array<{ key: string; filename: string }> = [];
  for (const [key, artifact] of expected) {
    const current = readFile(artifact.filename);
    const entry = inventory.files[key];
    if (current !== artifact.content || !entry || entry.digest !== digest(artifact.content) || entry.destination !== artifact.destination || entry.destinationKind !== artifact.destinationKind) stale.push(key);
  }
  for (const [key, entry] of Object.entries(inventory.files)) {
    if (entry.job !== job.id || expected.has(key)) continue;
    if (entry.owner !== job.package) throw new Error(`Generated output ownership conflict: ${displayPath(inventoryPath(config, key))}. Inventory owner does not match ${job.package}.`);
    const filename = inventoryPath(config, key);
    assertProtectedPath(config, filename);
    const destination = inventoryDestination(config, filename, entry);
    assertDestinationPath(filename, destination, 'recorded');
    assertDeletable(filename, entry);
    deletions.push({ key, filename });
    stale.push(key);
  }
  const recordChanged = providesCodecKeys(config, job) && readFile(recordFile) !== record;
  if (recordChanged) stale.push(inventoryKey(config, recordFile));
  if (check && stale.length) throw new Error(`Generated outputs are stale for ${job.id}:\n${stale.sort().map(key => `  ${displayPath(inventoryPath(config, key))}`).join('\n')}`);
  if (check) return NO_CHANGES;
  const written: string[] = [];
  const removed: string[] = [];
  for (const [key, artifact] of expected) {
    assertDestinationPath(artifact.filename, recordedDestinationPath(config, artifact.destination), 'job');
    if (atomicWrite(artifact.filename, artifact.content, files)) written.push(artifact.filename);
    inventory.files[key] = {
      job: job.id,
      owner: job.package,
      digest: digest(artifact.content),
      destination: artifact.destination,
      destinationKind: artifact.destinationKind,
    };
  }
  if (recordChanged) {
    if (record === undefined) {
      files.unlink(recordFile);
      removed.push(recordFile);
    } else if (atomicWrite(recordFile, record, files)) written.push(recordFile);
  }
  for (const { key, filename } of deletions) {
    if (readFile(filename) !== undefined) {
      files.unlink(filename);
      removed.push(filename);
    }
    delete inventory.files[key];
  }
  saveInventory(config, inventory, files);
  return { written, removed };
}

/** Deletes the outputs of jobs the configuration no longer lists, and returns the files it deleted. */
export function removeRetiredJobs(config: GolemConfig, inventory: Inventory, check = false, files: OutputFiles = realOutputFiles): string[] {
  assertInventoryPath(config);
  const active = new Set(config.jobs.map(job => job.id));
  const retired = Object.entries(inventory.files).filter(([, entry]) => !active.has(entry.job));
  for (const [key, entry] of retired) {
    const filename = inventoryPath(config, key);
    assertProtectedPath(config, filename);
    const destination = inventoryDestination(config, filename, entry);
    assertDestinationPath(filename, destination, 'recorded');
    assertDeletable(filename, entry);
  }
  // The codec key table follows its provider: with no job that provides the models boundary, it is left over.
  const recordFile = codecKeysPath(config.directory);
  const leftoverRecord = config.jobPlan.providers[MODEL_BOUNDARY] === undefined && readFile(recordFile) !== undefined;
  if (check && (retired.length || leftoverRecord)) {
    const shown = [...retired.map(([key]) => inventoryPath(config, key)), ...(leftoverRecord ? [recordFile] : [])];
    throw new Error(`Generated outputs belong to removed jobs:\n${shown.map(filename => `  ${displayPath(filename)}`).join('\n')}`);
  }
  const removed: string[] = [];
  if (!check && leftoverRecord) {
    files.unlink(recordFile);
    removed.push(recordFile);
  }
  if (!check && retired.length) {
    for (const [key] of retired) {
      const filename = inventoryPath(config, key);
      if (readFile(filename) !== undefined) {
        files.unlink(filename);
        removed.push(filename);
      }
      delete inventory.files[key];
    }
    saveInventory(config, inventory, files);
  }
  return removed;
}
