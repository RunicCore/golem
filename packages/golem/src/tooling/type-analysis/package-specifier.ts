import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath } from '../generator-api.js';
import { isOutside } from './path-identity.js';

type PackageSpecifierResult =
  | { readonly kind: 'same-package' }
  | { readonly kind: 'package'; readonly specifier: string }
  | { readonly kind: 'unexported'; readonly packageName: string; readonly packageRoot: string };

interface PackageManifest { readonly root: string; readonly name: string; readonly exports?: unknown }

/** Parsed package.json files, re-read when the file changes (watch mode keeps this process alive). */
const manifests = new Map<string, { readonly mtimeMs: number; readonly name?: string; readonly exports?: unknown }>();

export function readManifest(filename: string): { readonly name?: string; readonly exports?: unknown } | undefined {
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(filename).mtimeMs; } catch { return undefined; }
  const cached = manifests.get(filename);
  if (cached?.mtimeMs === mtimeMs) return cached;
  let json: { name?: string; exports?: unknown };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the JSON is not an object');
    json = parsed as { name?: string; exports?: unknown };
  }
  catch (error) { throw new Error(`Cannot read ${filename} to resolve a package import: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
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

/** Conditions a generated TypeScript file matches under Node's ESM rules, besides `default`. */
const IMPORT_CONDITIONS: ReadonlySet<string> = new Set(['types', 'import', 'node', 'default']);
/** Conditions a CommonJS file matches under Node16 and NodeNext resolution. */
const REQUIRE_CONDITIONS: ReadonlySet<string> = new Set(['types', 'require', 'node', 'default']);

/**
 * The file one exports target names for a subpath, after Node's target rules: the first matching condition (in
 * object order) decides, the first resolvable array item wins, and `null` excludes. `undefined` means no target
 * applies. `capture` fills each `*` of a pattern target.
 */
function resolveTarget(target: unknown, capture: string | undefined, conditions: ReadonlySet<string>): string | null | undefined {
  if (target === null) return null;
  if (typeof target === 'string') {
    if (!target.startsWith('./')) return undefined;
    return capture === undefined ? target : target.replaceAll('*', capture);
  }
  if (Array.isArray(target)) {
    let excluded: null | undefined;
    for (const item of target) {
      const resolved = resolveTarget(item, capture, conditions);
      if (resolved === null) excluded = null;
      else if (resolved !== undefined) return resolved;
    }
    return excluded;
  }
  if (target && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (!conditions.has(condition)) continue;
      const resolved = resolveTarget(value, capture, conditions);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

/** Node's PACKAGE_EXPORTS_RESOLVE for one subpath: an exact key, else the pattern key with the longest prefix. */
function resolveSubpath(map: Readonly<Record<string, unknown>>, subpath: string, conditions: ReadonlySet<string> = IMPORT_CONDITIONS): string | null | undefined {
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) return resolveTarget(map[subpath], undefined, conditions);
  let best: { readonly key: string; readonly base: string; readonly capture: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1 || star !== key.lastIndexOf('*')) continue;
    const base = key.slice(0, star);
    const trailer = key.slice(star + 1);
    if (subpath.length < key.length || !subpath.startsWith(base) || !subpath.endsWith(trailer)) continue;
    if (best && (best.base.length > base.length || (best.base.length === base.length && best.key.length >= key.length))) continue;
    best = { key, base, capture: subpath.slice(base.length, subpath.length - trailer.length) };
  }
  return best ? resolveTarget(map[best.key], best.capture, conditions) : undefined;
}

/** The exports field as a map of subpath keys: a string, an array or a condition object with no `.` key is the entry of `.`. */
function subpathMap(exportsField: unknown): Record<string, unknown> {
  return typeof exportsField === 'string' || Array.isArray(exportsField)
    || (exportsField && typeof exportsField === 'object' && !Object.keys(exportsField).some((key) => key.startsWith('.')))
    ? { '.': exportsField }
    : (exportsField as Record<string, unknown> | undefined) ?? {};
}

/** The `./`-relative file that the `exports` field of a package names for `subpath` (`.` or `./x`) when a file of format `importer` imports it: `null` when excluded, `undefined` when no entry applies. */
export function resolveExportsSubpath(exportsField: unknown, subpath: string, importer: 'import' | 'require' = 'import'): string | null | undefined {
  return resolveSubpath(subpathMap(exportsField), subpath, importer === 'require' ? REQUIRE_CONDITIONS : IMPORT_CONDITIONS);
}

/** Every string target in one exports entry, whatever condition holds it, in object order. */
function targetStrings(entry: unknown): string[] {
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry.flatMap(targetStrings);
  if (entry && typeof entry === 'object') return Object.values(entry).flatMap(targetStrings);
  return [];
}

/** The file an exports target names for `file`: itself, or the runtime file beside its declaration or source. */
function exportCandidates(relativeFile: string): readonly string[] {
  const runtime = relativeFile
    .replace(/\.d\.(m|c)?ts$/, (_match, kind: string | undefined) => `.${kind ?? ''}js`)
    .replace(/\.(m|c)?ts$/, (_match, kind: string | undefined) => `.${kind ?? ''}js`);
  return runtime === relativeFile ? [relativeFile] : [relativeFile, runtime];
}

/**
 * The subpath through which Node resolves to `relativeFile`. Each exports entry proposes a subpath for the file;
 * the proposal stands only if resolving that subpath forward, with Node's precedence, `null` and condition rules,
 * lands on the file again.
 */
function subpathFor(exportsField: unknown, relativeFile: string): string | undefined {
  const map = subpathMap(exportsField);
  const candidates = exportCandidates(relativeFile);
  for (const [key, entry] of Object.entries(map)) {
    for (const target of targetStrings(entry)) {
      if (!target.startsWith('./')) continue;
      const normalized = target.slice(2);
      for (const candidate of candidates) {
        let subpath: string | undefined;
        if (!normalized.includes('*')) {
          if (normalized === candidate && !key.includes('*')) subpath = key;
        } else if (key.indexOf('*') !== -1 && key.indexOf('*') === key.lastIndexOf('*')) {
          const prefix = normalized.slice(0, normalized.indexOf('*'));
          const suffix = normalized.slice(normalized.lastIndexOf('*') + 1);
          if (candidate.startsWith(prefix) && candidate.endsWith(suffix) && candidate.length >= prefix.length + suffix.length) {
            subpath = key.replace('*', candidate.slice(prefix.length, candidate.length - suffix.length));
          }
        }
        if (subpath === undefined) continue;
        const resolved = resolveSubpath(map, subpath);
        if (resolved && candidates.includes(resolved.slice(2))) return subpath;
      }
    }
  }
  return undefined;
}

/** Whether Node, resolving `name` from `consumerRoot`, finds the package at `packageRoot`: the nearest `node_modules/<name>` decides. */
function installedAt(consumerRoot: string, name: string, packageRoot: string): boolean {
  for (let dir = consumerRoot; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return canonicalPath(candidate) === canonicalPath(packageRoot);
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * How code in `fromFile` imports `file`: relatively when the file's package is the consumer's own, or by the owning
 * package's name plus the `exports` subpath that reaches `file`. The owner is the nearest package.json with a name. It
 * is the consumer's own package when it is the package of `fromFile`, or when it holds the consumer's root: a named
 * monorepo root above an app owns the folders beside the app, and an app imports them as it imports its own files.
 * `consumerRoot` is the root of the app or job whose generated code imports `file`.
 */
export function packageSpecifier(file: string, fromFile: string, consumerRoot: string): PackageSpecifierResult {
  const owner = nearestManifest(file);
  const consumer = nearestManifest(fromFile);
  if (!owner || owner.root === consumer?.root || !isOutside(canonicalPath(owner.root), canonicalPath(consumerRoot))) return { kind: 'same-package' };
  const relativeFile = path.relative(owner.root, file).replace(/\\/g, '/');
  if (owner.exports === undefined || owner.exports === null) {
    // Without an `exports` field Node serves every file by its path, so the runtime file's path is the subpath. That
    // holds only where the package name resolves to this folder; a named folder that nothing installs has no import path.
    return installedAt(consumerRoot, owner.name, owner.root)
      ? { kind: 'package', specifier: `${owner.name}/${exportCandidates(relativeFile).at(-1)}` }
      : { kind: 'unexported', packageName: owner.name, packageRoot: owner.root };
  }
  const subpath = subpathFor(owner.exports, relativeFile);
  if (subpath === undefined) return { kind: 'unexported', packageName: owner.name, packageRoot: owner.root };
  return { kind: 'package', specifier: subpath === '.' ? owner.name : `${owner.name}/${subpath.replace(/^\.\//, '')}` };
}
