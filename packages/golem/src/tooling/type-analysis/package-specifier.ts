import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, displayPath, isInsideDirectory } from '../generator-core.js';

type PackageSpecifierResult =
  | { readonly kind: 'same-package' }
  | { readonly kind: 'package'; readonly specifier: string }
  | { readonly kind: 'unexported'; readonly packageName: string; readonly packageRoot: string };

export interface PackageManifest { readonly root: string; readonly name: string; readonly exports?: unknown }

/** Parsed package.json files, re-read when the file changes (watch mode keeps this process alive). */
const manifests = new Map<string, { readonly mtimeMs: number; readonly name?: string; readonly exports?: unknown }>();

/** The JSON object in the text of the package.json `filename`. Text that is not a JSON object throws an error that names the file and keeps the parse error as its cause. */
function parseManifest(filename: string, text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the JSON is not an object');
    return parsed as Record<string, unknown>;
  }
  catch (error) { throw new Error(`Cannot read ${displayPath(filename)} to resolve a package import: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export function readManifest(filename: string): { readonly name?: string; readonly exports?: unknown } | undefined {
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(filename).mtimeMs; } catch { return undefined; }
  const cached = manifests.get(filename);
  if (cached?.mtimeMs === mtimeMs) return cached;
  const json = parseManifest(filename, fs.readFileSync(filename, 'utf8'));
  const manifest = { mtimeMs, name: json.name as string | undefined, exports: json.exports };
  manifests.set(filename, manifest);
  return manifest;
}

/** The package name at the start of a bare specifier: `pkg` or `@scope/pkg`. */
export function packageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
}

/**
 * Throws when a package.json that a lookup of the package import `specifier` (a package name or a `#` import) from `importer`
 * reads is not a JSON object: the nearest one above `importer`, which scopes `imports` and self references, and for a package
 * name the nearest `node_modules/<name>/package.json`. Both TypeScript lanes call it, because the compiler reads such a
 * file as `{}` and does not name it.
 */
export function assertPackageManifestsParse(specifier: string, importer: string): void {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) return;
  const name = specifier.startsWith('#') ? undefined : packageName(specifier);
  const nearest = (relative: (directory: string) => string): void => {
    for (let directory = path.dirname(importer); ; directory = path.dirname(directory)) {
      if (readManifest(relative(directory)) !== undefined || path.dirname(directory) === directory) return;
    }
  };
  nearest((directory) => path.join(directory, 'package.json'));
  if (name !== undefined) nearest((directory) => path.join(directory, 'node_modules', name, 'package.json'));
}

/**
 * The package that owns `file`: the nearest package.json with a name. A nameless one (such as `{"type":"module"}`) only scopes module format.
 * `owners` remembers the answer for each directory the walk passes, so files of one directory read the file system once. The caller owns its lifetime:
 * keep it only as long as the package.json files cannot change, such as one type checker.
 */
export function nearestManifest(file: string, owners?: Map<string, PackageManifest | undefined>): PackageManifest | undefined {
  const walked: string[] = [];
  let found: PackageManifest | undefined;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (owners?.has(dir)) { found = owners.get(dir); break; }
    walked.push(dir);
    const manifest = readManifest(path.join(dir, 'package.json'));
    if (manifest?.name) { found = { root: dir, name: manifest.name, exports: manifest.exports }; break; }
    if (path.dirname(dir) === dir) break;
  }
  if (owners) for (const dir of walked) owners.set(dir, found);
  return found;
}

/** The name of the package that owns `file`: the nearest package.json with a name. */
export function owningPackageName(file: string): string | undefined {
  return nearestManifest(file)?.name;
}

/** Conditions a generated TypeScript file matches under Node's ESM rules, besides `default`. */
const IMPORT_CONDITIONS: ReadonlySet<string> = new Set(['types', 'import', 'node', 'default']);

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
function resolveSubpath(map: Readonly<Record<string, unknown>>, subpath: string): string | null | undefined {
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) return resolveTarget(map[subpath], undefined, IMPORT_CONDITIONS);
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
  return best ? resolveTarget(map[best.key], best.capture, IMPORT_CONDITIONS) : undefined;
}

/** The exports field as a map of subpath keys: a string, an array or a condition object with no `.` key is the entry of `.`. */
function subpathMap(exportsField: unknown): Record<string, unknown> {
  return typeof exportsField === 'string' || Array.isArray(exportsField)
    || (exportsField && typeof exportsField === 'object' && !Object.keys(exportsField).some((key) => key.startsWith('.')))
    ? { '.': exportsField }
    : (exportsField as Record<string, unknown> | undefined) ?? {};
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
  if (!owner || owner.root === consumer?.root || isInsideDirectory(canonicalPath(owner.root), canonicalPath(consumerRoot))) return { kind: 'same-package' };
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
