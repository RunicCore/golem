import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { CodegenProfile } from '@exprtlabs/codegen/generator-api';
import { copyFixtureFile } from '../fixture-project.js';
import { exportPublicSource, publicContentOptions, scanPublicContent } from '../../scripts/public-source.js';
import { assertReleaseConsistency } from '../../scripts/release-version.js';
import type { ExampleName } from '../../scripts/maintained-examples.js';


export interface CommandOptions { readonly env?: NodeJS.ProcessEnv; readonly timeout?: number; readonly allowFailure?: boolean }
export interface NpmOptions { readonly includeOptional?: boolean }
export interface CommandResult { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }
export interface PackageManifest { readonly name: string; readonly version: string; readonly license: string; readonly bin?: Readonly<Record<string, string>>; readonly exports: Readonly<Record<string, unknown>>; readonly [key: string]: unknown }
export interface PackResult { readonly filename: string; readonly shasum: string; readonly integrity: string; readonly files: readonly { readonly path: string }[] }
export interface PackedPackage { readonly manifest: PackageManifest; readonly pack: PackResult; readonly filename: string }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function readManifest(filename: string): PackageManifest {
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!record(value) || typeof value.name !== 'string' || typeof value.version !== 'string' || typeof value.license !== 'string' || !record(value.exports)) throw new Error('Invalid package manifest');
  const bin = record(value.bin) ? Object.fromEntries(Object.entries(value.bin).map(([name, target]) => { if (typeof target !== 'string') throw new Error('Invalid binary'); return [name, target]; })) : undefined;
  return { ...value, name: value.name, version: value.version, license: value.license, exports: value.exports, ...(bin ? {bin} : {}) };
}
function readPack(stdout: string): PackResult {
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
    if (/^plugin\/(?:.*_test\.go|go\.work(?:\.sum)?)$/.test(file)) {
      throw new Error(`Packed package ships local Go development file: ${entry.manifest.name}:${file}`);
    }
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

async function verifyPackedArchive(entry: PackedPackage, directory: string): Promise<void> {
  const declared = entry.pack.files.map(file => archiveRelativePath(file.path, entry.manifest.name, false));
  if (declared.some((file): file is null => file === null) || new Set(declared).size !== declared.length) {
    throw new Error(`Packed inventory is invalid: ${entry.manifest.name}`);
  }
  const listed = await command(directory, 'tar', ['-tzf', entry.filename]);
  const archiveFiles = listed.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(value => ({ value, relative: archiveRelativePath(value, entry.manifest.name, true) }))
    .filter((entryValue): entryValue is { readonly value: string; readonly relative: string } => entryValue.relative !== null && !entryValue.value.endsWith('/'))
    .map(entryValue => entryValue.relative)
    .sort();
  assert.deepEqual(archiveFiles, [...declared].sort(), `tar inventory mismatch for ${entry.manifest.name}`);

  const extraction = fs.realpathSync(fs.mkdtempSync(path.join(directory, `archive-${entry.manifest.name.replace(/[^A-Za-z0-9]+/g, '-')}-`)));
  try {
    await command(directory, 'tar', ['-xzf', entry.filename, '-C', extraction]);
    const packageRoot = path.join(extraction, 'package');
    if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
      throw new Error(`Packed archive is missing package root: ${entry.manifest.name}`);
    }
    assert.deepEqual(archiveFilesUnder(packageRoot), [...declared].sort(), `extracted inventory mismatch for ${entry.manifest.name}`);
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

export const workspace = fileURLToPath(new URL('../../../', import.meta.url));
export const ttsc = path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js');
export const ttscEnv = { NODE_PATH: path.join(workspace, 'node_modules') };
export const versions = { mobx: '^6.13.0', ajv: '^8.20.0', 'ajv-formats': '^3.0.1', typescript: '~7.0.2', ttsc: '~0.30.4' };
export const baselineNode = '22.12.0';
let npmCli: string | undefined;

function runNpm(root: string, args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  return npmCli ? command(root, process.execPath, [npmCli, ...args], options) : command(root, 'npm', args, options);
}

export function command(cwd: string, executable: string, args: readonly string[] = [], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: '', ...options.env };
    if (
      executable === process.execPath
      && typeof args[0] === 'string'
      && args[0].includes(`${path.sep}ttsc${path.sep}`)
    ) {
      if (!options.env?.NODE_PATH) env.NODE_PATH = path.join(workspace, 'node_modules');
      // Temporary projects still build their own plugin binaries. Reuse Go's
      // content-addressed dependency cache instead of rebuilding the compiler
      // dependencies for every isolated fixture.
      if (args[1] !== 'clean' && !env.TTSC_GO_CACHE_DIR && !env.GOCACHE) {
        env.TTSC_GO_CACHE_DIR = path.join(workspace, 'node_modules/.cache/ttsc/go-build');
      }
    }
    // A Node test worker's private context marker makes a nested `node --test`
    // skip its requested files. Child consumer commands run independently.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Timed out: ${executable} ${args.join(' ')}`)); }, options.timeout || 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr };
      if ((code !== 0 || signal !== null) && !options.allowFailure) reject(new Error(`${executable} ${args.join(' ')} failed (${code}):\n${stdout.slice(-6000)}\n${stderr.slice(-6000)}`));
      else resolve(result);
    });
  });
}

