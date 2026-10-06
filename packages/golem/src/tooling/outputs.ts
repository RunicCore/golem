import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DEFAULT_MODEL_SUFFIXES, hasErrorCode, isRecord, suffixPattern } from './generator-api.js';
import type { GolemArtifact } from './generator-api.js';
import { canonicalPath, contains } from './config.js';
import { codecKeysPath, defaultModelOutput, isOperationCodecRegistry, operationCodecRegistryPath } from './generated-paths.js';
import type { GolemConfig, GolemJob } from './config.js';

export interface InventoryEntry {
  job: string;
  owner: string;
  digest: string;
  /** Destination relative to the configuration directory. */
  destination: string;
  /** A controllers job owns exact files; other jobs own directories. */
  destinationKind: 'file' | 'directory';
  /**
   * Set for the companion of a model source outside the configuration directory. Another app may use the file, so this
   * inventory deletes it only when its source is gone, never because the job stopped writing it or was removed.
   */
  shared?: true;
}
export interface Inventory { version: 1; files: Record<string, InventoryEntry> }
interface ExpectedArtifact { filename: string; content: string; destination: string; shared: boolean }
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
  if (contains(configuredRoot, requested)) {
    return path.join(canonicalPath(configuredRoot), path.relative(configuredRoot, requested));
  }
  return canonicalPath(requested);
}

function assertInventoryPath(config: GolemConfig): void {
  const boundary = inventoryBoundaryPath(config);
  const link = symlinkInPath(boundary);
  if (link !== undefined) {
    throw new Error(`Generated inventory path uses symbolic link: ${config.inventoryFile}`);
  }
  if (!contains(canonicalPath(config.directory), canonicalPath(boundary))) {
    throw new Error(`Generated inventory escapes its configuration directory: ${config.inventoryFile}`);
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
    throw new Error(`Refusing non-regular generated output: ${filename}`);
  }
  const destinationLink = symlinkInPath(destination);
  if (destinationLink !== undefined) {
    throw new Error(`Refusing generated ${label} destination through symbolic link: ${destination}`);
  }
  const canonicalDestination = canonicalPath(destination);
  const canonicalFilename = canonicalPath(filename);
  if (!contains(canonicalDestination, canonicalFilename)) {
    const link = symlinkInPath(filename);
    throw new Error(`Generated output escapes its ${label} destination${link === undefined ? '' : ` through symbolic link ${link}`}: ${filename}`);
  }
}

function modelOutputOf(job: Extract<GolemJob, { kind: 'models' }>): string {
  return job.options.output ?? defaultModelOutput(job.options.root);
}

function jobDestinations(job: GolemJob): readonly string[] {
  if (job.kind === 'generator') return [job.options.output];
  if (job.kind === 'controllers') {
    return [job.options.output, operationCodecRegistryPath(job.options.root)];
  }
  if (job.kind === 'openapi') return [job.options.output];
  const sourceRoot = path.join(job.options.root, 'src');
  const sourceDirectories = job.options.sources === undefined
    ? [sourceRoot]
    : job.options.sources.map(source => path.dirname(source));
  return [modelOutputOf(job), ...sourceDirectories];
}

/**
 * Whether `filename` is the companion of a model source that exists and ends in one of the job's model suffixes, outside
 * `node_modules`. A models job writes such a companion wherever its source is, as for a shared model folder outside the root.
 */
function isCompanionOfModelSource(job: Extract<GolemJob, { kind: 'models' }>, filename: string): boolean {
  const source = filename.replace(/\.generated\.([cm]?ts)$/, '.$1');
  if (source === filename || !suffixPattern(job.options.suffixes ?? DEFAULT_MODEL_SUFFIXES).test(path.basename(source))) return false;
  const inNodeModules = (file: string): boolean => path.normalize(file).split(path.sep).includes('node_modules');
  try {
    // A link inside the project can lead into node_modules, so the real directory counts too.
    if (inNodeModules(filename) || inNodeModules(path.join(fs.realpathSync(path.dirname(source)), path.basename(source)))) return false;
    return fs.statSync(source).isFile();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return false;
    throw error;
  }
}

