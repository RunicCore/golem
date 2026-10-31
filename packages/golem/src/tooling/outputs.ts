import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { canonicalPath, compareText, displayPath, errorMessage, hasErrorCode, isInsideDirectory, isRecord } from './generator-core.js';
import type { GolemArtifact } from './generator-core.js';
import { codecKeysPath, defaultModelOutput } from './generated-paths.js';
import type { GolemConfig, GolemJob } from './config.js';

export interface InventoryEntry {
  job: string;
  owner: string;
  digest: string;
  /** Destination relative to the configuration directory. */
  destination: string;
  /** A controllers job owns exact files; other jobs own directories. */
  destinationKind: 'file' | 'directory';
}
export interface Inventory { version: 1; files: Record<string, InventoryEntry> }
interface ExpectedArtifact { filename: string; content: string; destination: string }
const BUILT_IN_OWNERS = new Set(['@exprtlabs/golem-model', '@exprtlabs/golem-openapi', '@exprtlabs/golem-ts-openapi']);

/** Packages whose ownership header marks a generated file: the built-in generators plus every configured generator job. */
function ownersOf(config: GolemConfig): ReadonlySet<string> {
  return new Set([...BUILT_IN_OWNERS, ...config.jobs.filter(job => job.kind === 'generator').map(job => job.package)]);
}
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

function modelOutputOf(job: Extract<GolemJob, { kind: 'models' }>): string {
  return job.options.output ?? defaultModelOutput(job.options.root);
}

/** The directories of a models job's own model sources: `src` of its root, or the folders of the listed sources. */
function modelSourceDirectories(job: Extract<GolemJob, { kind: 'models' }>): readonly string[] {
  return job.options.sources === undefined
    ? [path.join(job.options.root, 'src')]
    : job.options.sources.map(source => path.dirname(source));
}

/**
 * A models job writes anywhere inside its root: a model outside `src` that its tsconfig includes gets its generated file
 * beside it. It also owns the codec key file under the configuration directory's `.golem/`. The narrower directories come
 * first, so the inventory keeps recording them as the destination of their files. The whole root is a destination, so the
 * generator's `isOwnModelFile` is what keeps `node_modules` and the folders of nested jobs out.
 */
function jobDestinations(config: GolemConfig, job: GolemJob): readonly string[] {
  if (job.kind === 'generator') return [job.options.output];
  if (job.kind === 'controllers' || job.kind === 'openapi') return [job.options.output];
  return [modelOutputOf(job), ...modelSourceDirectories(job), path.dirname(codecKeysPath(config.directory)), job.options.root];
}

function artifactDestination(config: GolemConfig, job: GolemJob, filename: string): string {
  const destinations = jobDestinations(config, job);
  if (job.kind === 'controllers' && !samePath(filename, job.options.output)) {
    throw new Error(`Generated output escapes the ${job.id} destination: ${displayPath(filename)}`);
  }
  const destination = destinations.find(candidate => {
    if (isInsideDirectory(path.resolve(candidate), filename)) return true;
    try {
      return isInsideDirectory(canonicalPath(candidate), canonicalPath(filename));
    } catch { return false; }
  });
  if (destination === undefined) {
    throw new Error(`Generated output escapes the ${job.id} destination: ${displayPath(filename)}`);
  }
  const configured = configuredDestinationPath(destination);
  assertDestinationPath(filename, configured, 'job');
  return relativePath(config, configured);
}

function destinationKind(owner: string): InventoryEntry['destinationKind'] {
  return owner === '@exprtlabs/golem-ts-openapi' ? 'file' : 'directory';
}

