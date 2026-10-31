// Which golem packages an app has installed and which golem.yaml block each registers (page "Registration").
// Core finds them through package.json; it knows no package name and loads no plan, generator or extension entry here.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { displayPath, isRecord } from './plan-support.js';
import { assertRuntimeCompatible } from './runtime-compatibility.js';

/** The `golem` field version that this golem reads. */
export const REGISTRATION_API_VERSION = 2;

/** A package.json or an installed package that the registry cannot use: the developer's input to fix. */
export class PackageRegistryError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'PackageRegistryError';
  }
}

/** What one package registers in its `golem` field. Every entry is the absolute file that Node resolves for its subpath; none is loaded. */
export interface PackageRegistration {
  readonly name: string;
  /** The package folder, with links followed. */
  readonly directory: string;
  readonly block: string;
  /** The light entry: options, outputs and contracts. */
  readonly plan: string | undefined;
  /** The heavy entry: loads TypeScript when a job runs. */
  readonly generator: string | undefined;
  /** The entries of the extensions that a block may turn on, by extension name. */
  readonly extensions: ReadonlyMap<string, string>;
  /** The part this package adds to the editor schema. */
  readonly schema: string | undefined;
}

export interface PackageRegistry {
  /** The registering packages in name order. */
  readonly packages: readonly PackageRegistration[];
  readonly blocks: ReadonlyMap<string, PackageRegistration>;
  /**
   * The files the registry read or looked for: golem.yaml, each package.json and pnpm-workspace.yaml of the walk, and the package.json of each
   * dependency name. The watch reloads the config when one changes, appears or goes.
   */
  readonly files: readonly string[];
}

/** The registration of `block`, or a stop that lists the installed golem packages and their blocks. */
export function registrationForBlock(registry: PackageRegistry, block: string): PackageRegistration {
  const registration = registry.blocks.get(block);
  if (registration) return registration;
  const installed = registry.packages.map(({ name, block: own }) => `${name} (block ${own})`);
  throw new PackageRegistryError(`No installed package registers the golem block "${block}". ${installed.length ? `Installed golem packages and their blocks: ${installed.join(', ')}.` : 'No installed package registers a golem block.'}`);
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
/** The fields that can pin golem for the lockstep check; a peer range counts there too. */
const GOLEM_PIN_FIELDS = [...DEPENDENCY_FIELDS, 'peerDependencies'] as const;
const GOLEM_FIELD_KEYS: ReadonlySet<string> = new Set(['apiVersion', 'block', 'plan', 'generator', 'extensions', 'schema']);
const GOLEM_PACKAGE = '@exprtlabs/golem';
/** What a dependency name may be; anything else cannot name a folder in node_modules and is not a candidate. */
const PACKAGE_NAME = /^(?:@[^/\\.][^/\\]*\/)?[^/\\.@][^/\\]*$/;

interface Manifest { readonly file: string; readonly directory: string; readonly data: Record<string, unknown> }

/** A file's stamp: its modification time and size, or `missing`. Another failure is the environment's, so it stops loading. */
function stampOf(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw new PackageRegistryError(`Cannot read ${displayPath(file)}: ${describe(error)}`, { cause: error });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readManifest(file: string): Manifest {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new PackageRegistryError(`Cannot read ${displayPath(file)}: ${describe(error)}`, { cause: error }); }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch (error) { throw new PackageRegistryError(`${displayPath(file)} is not valid JSON: ${describe(error)}`, { cause: error }); }
  if (!isRecord(data)) throw new PackageRegistryError(`${displayPath(file)} must hold a JSON object.`);
  return { file, directory: path.dirname(file), data };
}

/**
 * The package.json files that name candidates: from the golem.yaml folder up to the first one with `workspaces` or with a
 * pnpm-workspace.yaml beside it, else only the nearest. Every file looked at is stamped.
 */
function walkManifests(configDirectory: string, stamps: Map<string, string>): readonly Manifest[] {
  const found: Manifest[] = [];
  for (let directory = configDirectory; ; directory = path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    const stamp = stampOf(file);
    stamps.set(file, stamp);
    if (stamp !== 'missing') {
      const manifest = readManifest(file);
      found.push(manifest);
      const pnpmFile = path.join(directory, 'pnpm-workspace.yaml');
      const pnpmStamp = stampOf(pnpmFile);
      stamps.set(pnpmFile, pnpmStamp);
      if (manifest.data.workspaces !== undefined || pnpmStamp !== 'missing') return found;
    }
    if (path.dirname(directory) === directory) return found.slice(0, 1);
  }
}

/** The names a manifest lists, from its three dependency fields. */
function listedNames(manifest: Manifest): string[] {
  const names: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const listed = manifest.data[field];
    if (listed === undefined) continue;
    if (!isRecord(listed)) throw new PackageRegistryError(`"${field}" in ${displayPath(manifest.file)} must be an object.`);
    names.push(...Object.keys(listed));
  }
  return names;
}