function artifactDestination(config: GolemConfig, job: GolemJob, filename: string): string {
  // A models job also owns the codec key file under the configuration directory's `.golem/`.
  const destinations = job.kind === 'models' ? [...jobDestinations(job), path.dirname(codecKeysPath(config.directory))] : jobDestinations(job);
  if (job.kind === 'controllers') {
    const extra = operationCodecRegistryPath(job.options.root);
    if (!samePath(filename, job.options.output) && !samePath(filename, extra)) {
      throw new Error(`Generated output escapes the ${job.id} destination: ${filename}`);
    }
  }
  const destination = destinations.find(candidate => {
    if (contains(path.resolve(candidate), filename)) return true;
    try {
      return contains(canonicalPath(candidate), canonicalPath(filename));
    } catch { return false; }
  });
  const owner = destination ?? (job.kind === 'models' && isCompanionOfModelSource(job, filename) ? path.dirname(filename) : undefined);
  if (owner === undefined) {
    throw new Error(`Generated output escapes the ${job.id} destination: ${filename}`);
  }
  const configured = configuredDestinationPath(owner);
  assertDestinationPath(filename, configured, 'job');
  return relativePath(config, configured);
}

/** Whether a models job writes `filename` as the companion of a model source that lies outside the configuration directory. */
function isSharedCompanion(config: GolemConfig, job: GolemJob, filename: string): boolean {
  const key = inventoryKey(config, filename);
  return job.kind === 'models' && (key === '..' || key.startsWith('../')) && isCompanionOfModelSource(job, filename);
}

/** Whether the model source of the companion `filename` exists. */
function companionSourceExists(filename: string): boolean {
  const source = filename.replace(/\.generated\.([cm]?ts)$/, '.$1');
  if (source === filename) return false;
  try { return fs.statSync(source).isFile(); }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return false;
    throw error;
  }
}

function destinationKind(owner: string): InventoryEntry['destinationKind'] {
  return owner === '@exprtlabs/golem-ts-openapi' ? 'file' : 'directory';
}

function inventoryDestination(config: GolemConfig, filename: string, entry: InventoryEntry): string {
  const destination = recordedDestinationPath(config, entry.destination);
  if (entry.destinationKind === 'file') {
    // A controllers job owns exactly its configured document and the operation-codec registry.
    const configured = path.resolve(config.directory, entry.job.slice('controllers:'.length));
    const isDocument = samePath(configured, destination);
    const isRegistry = isOperationCodecRegistry(portable(entry.destination));
    if (path.resolve(filename) !== path.resolve(destination) || (!isDocument && !isRegistry)) {
      throw new Error(`Generated output escapes its exact file destination: ${filename}`);
    }
  }
  return destination;
}

function recordedDestinationPath(config: GolemConfig, destination: string): string {
  const absolute = path.resolve(canonicalPath(config.directory), destination);
  if (canonicalPath(absolute) !== absolute) {
    throw new Error(`Generated output destination moved through a symbolic link: ${destination}`);
  }
  return absolute;
}

function assertProtectedPath(config: GolemConfig, filename: string): void {
  if (samePath(filename, config.configFile) || samePath(filename, config.inventoryFile)) {
    throw new Error(`Generated output collision: ${filename}`);
  }
}

function knownOwner(content: string, owners: ReadonlySet<string>): string | undefined {
  for (const owner of owners) if (marker(content, owner)) return owner;
  return undefined;
}

