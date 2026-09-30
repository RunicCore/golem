import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { PackedPackage, PackageManifest, PackResult } from './packed-archive.js';
import { publicSourceDigest } from './public-source.js';

// The registry serves the packed set built by test-pack.ts. It lives under
// scripts/ because both the packed tests and the prepare step's cache warming
// need it, and scripts must not import test-only code.
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface PreparedPackages { readonly workspaceVersion: string; readonly digest: string; readonly packages: ReadonlyMap<string, PackedPackage> }

export function preparedPackages(root: string = sourceRoot, packedRoot: string | undefined = process.env.FE_DEPS_PACKED_DIR): PreparedPackages {
  if (!packedRoot) throw new Error('FE_DEPS_PACKED_DIR is not set. Run packed tests through npm run test:full, test:acceptance, or npm run test -- <packed file>.');
  const digest = publicSourceDigest(root);
  const directory = path.join(packedRoot, digest);
  const manifestFile = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`No packed set for source digest ${digest}. The tier runner packs before packed tests; run npm run test:full.`);
  const value: { workspaceVersion: string; packages: { manifest: PackageManifest; pack: PackResult }[] } = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return {
    workspaceVersion: value.workspaceVersion,
    digest,
    packages: new Map(value.packages.map(entry => [entry.manifest.name, { ...entry, filename: path.join(directory, entry.pack.filename) }])),
  };
}

/** The `.npmrc` that sends `@exprtlabs` installs to the fixture registry and keeps npm quiet and script-free. */
export function registryNpmrc(url: string): string {
  return `@exprtlabs:registry=${url}\naudit=false\nfund=false\nignore-scripts=true\n`;
}

export interface PackedRegistry extends PreparedPackages {
  readonly url: string;
  readonly distTags: Readonly<Record<string, string>>;
  readonly npmVersion: string;
  readonly requests: string[];
  create(t: TestContext, label: string): string;
  close(): Promise<void>;
}

export async function startRegistry(prepared: PreparedPackages = preparedPackages()): Promise<PackedRegistry> {
  let url = '';
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '');
    requests.push(requested);
    if (requested.startsWith('tarballs/')) {
      const filename = path.basename(requested);
      const entry = [...prepared.packages.values()].find(item => item.pack.filename === filename);
      if (!entry) { response.writeHead(404); response.end(); return; }
      response.setHeader('content-type', 'application/octet-stream');
      fs.createReadStream(entry.filename).pipe(response);
      return;
    }
    const entry = prepared.packages.get(requested);
    if (!entry) { response.writeHead(404); response.end(JSON.stringify({ error: 'Package not part of fixture registry' })); return; }
    response.setHeader('content-type', 'application/json');
    const distTags = entry.manifest.version.includes('-') ? { rc: entry.manifest.version } : { latest: entry.manifest.version };
    response.end(JSON.stringify({ name: requested, 'dist-tags': distTags, versions: {
      [entry.manifest.version]: { ...entry.manifest, dist: { tarball: `${url}/tarballs/${entry.pack.filename}`, shasum: entry.pack.shasum, integrity: entry.pack.integrity } },
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Registry did not bind TCP.');
  url = `http://127.0.0.1:${address.port}`;
  const distTags: Readonly<Record<string, string>> = Object.freeze({ [prepared.workspaceVersion.includes('-') ? 'rc' : 'latest']: prepared.workspaceVersion });
  const version = spawnSync('npm', ['--version'], { cwd: os.tmpdir(), encoding: 'utf8' });
  if (version.error || version.status !== 0) throw version.error ?? new Error(`npm --version failed: ${version.stderr}`);
  return {
    ...prepared, url, distTags, requests,
    npmVersion: version.stdout.trim(),
    create(t, label) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `runic-consumer-${label}-`)));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'packed-consumer', version: '1.0.0', private: true, type: 'module' }));
      fs.writeFileSync(path.join(root, '.npmrc'), registryNpmrc(url));
      return root;
    },
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

export function packageSpec(registry: { readonly packages: ReadonlyMap<string, PackedPackage> }, name: string): string {
  const entry = registry.packages.get(name);
  if (!entry) throw new Error(`Package is not part of the packed fixture: ${name}`);
  return `${name}@${entry.manifest.version}`;
}