/** The package.json of an installed `name`, found where Node's resolver looks from the golem.yaml folder. A package that is not installed has none. */
function installedManifest(requireFromConfig: NodeJS.Require, name: string, stamps: Map<string, string>): Manifest | undefined {
  for (const folder of requireFromConfig.resolve.paths(name) ?? []) {
    const file = path.join(folder, name, 'package.json');
    const stamp = stampOf(file);
    stamps.set(file, stamp);
    if (stamp === 'missing') continue;
    const manifest = readManifest(file);
    return { ...manifest, directory: realDirectory(manifest.directory) };
  }
  return undefined;
}

function realDirectory(directory: string): string {
  try { return fs.realpathSync.native(directory); }
  catch (error) { throw new PackageRegistryError(`Cannot read ${displayPath(directory)}: ${describe(error)}`, { cause: error }); }
}

function golemVersion(): string {
  // dist/tooling/package-registry.js → package.json of @exprtlabs/golem.
  const manifest = readManifest(fileURLToPath(new URL('../../package.json', import.meta.url)));
  if (typeof manifest.data.version !== 'string') throw new PackageRegistryError('@exprtlabs/golem package.json has no version.');
  return manifest.data.version;
}

/** A package declares golem's own version when it pins `@exprtlabs/golem` to the exact version that it has itself: it is published in lockstep. */
function declaresGolemVersion(manifest: Manifest): boolean {
  const version = manifest.data.version;
  return typeof version === 'string' && GOLEM_PIN_FIELDS.some((field) => {
    const listed = manifest.data[field];
    return isRecord(listed) && listed[GOLEM_PACKAGE] === version;
  });
}

/** The file that Node resolves for a `golem` entry such as `./plan` of `name`, without loading it. */
function resolveEntry(requireFromConfig: NodeJS.Require, configDirectory: string, name: string, key: string, subpath: unknown): string {
  if (typeof subpath !== 'string' || !subpath.startsWith('./') || subpath.length === 2 || subpath.split('/').includes('..')) {
    throw new PackageRegistryError(`golem.${key} of ${name} must be a package subpath such as "./plan", not ${JSON.stringify(subpath)}.`);
  }
  const specifier = `${name}/${subpath.slice(2)}`;
  try {
    return requireFromConfig.resolve(specifier);
  } catch (error) {
    throw new PackageRegistryError(`${name} declares golem.${key} "${subpath}", but ${specifier} does not resolve from ${displayPath(configDirectory)}: ${describe(error).split('\n')[0]}. Export "${subpath}" in the exports of ${name}.`, { cause: error });
  }
}