export async function packedRegistry() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runic-packages-')));
  const toolRoot = path.join(directory, 'verification-tools');
  await command(directory, 'npm', ['install', '--prefix', toolRoot, '--no-save', '--no-audit', '--no-fund', 'npm@10.9.8', `node@${baselineNode}`], { timeout: 240000 });
  npmCli = path.join(toolRoot, 'node_modules/npm/bin/npm-cli.js');
  if (!npmCli) throw new Error('Bundled npm CLI path was not initialized.');
  const node22 = path.join(toolRoot, 'node_modules/node/bin/node');
  const cleanWorkspace = path.join(directory, 'source workspace');
  exportPublicSource(workspace, cleanWorkspace);
  const workspaceVersion = assertReleaseConsistency(cleanWorkspace);
  // An ordinary source checkout must be sufficient for the first npm pack.
  await runNpm(cleanWorkspace, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { timeout: 240000 });
  const packages = new Map<string, PackedPackage>();
  for (const folder of ['codegen', 'model-codegen', 'openapi-to-ts', 'ts-to-openapi']) {
    const packageRoot = path.join(cleanWorkspace, 'packages', folder);
    const manifest = readManifest(path.join(packageRoot, 'package.json'));
    const result = await runNpm(packageRoot, ['pack', '--json', '--silent', '--pack-destination', directory], { timeout: 240000 });
    const pack = readPack(result.stdout);
    packages.set(manifest.name, { manifest, pack, filename: path.join(directory, pack.filename) });
  }
  for (const entry of packages.values()) await verifyPackedArchive(entry, directory);
  const artifactDirectory = path.join(workspace, '.cache', 'tarballs');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const sourceHash = createHash('sha256');
  for (const filename of filesUnder(cleanWorkspace).filter(filename => !path.relative(cleanWorkspace, filename).split(path.sep).some(part => ['node_modules', 'dist', '.build', '.cache'].includes(part))).sort()) {
    sourceHash.update(path.relative(cleanWorkspace, filename));
    sourceHash.update('\0');
    sourceHash.update(fs.readFileSync(filename));
    sourceHash.update('\0');
  }
  for (const entry of packages.values()) fs.copyFileSync(entry.filename, path.join(artifactDirectory, entry.pack.filename));
  fs.writeFileSync(path.join(artifactDirectory, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    workspaceVersion,
    sourceSnapshotSha256: sourceHash.digest('hex'),
    hostNode: process.version,
    baselineNode,
    npm: '10.9.8',
    packages: [...packages.values()].map(entry => ({ name: entry.manifest.name, version: entry.manifest.version, ...entry.pack })),
  }, null, 2) + '\n');
  let registry = '';
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    requests.push(requested);
    if (requested.startsWith('tarballs/')) {
      const filename = path.basename(requested);
      const entry = [...packages.values()].find(item => item.pack.filename === filename);
      if (!entry) { response.writeHead(404); response.end(); return; }
      response.setHeader('content-type', 'application/octet-stream');
      fs.createReadStream(entry.filename).pipe(response);
      return;
    }
    const entry = packages.get(requested);
    if (!entry) { response.writeHead(404); response.end(JSON.stringify({ error: 'Package not part of fixture registry' })); return; }
    response.setHeader('content-type', 'application/json');
    const distTags = entry.manifest.version.includes('-') ? { rc: entry.manifest.version } : { latest: entry.manifest.version };
    response.end(JSON.stringify({ name: requested, 'dist-tags': distTags, versions: {
      [entry.manifest.version]: { ...entry.manifest, dist: { tarball: `${registry}/tarballs/${entry.pack.filename}`, shasum: entry.pack.shasum, integrity: entry.pack.integrity } },
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Registry did not bind TCP.');
  registry = `http://127.0.0.1:${address.port}`;
  return {
    packages,
    workspaceVersion,
    distTags: Object.freeze(workspaceVersion.includes('-') ? { rc: workspaceVersion } : { latest: workspaceVersion }),
    node22,
    npmCliPath: npmCli,
    npmVersion: (await runNpm(directory, ['--version'])).stdout.trim(),
    requests,
    create(t: TestContext, label: string) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `runic-consumer-${label}-`)));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'packed-consumer', version: '1.0.0', private: true, type: 'module' }));
      fs.writeFileSync(path.join(root, '.npmrc'), `@exprtlabs:registry=${registry}\naudit=false\nfund=false\nignore-scripts=true\n`);
      return root;
    },
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

