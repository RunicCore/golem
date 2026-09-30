import fs from 'node:fs';
import path from 'node:path';

export type PackageSpecifierResult =
  | { readonly kind: 'same-package' }
  | { readonly kind: 'package'; readonly specifier: string }
  | { readonly kind: 'unexported'; readonly packageName: string; readonly packageRoot: string };

interface PackageManifest { readonly root: string; readonly name: string; readonly exports?: unknown }

/** Parsed package.json files, re-read when the file changes (watch mode keeps this process alive). */
const manifests = new Map<string, { readonly mtimeMs: number; readonly name?: string; readonly exports?: unknown }>();

function readManifest(filename: string): { readonly name?: string; readonly exports?: unknown } | undefined {
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(filename).mtimeMs; } catch { return undefined; }
  const cached = manifests.get(filename);
  if (cached?.mtimeMs === mtimeMs) return cached;
  const json = JSON.parse(fs.readFileSync(filename, 'utf8')) as { name?: string; exports?: unknown };
  const manifest = { mtimeMs, name: json.name, exports: json.exports };
  manifests.set(filename, manifest);
  return manifest;
}

/** The package that owns `file`: the nearest package.json with a name. A nameless one (such as `{"type":"module"}`) only scopes module format. */
function nearestManifest(file: string): PackageManifest | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = readManifest(path.join(dir, 'package.json'));
    if (manifest?.name) return { root: dir, name: manifest.name, exports: manifest.exports };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Every file target reachable from one exports entry, after condition nesting. */
function targets(entry: unknown): string[] {
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry.flatMap(targets);
  if (entry && typeof entry === 'object') {
    return Object.entries(entry).filter(([condition]) => ['types', 'import', 'default', 'node'].includes(condition)).flatMap(([, value]) => targets(value));
  }
  return [];
}

/** The file an exports target names for `file`: itself, or the runtime file beside its declaration or source. */
function exportCandidates(relativeFile: string): readonly string[] {
  const runtime = relativeFile
    .replace(/\.d\.(m|c)?ts$/, (_match, kind: string | undefined) => `.${kind ?? ''}js`)
    .replace(/\.(m|c)?ts$/, (_match, kind: string | undefined) => `.${kind ?? ''}js`);
  return runtime === relativeFile ? [relativeFile] : [relativeFile, runtime];
}

function subpathFor(exportsField: unknown, relativeFile: string): string | undefined {
  const map: Record<string, unknown> = typeof exportsField === 'string' || Array.isArray(exportsField)
    || (exportsField && typeof exportsField === 'object' && !Object.keys(exportsField).some((key) => key.startsWith('.')))
    ? { '.': exportsField }
    : (exportsField as Record<string, unknown> | undefined) ?? {};
  const candidates = exportCandidates(relativeFile);
  for (const [subpath, entry] of Object.entries(map)) {
    for (const target of targets(entry)) {
      const normalized = target.replace(/^\.\//, '');
      for (const candidate of candidates) {
        if (!normalized.includes('*')) {
          if (normalized === candidate) return subpath;
          continue;
        }
        const [prefix, suffix] = normalized.split('*') as [string, string];
        if (candidate.startsWith(prefix) && candidate.endsWith(suffix) && candidate.length >= prefix.length + suffix.length) {
          return subpath.replace('*', candidate.slice(prefix.length, candidate.length - suffix.length));
        }
      }
    }
  }
  return undefined;
}

/**
 * How code in `fromFile` imports `file`: relatively within one package, or by
 * the owning package's name plus the `exports` subpath that reaches `file`.
 */
export function packageSpecifier(file: string, fromFile: string): PackageSpecifierResult {
  const owner = nearestManifest(file);
  const consumer = nearestManifest(fromFile);
  if (!owner || owner.root === consumer?.root) return { kind: 'same-package' };
  const relativeFile = path.relative(owner.root, file).replace(/\\/g, '/');
  const subpath = subpathFor(owner.exports, relativeFile);
  if (subpath === undefined) return { kind: 'unexported', packageName: owner.name, packageRoot: owner.root };
  return { kind: 'package', specifier: subpath === '.' ? owner.name : `${owner.name}/${subpath.replace(/^\.\//, '')}` };
}
