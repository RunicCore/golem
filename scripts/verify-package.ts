import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseConsistency } from './release-version.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject source maps and stale output: every dist module must compile from a current src module. */
export function assertDistMatchesSource(root: string): void {
  const dist = path.join(root, 'dist');
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(filename); continue; }
      const relative = path.relative(dist, filename).split(path.sep).join('/');
      if (entry.name.endsWith('.map')) throw new Error(`Package must not publish source maps: ${root}: dist/${relative}`);
      const module = /\.(?:d\.ts|js)$/.exec(entry.name);
      if (!module) continue;
      const source = path.join(root, 'src', relative.slice(0, -module[0].length) + '.ts');
      if (!fs.existsSync(source)) throw new Error(`Stale package output without source: ${root}: dist/${relative}`);
    }
  };
  visit(dist);
}

export function verifyPackage(directory: string): void {
  const root = path.resolve(directory);
  const workspaceRoot = path.resolve(root, '..', '..');
  const releaseVersion = assertReleaseConsistency(workspaceRoot);
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!record(manifest) || manifest.type !== 'module' || manifest.license !== 'MIT' || manifest.version !== releaseVersion || !record(manifest.exports)) throw new Error(`Invalid package metadata: ${root}`);
  const requireFile = (value: unknown): string => {
    if (typeof value !== 'string' || !value.startsWith('./dist/')) throw new Error(`Export must target dist in ${root}: ${String(value)}`);
    const filename = path.resolve(root, value);
    if (!fs.statSync(filename).isFile()) throw new Error(`Missing package artifact: ${filename}`);
    return filename;
  };
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (typeof target === 'string') {
      if (!target.startsWith('./') || !fs.statSync(path.resolve(root, target)).isFile()) {
        throw new Error(`Invalid plugin export: ${subpath}`);
      }
      continue;
    }
    if (!record(target) || target.import !== target.default || typeof target.types !== 'string' || !target.types.endsWith('.d.ts')) throw new Error(`Invalid ESM export: ${subpath}`);
    requireFile(target.types);
    requireFile(target.import);
  }
  if (manifest.name === '@exprtlabs/golem') {
    if (!record(manifest.bin) || Object.keys(manifest.bin).join() !== 'golem') throw new Error('Shared package must own exactly golem.');
    const binary = requireFile(manifest.bin['golem']);
    if (!fs.readFileSync(binary, 'utf8').startsWith('#!/usr/bin/env node\n')) throw new Error('Missing CLI shebang.');
    fs.chmodSync(binary, 0o755);
  } else if (manifest.bin !== undefined) throw new Error('Generator packages must not own executables.');
  assertDistMatchesSource(root);
  const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  if (!license.includes('exprtlabs.ai') || !license.includes('MIT License')) throw new Error(`Missing MIT attribution: ${root}`);
  if (manifest.name === '@exprtlabs/golem-openapi') {
    for (const file of ['THIRD_PARTY_NOTICES.md', 'MATRIX.md', 'LICENSES/Apache-2.0.txt']) {
      if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing third-party or conformance artifact: ${file}`);
    }
    if (!Array.isArray(manifest.files) || manifest.files.some((file) => typeof file !== 'string')) {
      throw new Error('OpenAPI package must declare an explicit files list.');
    }
    if (manifest.files.some((file) => file === 'compliance' || file.startsWith('compliance/'))) {
      throw new Error('OpenAPI package must not publish internal compliance records.');
    }
  } else if (manifest.name === '@exprtlabs/golem-ts-openapi') {
    const generator = manifest.exports['./generator'];
    if (!record(generator)) throw new Error('Controller package must export ./generator.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyPackage(process.argv[2] ?? '.');
