import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPublicSource, packedSetDigest } from './public-source.js';
import { assertReleaseConsistency } from './release-version.js';
import { readManifest, readPack, verifyPackedArchive, type PackedPackage } from './packed-archive.js';

export const PACKAGE_FOLDERS = ['golem', 'golem-model', 'golem-openapi-ts', 'golem-ts-openapi'] as const;

function npm(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const hint = /ENOTCACHED/.test(result.stderr) ? '\nThe npm cache is missing a package. Run: npm run test:prepare' : '';
    throw new Error(`npm ${args.join(' ')} failed (${result.status}):\n${result.stderr.slice(-4000)}${hint}`);
  }
  return result.stdout;
}

/** Pack the public source once per digest; keep only the newest set. */
export function packPublicSource(workspace: string, packedRoot: string): { readonly digest: string; readonly reused: boolean } {
  const digest = packedSetDigest(workspace);
  const target = path.join(packedRoot, digest);
  if (fs.existsSync(path.join(target, 'manifest.json'))) return { digest, reused: true };
  fs.mkdirSync(packedRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(packedRoot, '.staging-'));
  try {
    const source = path.join(staging, 'source');
    exportPublicSource(workspace, source);
    const workspaceVersion = assertReleaseConsistency(source);
    // An ordinary source checkout must be sufficient for npm pack.
    const env = process.env;
    npm(source, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], env);
    const packages: PackedPackage[] = [];
    for (const folder of PACKAGE_FOLDERS) {
      const packageRoot = path.join(source, 'packages', folder);
      const manifest = readManifest(path.join(packageRoot, 'package.json'));
      const pack = readPack(npm(packageRoot, ['pack', '--json', '--silent', '--pack-destination', staging], env));
      packages.push({ manifest, pack, filename: path.join(staging, pack.filename) });
    }
    for (const entry of packages) verifyPackedArchive(entry, staging, workspace);
    fs.rmSync(source, { recursive: true, force: true });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
      digest, workspaceVersion, node: process.version,
      packages: packages.map(entry => ({ manifest: entry.manifest, pack: entry.pack })),
    }, null, 2) + '\n');
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  for (const entry of fs.readdirSync(packedRoot)) if (entry !== digest) fs.rmSync(path.join(packedRoot, entry), { recursive: true, force: true });
  return { digest, reused: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packedRoot = process.env.FE_DEPS_PACKED_DIR;
  if (!packedRoot) throw new Error('FE_DEPS_PACKED_DIR is not set; packed tests run through npm run test:full or test:acceptance.');
  const started = Date.now();
  const { digest, reused } = packPublicSource(process.cwd(), packedRoot);
  process.stdout.write(`packed set ${digest.slice(0, 12)} ${reused ? 'reused' : 'built'} in ${Math.round((Date.now() - started) / 1000)}s\n`);
}
