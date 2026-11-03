import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { publicContentOptions, scanPublicContent } from './public-source.js';

export interface PackageManifest { readonly name: string; readonly version: string; readonly license: string; readonly bin?: Readonly<Record<string, string>>; readonly exports: Readonly<Record<string, unknown>>; readonly [key: string]: unknown }
export interface PackResult { readonly filename: string; readonly shasum: string; readonly integrity: string; readonly files: readonly { readonly path: string }[] }
export interface PackedPackage { readonly manifest: PackageManifest; readonly pack: PackResult; readonly filename: string }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function readManifest(filename: string): PackageManifest {
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!record(value) || typeof value.name !== 'string' || typeof value.version !== 'string' || typeof value.license !== 'string' || !record(value.exports)) throw new Error('Invalid package manifest');
  const bin = record(value.bin) ? Object.fromEntries(Object.entries(value.bin).map(([name, target]) => { if (typeof target !== 'string') throw new Error('Invalid binary'); return [name, target]; })) : undefined;
  return { ...value, name: value.name, version: value.version, license: value.license, exports: value.exports, ...(bin ? {bin} : {}) };
}
export function readPack(stdout: string): PackResult {
  const values: unknown = JSON.parse(stdout);
  const value: unknown = Array.isArray(values) ? values[0] : undefined;
  if (!record(value) || typeof value.filename !== 'string' || typeof value.shasum !== 'string' || typeof value.integrity !== 'string' || !Array.isArray(value.files)) throw new Error('Invalid npm pack output');
  return { filename: value.filename, shasum: value.shasum, integrity: value.integrity, files: value.files.map((file: unknown) => { if (!record(file) || typeof file.path !== 'string') throw new Error('Invalid packed file'); return {path:file.path}; }) };
}

function archiveRelativePath(value: string, packageName: string, archiveEntry: boolean): string | null {
  const normalized = value.replaceAll('\\', '/');
  const directory = normalized.endsWith('/');
  const trimmed = directory ? normalized.slice(0, -1) : normalized;
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) {
    throw new Error(`Packed archive path rejected for ${packageName}: ${value}`);
  }
  const segments = trimmed.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Packed archive path rejected for ${packageName}: ${value}`);
  }
  if (archiveEntry) {
    if (segments[0] !== 'package') {
      throw new Error(`Packed archive path rejected for ${packageName}: ${value}`);
    }
    segments.shift();
  }
  if (!segments.length || directory && !segments.length) return null;
  return segments.join('/');
}

function archiveFilesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(filename);
      } else {
        files.push(path.relative(root, filename).split(path.sep).join('/'));
      }
    }
  };
  visit(root);
  return files.sort();
}

function assertPublishedFileHygiene(root: string, entry: PackedPackage): void {
  for (const file of archiveFilesUnder(root)) {
    if (file.endsWith('.map')) throw new Error(`Packed package must not ship source maps: ${entry.manifest.name}:${file}`);
  }
}

function assertExtractedPackageContract(root: string, entry: PackedPackage): void {
  assertPublishedFileHygiene(root, entry);
  const manifestFile = path.join(root, 'package.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`Packed package is missing package.json: ${entry.manifest.name}`);
  const manifest = readManifest(manifestFile);
  if (manifest.name !== entry.manifest.name || manifest.version !== entry.manifest.version || manifest.license !== entry.manifest.license) {
    throw new Error(`Packed package metadata mismatch: ${entry.manifest.name}`);
  }
  const licenseFile = path.join(root, 'LICENSE');
  if (!fs.existsSync(licenseFile) || !fs.statSync(licenseFile).isFile()) {
    throw new Error(`Packed package is missing LICENSE: ${entry.manifest.name}`);
  }
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (typeof target === 'string') {
      const relative = target.startsWith('./') ? target.slice(2) : '';
      const filename = path.resolve(root, relative);
      const escaped = path.relative(root, filename);
      if (!relative || escaped === '..' || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)
        || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        throw new Error(`Packed package plugin export missing: ${entry.manifest.name}:${subpath}`);
      }
      continue;
    }
    if (!record(target) || typeof target.types !== 'string' || typeof target.import !== 'string' || target.default !== target.import) {
      throw new Error(`Packed package export metadata invalid: ${entry.manifest.name}:${subpath}`);
    }
    for (const field of ['types', 'import'] as const) {
      const value = target[field];
      if (typeof value !== 'string') throw new Error(`Packed package export target invalid: ${entry.manifest.name}:${subpath}/${field}`);
      const relative = value.startsWith('./') ? value.slice(2) : '';
      const filename = path.resolve(root, relative);
      const escaped = path.relative(root, filename);
      const existsAsFile = fs.existsSync(filename) && fs.statSync(filename).isFile();
      if (!relative || escaped === '..' || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped) || !existsAsFile) {
        throw new Error(`Packed package export target missing: ${entry.manifest.name}:${subpath}/${field}`);
      }
    }
  }
}

function tar(directory: string, args: readonly string[]): string {
  const result = spawnSync('tar', args, { cwd: directory, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

function assertSameFiles(actual: readonly string[], expected: readonly string[], label: string): void {
  const missing = expected.filter(file => !actual.includes(file));
  const extra = actual.filter(file => !expected.includes(file));
  if (missing.length || extra.length) throw new Error(`${label}\nmissing: ${missing.join(', ') || 'none'}\nextra: ${extra.join(', ') || 'none'}`);
}

export function verifyPackedArchive(entry: PackedPackage, directory: string, workspace: string): void {
  const listedInventory = entry.pack.files.map(file => archiveRelativePath(file.path, entry.manifest.name, false));
  const declared = listedInventory.filter((file): file is string => file !== null);
  if (declared.length !== listedInventory.length || new Set(declared).size !== declared.length) {
    throw new Error(`Packed inventory is invalid: ${entry.manifest.name}`);
  }
  const archiveFiles = tar(directory, ['-tzf', entry.filename])
    .split(/\r?\n/)
    .filter(Boolean)
    .map(value => ({ value, relative: archiveRelativePath(value, entry.manifest.name, true) }))
    .filter((entryValue): entryValue is { readonly value: string; readonly relative: string } => entryValue.relative !== null && !entryValue.value.endsWith('/'))
    .map(entryValue => entryValue.relative)
    .sort();
  assertSameFiles(archiveFiles, [...declared].sort(), `tar inventory mismatch for ${entry.manifest.name}`);

  const extraction = fs.realpathSync(fs.mkdtempSync(path.join(directory, `archive-${entry.manifest.name.replace(/[^A-Za-z0-9]+/g, '-')}-`)));
  try {
    tar(directory, ['-xzf', entry.filename, '-C', extraction]);
    const packageRoot = path.join(extraction, 'package');
    if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
      throw new Error(`Packed archive is missing package root: ${entry.manifest.name}`);
    }
    assertSameFiles(archiveFilesUnder(packageRoot), [...declared].sort(), `extracted inventory mismatch for ${entry.manifest.name}`);
    const issues = scanPublicContent(packageRoot, undefined, { ...publicContentOptions(workspace), artifact: 'package' });
    if (issues.length) {
      const summary = issues.map(issue => `${issue.category}:${issue.path}`).join(', ');
      throw new Error(`Packed package content rejected: ${entry.manifest.name}: ${summary}`);
    }
    assertExtractedPackageContract(packageRoot, entry);
  } finally {
    fs.rmSync(extraction, { recursive: true, force: true });
  }
}