function registrationOf(requireFromConfig: NodeJS.Require, configDirectory: string, name: string, manifest: Manifest, field: unknown): PackageRegistration {
  if (!isRecord(field)) throw new PackageRegistryError(`"golem" in ${displayPath(manifest.file)} must be an object.`);
  if (field.apiVersion !== REGISTRATION_API_VERSION) {
    throw new PackageRegistryError(`Incompatible golem package ${name}: this golem reads registration API ${REGISTRATION_API_VERSION}; the package declares ${field.apiVersion === undefined ? 'no apiVersion' : `apiVersion ${JSON.stringify(field.apiVersion)}`}.`);
  }
  const unknown = Object.keys(field).filter((key) => !GOLEM_FIELD_KEYS.has(key));
  if (unknown.length) throw new PackageRegistryError(`"golem" in ${displayPath(manifest.file)} has unknown keys: ${unknown.join(', ')}. It takes: ${[...GOLEM_FIELD_KEYS].join(', ')}.`);
  if (typeof field.block !== 'string' || !field.block) throw new PackageRegistryError(`golem.block of ${name} must be a non-empty string.`);
  if (declaresGolemVersion(manifest)) {
    try { assertRuntimeCompatible({ name: GOLEM_PACKAGE, version: golemVersion() }, { name, version: String(manifest.data.version) }); }
    catch (error) { throw new PackageRegistryError(describe(error), { cause: error }); }
  }
  const entry = (key: 'plan' | 'generator' | 'schema'): string | undefined =>
    field[key] === undefined ? undefined : resolveEntry(requireFromConfig, configDirectory, name, key, field[key]);
  const declared = field.extensions;
  if (declared !== undefined && !isRecord(declared)) throw new PackageRegistryError(`golem.extensions of ${name} must be an object that maps an extension name to a package subpath.`);
  const extensions = new Map(Object.entries(declared ?? {}).map(([extension, subpath]) => [extension, resolveEntry(requireFromConfig, configDirectory, name, `extensions.${extension}`, subpath)]));
  return { name, directory: manifest.directory, block: field.block, plan: entry('plan'), generator: entry('generator'), extensions, schema: entry('schema') };
}

function buildRegistry(configFile: string, stamps: Map<string, string>): PackageRegistry {
  const configDirectory = path.dirname(configFile);
  stamps.set(configFile, stampOf(configFile));
  const manifests = walkManifests(configDirectory, stamps);
  // The nearest package is a candidate itself; it is not found in node_modules.
  const own = manifests[0];
  const requireFromConfig = createRequire(path.join(configDirectory, 'package.json'));
  const names = new Set(manifests.flatMap(listedNames).filter((name) => PACKAGE_NAME.test(name)));
  const candidates: Manifest[] = [];
  if (own && typeof own.data.name === 'string') {
    names.delete(own.data.name);
    candidates.push({ ...own, directory: realDirectory(own.directory) });
  }
  for (const name of [...names].sort()) {
    const installed = installedManifest(requireFromConfig, name, stamps);
    if (installed) candidates.push(installed);
  }
  const packages: PackageRegistration[] = [];
  const blocks = new Map<string, PackageRegistration>();
  for (const manifest of candidates) {
    if (manifest.data.golem === undefined) continue;
    const registration = registrationOf(requireFromConfig, configDirectory, String(manifest.data.name), manifest, manifest.data.golem);
    const claimed = blocks.get(registration.block);
    if (claimed) throw new PackageRegistryError(`${claimed.name} and ${registration.name} both register the golem block "${registration.block}". A block has one package: remove one of them.`);
    blocks.set(registration.block, registration);
    packages.push(registration);
  }
  packages.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { packages, blocks, files: [...stamps.keys()] };
}

interface CachedRegistry { readonly stamps: ReadonlyMap<string, string>; readonly registry: PackageRegistry }
const cache = new Map<string, CachedRegistry>();

function stillCurrent(cached: CachedRegistry): boolean {
  for (const [file, stamp] of cached.stamps) if (stampOf(file) !== stamp) return false;
  return true;
}

/**
 * The packages that register golem blocks for the project of `configFile`. The registry is read once: a later call returns
 * it again until golem.yaml or a package.json that it read changed, or one that it looked for appeared.
 * A problem in a package.json or in a package stops loading with a PackageRegistryError.
 */
export function loadPackageRegistry(configFile: string): PackageRegistry {
  const key = path.resolve(configFile);
  const cached = cache.get(key);
  if (cached && stillCurrent(cached)) return cached.registry;
  cache.delete(key);
  const stamps = new Map<string, string>();
  const registry = buildRegistry(key, stamps);
  cache.set(key, { stamps, registry });
  return registry;
}
