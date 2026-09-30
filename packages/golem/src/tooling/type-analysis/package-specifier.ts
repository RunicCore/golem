import fs from 'node:fs';
import path from 'node:path';

export type PackageSpecifierResult =
  | { readonly kind: 'same-package' }
  | { readonly kind: 'package'; readonly specifier: string }
  | { readonly kind: 'unexported'; readonly packageName: string; readonly packageRoot: string };

interface PackageManifest { readonly root: string; readonly name?: string; readonly exports?: unknown }

const manifests = new Map<string, PackageManifest | undefined>();

function nearestManifest(file: string): PackageManifest | undefined {
  let dir = path.dirname(file);
  for (;;) {
    if (manifests.has(dir)) return manifests.get(dir);
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      const json = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; exports?: unknown };
      const manifest = { root: dir, name: json.name, exports: json.exports };
      manifests.set(dir, manifest);
      return manifest;
    }
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

function subpathFor(exportsField: unknown, relativeFile: string): string | undefined {
  const map: Record<string, unknown> = typeof exportsField === 'string' || Array.isArray(exportsField)
    || (exportsField && typeof exportsField === 'object' && !Object.keys(exportsField).some((key) => key.startsWith('.')))
    ? { '.': exportsField }
    : (exportsField as Record<string, unknown> | undefined) ?? {};
  for (const [subpath, entry] of Object.entries(map)) {
    for (const target of targets(entry)) {
      const normalized = target.replace(/^\.\//, '');
      if (!normalized.includes('*')) {
        if (normalized === relativeFile) return subpath;
        continue;
      }
      const [prefix, suffix] = normalized.split('*') as [string, string];
      if (relativeFile.startsWith(prefix) && relativeFile.endsWith(suffix) && relativeFile.length >= prefix.length + suffix.length) {
        return subpath.replace('*', relativeFile.slice(prefix.length, relativeFile.length - suffix.length));
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
  if (!owner || !owner.name || owner.root === consumer?.root) return { kind: 'same-package' };
  const relativeFile = path.relative(owner.root, file).replace(/\\/g, '/');
  const subpath = subpathFor(owner.exports, relativeFile);
  if (subpath === undefined) return { kind: 'unexported', packageName: owner.name, packageRoot: owner.root };
  return { kind: 'package', specifier: subpath === '.' ? owner.name : `${owner.name}/${subpath.replace(/^\.\//, '')}` };
}