function inventoryDestination(config: GolemConfig, filename: string, entry: InventoryEntry): string {
  const destination = recordedDestinationPath(config, entry.destination);
  if (entry.destinationKind === 'file') {
    // A controllers job owns exactly its configured document.
    const configured = path.resolve(config.directory, entry.job.slice('controllers:'.length));
    if (path.resolve(filename) !== path.resolve(destination) || !samePath(configured, destination)) {
      throw new Error(`Generated output escapes its exact file destination: ${displayPath(filename)}`);
    }
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

export function marker(content: string, owner: string): boolean {
  // The owner name ends at whitespace (a line end too), a full stop or the end of the text, so `foo` does not match `foo-bar`.
  for (const comment of ['/*', '//', '#', '<!--']) {
    const header = `${comment} Generated by ${owner}`;
    if (content.startsWith(header) && /^(?:\s|\.|$)/.test(content.slice(header.length, header.length + 1))) return true;
  }
  try {
    const manifest: unknown = JSON.parse(content);
    // The codec key file has no header of its own: it is the models job's table of `<source>#<name>` ids.
    if (owner === '@exprtlabs/golem-model' && isRecord(manifest) && manifest.version === 1 && isRecord(manifest.keys)) return true;
    return isRecord(manifest) && (manifest['x-generator'] === owner
      || (Array.isArray(manifest.models) && isRecord(manifest.generator) && manifest.generator.name === owner));
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
    // Any other owner is a generator package; the entry itself records it, so a retired generator's files stay known.
    const prefix = entry.owner === '@exprtlabs/golem-model'
      ? 'models:'
      : entry.owner === '@exprtlabs/golem-ts-openapi'
        ? 'controllers:'
        : entry.owner === '@exprtlabs/golem-openapi'
          ? 'openapi:'
          : 'generator:';
    if (!entry.job.startsWith(prefix) || entry.job.length === prefix.length) throw new Error(`Generated output ownership conflict: ${shown}. Inventory owner and job disagree.`);
    if (typeof entry.destination !== 'string') throw new Error(`Invalid generated inventory entry: ${shown}`);
    const destination = validateRelativePath(entry.destination, 'inventory destination', true);
    const kind = destinationKind(entry.owner);
    if (entry.destinationKind !== kind) throw new Error(`Invalid generated inventory destination kind: ${shown}`);
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
function assertNoUnrecordedOutputs(config: GolemConfig, inventory: Inventory, job: GolemJob, expected: ReadonlyMap<string, ExpectedArtifact>): void {
  const owners = ownersOf(config);
  const drift: string[] = [];
  if (job.kind === 'controllers') {
    const filename = path.resolve(job.options.output);
    const key = inventoryKey(config, filename);
    const current = readFile(filename);
    if (current !== undefined && !expected.has(key) && !inventory.files[key] && knownOwner(current, owners) !== undefined) drift.push(filename);
  } else {
    const roots = job.kind === 'openapi' || job.kind === 'generator'
      ? [job.options.output]
      : job.kind === 'models'
        ? [modelOutputOf(job), ...modelSourceDirectories(job)]
        : [];
    const visited = new Set<string>();
    const visit = (directory: string): void => {
      const canonicalDirectory = canonicalPath(directory);
      if (visited.has(canonicalDirectory)) return;
      visited.add(canonicalDirectory);
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
      catch (error) { if (hasErrorCode(error, 'ENOENT')) return; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) { visit(filename); continue; }
        if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.js') && !entry.name.endsWith('.NOTICES.txt') && entry.name !== 'model-manifest.json')) continue;
        const key = inventoryKey(config, filename);
        if (expected.has(key) || inventory.files[key]) continue;
        if (knownOwner(fs.readFileSync(filename, 'utf8'), owners) !== undefined) drift.push(filename);
      }
    };
    for (const root of roots) visit(root);
  }
  if (drift.length) throw new Error(`Unrecorded generated output drift for ${job.id}:\n${drift.sort().map(filename => `  ${displayPath(filename)}`).join('\n')}`);
}

/** The files a run changed on disk: written with new content, or deleted. A file already as the run would write it is in neither list. */
export interface FileChanges {
  readonly written: readonly string[];
  readonly removed: readonly string[];
}

const NO_CHANGES: FileChanges = { written: [], removed: [] };

export function applyJob(config: GolemConfig, inventory: Inventory, job: GolemJob, artifacts: readonly GolemArtifact[], check = false, files: OutputFiles = realOutputFiles): FileChanges {
  assertInventoryPath(config);
  if (!Array.isArray(artifacts)) throw new Error(`${job.package} returned invalid artifacts.`);
  const expected = new Map<string, ExpectedArtifact>();
  for (const artifact of artifacts) {
    if (!artifact || !path.isAbsolute(artifact.path) || typeof artifact.content !== 'string') throw new Error(`${job.package} returned an invalid artifact.`);
    const filename = path.normalize(artifact.path);
    const key = inventoryKey(config, filename);
    if (!key || expected.has(key)) throw new Error(`Generated output collision: ${displayPath(filename)}`);
    assertProtectedPath(config, filename);
    const destination = artifactDestination(config, job, filename);
    assertDestinationPath(filename, recordedDestinationPath(config, destination), 'job');
    if (!marker(artifact.content, job.package)) throw new Error(`Missing generator ownership marker: ${displayPath(filename)}`);
    const old = inventory.files[key];
    if (old && (old.job !== job.id || old.owner !== job.package)) throw new Error(`Generated output is owned by another job: ${displayPath(filename)}`);
    // A file golem never recorded is replaced only when it carries this generator's marker.
    const current = old ? undefined : readFile(filename);
    if (current !== undefined && !marker(current, job.package)) {
      throw new Error(`Refusing to overwrite ${displayPath(filename)}: it was not generated by ${job.package}. Remove or rename it, or change the job's output path.`);
    }
    expected.set(key, { filename, content: artifact.content, destination });
  }
  if (check) assertNoUnrecordedOutputs(config, inventory, job, expected);
  const stale: string[] = [];
  const deletions: Array<{ key: string; filename: string }> = [];
  for (const [key, artifact] of expected) {
    const current = readFile(artifact.filename);
    const entry = inventory.files[key];
    if (current !== artifact.content || !entry || entry.digest !== digest(artifact.content) || entry.destination !== artifact.destination || entry.destinationKind !== destinationKind(job.package)) stale.push(key);
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
      destinationKind: destinationKind(job.package),
    };
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
  if (check && retired.length) throw new Error(`Generated outputs belong to removed jobs:\n${retired.map(([key]) => `  ${displayPath(inventoryPath(config, key))}`).join('\n')}`);
  const removed: string[] = [];
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