export function packageSpec(registry: { readonly packages: ReadonlyMap<string, PackedPackage> }, name: string): string {
  const entry = registry.packages.get(name);
  if (!entry) throw new Error(`Package is not part of the packed fixture: ${name}`);
  return `${name}@${entry.manifest.version}`;
}

export const npm = (root: string, args: readonly string[], options: NpmOptions = {}): Promise<CommandResult> => runNpm(root, [
  ...args,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  options.includeOptional === false ? '--omit=optional' : '--include=optional',
]);
export const cli = (root: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> => command(root, path.join(root, 'node_modules/.bin/runic-codegen'), args, options);

/** Copy a maintained repository consumer, excluding installed/build artifacts. */
export function copyExample(root: string, name: ExampleName): void {
  const source = path.join(workspace, 'examples', name);
  fs.cpSync(source, root, {
    recursive: true,
    filter: filename => !path.relative(source, filename).split(path.sep)
      .some(part => ['node_modules', '.build', 'dist', '.cache', '.git', '.npmrc'].includes(part)),
  });
}

export function writeFixture(root: string, profile: CodegenProfile, includeModels = true): void {
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  if (includeModels) copyFixtureFile(root, 'packed/profile/src/cart.model.ts', 'src/cart.model.ts');
  else fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  const configuration = [
    'version: 1',
    `mobx: ${profile.mobx}`,
    `validation: ${profile.validation}`,
    `ajvStandalone: ${profile.ajvStandalone ?? false}`,
    'openapi:',
    '  - input: api.json',
    '    output: sdk',
    '    name: Profile',
    ...(includeModels ? ['models:', '  root: .'] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'runic-codegen.yaml'), configuration);
}

export function generatedCodecId(source: string, shortName: string): string {
  const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`createObjectCodec\\("(${escaped}_[0-9a-f]{8})"`));
  if (!match) throw new Error(`Generated codec id for ${JSON.stringify(shortName)} is missing.`);
  return match[1];
}

export function generatedCodecIdFromRoot(root: string, shortName: string): string {
  return generatedCodecId(
    filesUnder(root)
      .filter((filename) => filename.endsWith('.generated.ts') || filename.endsWith('models.ts')
        || filename.endsWith('iobject-plugin-keys.ts')
        || (path.basename(path.dirname(filename)) === 'models' && /^_group-.*\.ts$/.test(path.basename(filename))))
      .map((filename) => fs.readFileSync(filename, 'utf8'))
      .join('\n'),
    shortName,
  );
}

export function assertExecutedConsumerTests(output: string, label: string): void {
  const metric = (name: string): number => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    assert.ok(match, `${label} must report its ${name} count in TAP output`);
    return Number(match[1]);
  };
  const tests = metric('tests');
  const passed = metric('pass');
  const failed = metric('fail');
  const cancelled = metric('cancelled');
  const skipped = metric('skipped');
  assert.ok(tests > 0 && passed > 0, `${label} must execute and pass at least one test`);
  assert.equal(failed, 0, `${label} must have no failures`);
  assert.equal(cancelled, 0, `${label} must have no cancellations`);
  assert.equal(skipped, 0, `${label} must have no skipped tests`);
  assert.equal(passed, tests, `${label} must pass every test it reports`);
}

export function filesUnder(root: string): string[] {
  const result: string[] = [];
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}
