import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { workspace } from './support/process.js';

const fixtures = path.resolve(fileURLToPath(new URL('../../tests/fixtures/', import.meta.url)));

export function fixturePath(relative: string): string {
  const filename = path.resolve(fixtures, relative);
  if (filename !== fixtures && !filename.startsWith(`${fixtures}${path.sep}`)) {
    throw new Error(`Fixture path must stay inside tests/fixtures: ${relative}`);
  }
  return filename;
}

export function readFixture(relative: string): string {
  return fs.readFileSync(fixturePath(relative), 'utf8');
}

export function copyFixture(root: string, fixtureDirectory: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(fixturePath(fixtureDirectory), root, { recursive: true });
}

export function copyFixtureFile(root: string, fixtureRelative: string, destinationRelative: string): string {
  const destination = path.join(root, destinationRelative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(fixturePath(fixtureRelative), destination);
  return destination;
}

/** What a fixture needs from its owner: a place to register its cleanup. A test context is one. */
export interface FixtureScope { after(cleanup: () => void): void }

/**
 * A scope for fixtures that several tests of one file share: the file's last test ends and the fixtures go. Call it at module
 * level, where `after` registers for the file. Every cleanup runs; the first error that one throws is thrown after them.
 */
export function fileFixtureScope(): FixtureScope {
  const cleanups: (() => void)[] = [];
  after(() => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  });
  return { after: (cleanup) => { cleanups.push(cleanup); } };
}

/** Builds a fixture on first use and hands every later caller the same one. */
export function onceShared<T>(build: () => Promise<T>): () => Promise<T> {
  let shared: Promise<T> | undefined;
  return () => (shared ??= build());
}

export function createFixtureProject(t: FixtureScope, prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export function linkProjectPackages(root: string, packages: Readonly<Record<string, string>>): void {
  for (const [name, source] of Object.entries(packages)) {
    const destination = path.join(root, 'node_modules', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (!fs.existsSync(destination)) fs.symlinkSync(source, destination, 'dir');
  }
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** Lists `names` as dependencies in the package.json of `root`, which must exist: golem finds the packages that register a golem.yaml block there. A name that a dependency field already lists keeps its range. */
export function listProjectDependencies(root: string, names: readonly string[]): void {
  const filename = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, Record<string, string> | undefined>;
  const dependencies = { ...manifest.dependencies };
  for (const name of names) {
    if (!DEPENDENCY_FIELDS.some((field) => manifest[field]?.[name] !== undefined)) dependencies[name] = '*';
  }
  fs.writeFileSync(filename, JSON.stringify({ ...manifest, dependencies }));
}

/** Links the workspace packages `names` (`golem-model` for `@exprtlabs/golem-model`) into the node_modules of `root` and lists them as dependencies in its package.json, which must exist. */
export function linkGolemPackages(root: string, names: readonly string[]): void {
  const packages = names.map((name) => `@exprtlabs/${name}`);
  linkProjectPackages(root, Object.fromEntries(packages.map((name) => [name, path.join(workspace, 'packages', name.slice('@exprtlabs/'.length))])));
  listProjectDependencies(root, packages);
}

export function writeGeneratedArtifacts(artifacts: readonly { readonly path: string; readonly content: string }[]): void {
  for (const artifact of artifacts) {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, artifact.content);
  }
}

export interface FilesystemSnapshot {
  readonly files: readonly (readonly [string, string, string])[];
  readonly directories: readonly (readonly [string, string, readonly string[]])[];
}

export function snapshotFilesystem(root: string): FilesystemSnapshot {
  const files: Array<readonly [string, string, string]> = [];
  const directories: Array<readonly [string, string, readonly string[]]> = [];
  const visit = (directory: string): void => {
    const relativeDirectory = path.relative(root, directory) || '.';
    const directoryStat = fs.statSync(directory, { bigint: true });
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    directories.push([
      relativeDirectory,
      directoryStat.mtimeNs.toString(),
      entries.map((entry) => entry.name).sort(),
    ]);
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filename);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(filename, { bigint: true });
      files.push([
        path.relative(root, filename),
        fs.readFileSync(filename).toString('base64'),
        stat.mtimeNs.toString(),
      ]);
    }
  };
  visit(root);
  files.sort(([left], [right]) => left.localeCompare(right));
  directories.sort(([left], [right]) => left.localeCompare(right));
  return { files, directories };
}
