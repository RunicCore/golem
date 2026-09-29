import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

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

export function createFixtureProject(t: TestContext, prefix: string): string {
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