function readFile(filename: string): string | undefined {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular generated output: ${filename}`);
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export function marker(content: string, owner: string): boolean {
  if (
    content.startsWith(`/* Generated by ${owner}`)
    || content.startsWith(`// Generated by ${owner}`)
    || content.startsWith(`# Generated by ${owner}`)
    || content.startsWith(`<!-- Generated by ${owner}`)
  ) return true;
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
  try { inventory = JSON.parse(content); } catch { throw new Error(`Invalid generated inventory: ${config.inventoryFile}`); }
  if (!isRecord(inventory) || inventory.version !== 1 || !isRecord(inventory.files)) throw new Error(`Invalid generated inventory: ${config.inventoryFile}`);
  const files: Record<string, InventoryEntry> = Object.create(null);
  for (const [filename, entry] of Object.entries(inventory.files)) {
    const key = validateRelativePath(filename, 'inventory path');
    if (!isRecord(entry) || typeof entry.owner !== 'string' || !entry.owner || typeof entry.job !== 'string' || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error(`Invalid generated inventory entry: ${filename}`);
    // Any other owner is a generator package; the entry itself records it, so a retired generator's files stay known.
    const prefix = entry.owner === '@exprtlabs/golem-model'
      ? 'models:'
      : entry.owner === '@exprtlabs/golem-ts-openapi'
        ? 'controllers:'
        : entry.owner === '@exprtlabs/golem-openapi'
          ? 'openapi:'
          : 'generator:';
    if (!entry.job.startsWith(prefix) || entry.job.length === prefix.length) throw new Error(`Generated output ownership conflict: ${filename}. Inventory owner and job disagree.`);
    if (typeof entry.destination !== 'string' || (entry.shared !== undefined && entry.shared !== true)) throw new Error(`Invalid generated inventory entry: ${filename}`);
    const destination = validateRelativePath(entry.destination, 'inventory destination', true);
    const kind = destinationKind(entry.owner);
    if (entry.destinationKind !== kind) throw new Error(`Invalid generated inventory destination kind: ${filename}`);
    const absolute = inventoryPath(config, key);
    assertProtectedPath(config, absolute);
    const recorded: InventoryEntry = { job: entry.job, owner: entry.owner, digest: entry.digest, destination, destinationKind: kind, ...(entry.shared === true ? { shared: true as const } : {}) };
    try { assertDestinationPath(absolute, inventoryDestination(config, absolute, recorded), 'recorded'); }
    catch (error) { throw new Error(`Invalid generated inventory entry: ${filename}. ${error instanceof Error ? error.message : String(error)}`); }
    files[key] = recorded;
  }
  return { version: 1, files };
}

export function atomicWrite(filename: string, content: string): boolean {
  if (readFile(filename) === content) return false;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; }
  }
  return true;
}

function saveInventory(config: GolemConfig, inventory: Inventory): void {
  assertInventoryPath(config);
  const files = Object.fromEntries(Object.entries(inventory.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, entry]) => [filename, {
      job: entry.job,
      owner: entry.owner,
      digest: entry.digest,
      destination: entry.destination,
      destinationKind: entry.destinationKind,
      ...(entry.shared === true ? { shared: true } : {}),
    }]));
  atomicWrite(config.inventoryFile, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

function assertNoUnrecordedOutputs(config: GolemConfig, inventory: Inventory, job: GolemJob, expected: ReadonlyMap<string, ExpectedArtifact>, check: boolean): string[] {
  if (job.kind === 'controllers') {
    const filename = path.resolve(job.options.output);
    const key = inventoryKey(config, filename);
    const current = readFile(filename);
    const drift = current !== undefined && !expected.has(key) && !inventory.files[key] && knownOwner(current, ownersOf(config)) !== undefined
      ? [filename]
      : [];
    if (check && drift.length) {
      throw new Error(`Unrecorded generated output drift for ${job.id}:\n  ${filename}`);
    }
    return drift;
  }
  const roots = job.kind === 'openapi' || job.kind === 'generator'
    ? [job.options.output]
    : job.kind === 'models'
      ? [path.join(job.options.root, 'src'), modelOutputOf(job), ...jobDestinations(job).slice(1)]
      : [];
  const drift: string[] = [];
  const owners = ownersOf(config);
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
      // Another app may have written, or this job may have stopped writing, the companion of a shared source: it is not drift.
      if (isSharedCompanion(config, job, filename)) continue;
      if (knownOwner(fs.readFileSync(filename, 'utf8'), owners) !== undefined) drift.push(filename);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  if (check && drift.length) {
    throw new Error(`Unrecorded generated output drift for ${job.id}:\n${drift.sort().map(filename => `  ${filename}`).join('\n')}`);
  }
  return drift;
}

export function applyJob(config: GolemConfig, inventory: Inventory, job: GolemJob, artifacts: readonly GolemArtifact[], check = false): string[] {
  assertInventoryPath(config);
  if (!Array.isArray(artifacts)) throw new Error(`${job.package} returned invalid artifacts.`);
  const expected = new Map<string, ExpectedArtifact>();
  for (const artifact of artifacts) {
    if (!artifact || !path.isAbsolute(artifact.path) || typeof artifact.content !== 'string') throw new Error(`${job.package} returned an invalid artifact.`);
    const filename = path.normalize(artifact.path);
    const key = inventoryKey(config, filename);
    if (!key || expected.has(key)) throw new Error(`Generated output collision: ${filename}`);
    assertProtectedPath(config, filename);
    const destination = artifactDestination(config, job, filename);
    assertDestinationPath(filename, recordedDestinationPath(config, destination), 'job');
    if (!marker(artifact.content, job.package)) throw new Error(`Missing generator ownership marker: ${filename}`);
    const old = inventory.files[key];
    if (old && (old.job !== job.id || old.owner !== job.package)) throw new Error(`Generated output is owned by another job: ${filename}`);
    // A file golem never recorded is replaced only when it carries this generator's marker.
    const current = old ? undefined : readFile(filename);
    if (current !== undefined && !marker(current, job.package)) {
      throw new Error(`Refusing to overwrite ${filename}: it was not generated by ${job.package}. Remove or rename it, or change the job's output path.`);
    }
    expected.set(key, { filename, content: artifact.content, destination, shared: isSharedCompanion(config, job, filename) });
  }
  assertNoUnrecordedOutputs(config, inventory, job, expected, check);
  const stale: string[] = [];
  // A shared companion whose source still exists leaves the inventory but stays on disk: another app may use it.
  const deletions: Array<{ key: string; filename: string; keepFile: boolean }> = [];
  for (const [key, artifact] of expected) {
    const current = readFile(artifact.filename);
    const entry = inventory.files[key];
    if (current !== artifact.content || !entry || entry.digest !== digest(artifact.content) || entry.destination !== artifact.destination || entry.destinationKind !== destinationKind(job.package) || (entry.shared === true) !== artifact.shared) stale.push(key);
  }
  for (const [key, entry] of Object.entries(inventory.files)) {
    if (entry.job !== job.id || expected.has(key)) continue;
    if (entry.owner !== job.package) throw new Error(`Generated output ownership conflict: ${key}. Inventory owner does not match ${job.package}.`);
    const filename = inventoryPath(config, key);
    assertProtectedPath(config, filename);
    const destination = inventoryDestination(config, filename, entry);
    assertDestinationPath(filename, destination, 'recorded');
    readFile(filename);
    deletions.push({ key, filename, keepFile: entry.shared === true && companionSourceExists(filename) });
    stale.push(key);
  }
  if (check && stale.length) throw new Error(`Generated outputs are stale for ${job.id}:\n${stale.sort().map(key => `  ${key}`).join('\n')}`);
  if (!check) {
    for (const [key, artifact] of expected) {
      assertDestinationPath(artifact.filename, recordedDestinationPath(config, artifact.destination), 'job');
      atomicWrite(artifact.filename, artifact.content);
      inventory.files[key] = {
        job: job.id,
        owner: job.package,
        digest: digest(artifact.content),
        destination: artifact.destination,
        destinationKind: destinationKind(job.package),
        ...(artifact.shared ? { shared: true as const } : {}),
      };
    }
    for (const { key, filename, keepFile } of deletions) {
      if (!keepFile && readFile(filename) !== undefined) fs.unlinkSync(filename);
      delete inventory.files[key];
    }
    saveInventory(config, inventory);
  }
  return [...expected.values()].map(artifact => artifact.filename);
}

export function removeRetiredJobs(config: GolemConfig, inventory: Inventory, check = false): void {
  assertInventoryPath(config);
  const active = new Set(config.jobs.map(job => job.id));
  const retired = Object.entries(inventory.files).filter(([, entry]) => !active.has(entry.job));
  for (const [key, entry] of retired) {
    const filename = inventoryPath(config, key);
    assertProtectedPath(config, filename);
    const destination = inventoryDestination(config, filename, entry);
    assertDestinationPath(filename, destination, 'recorded');
    readFile(filename);
  }
  if (check && retired.length) throw new Error(`Generated outputs belong to removed jobs:\n${retired.map(([key]) => `  ${key}`).join('\n')}`);
  if (!check && retired.length) {
    for (const [key, entry] of retired) {
      const filename = inventoryPath(config, key);
      // The job is gone, so nothing says its shared companion is unused; only a missing source deletes it.
      if (!(entry.shared === true && companionSourceExists(filename)) && readFile(filename) !== undefined) fs.unlinkSync(filename);
      delete inventory.files[key];
    }
    saveInventory(config, inventory);
  }
}
