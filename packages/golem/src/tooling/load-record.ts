import { readFileSync } from 'node:fs';
import { registerHooks, type ModuleHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hasErrorCode } from './generator-core.js';
import { digest } from './outputs.js';

/**
 * The digest of each file this process loaded while a recording was on, as the file on disk was when it loaded (not the text a loader transformed it to, so it is the digest
 * that a later run reads from disk). A module that is loaded again fires no second load, so the
 * map is process-wide: a later run in the same process (watch) still finds a file that an earlier run loaded. A file loaded again by a changed URL gets its new digest.
 */
const loaded = new Map<string, string>();
/** The files each file imported, as the resolves of the recordings saw it, by absolute path. Process-wide like `loaded`. */
const imports = new Map<string, Set<string>>();
let recordings = 0;
let hooks: ModuleHooks | undefined;

/** The digest of the file on disk, or undefined when the loaded URL has no file (a missing path or a directory). */
function diskDigest(filename: string): string | undefined {
  try {
    return digest(readFileSync(filename, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EISDIR')) return undefined;
    throw error;
  }
}

/**
 * Records the files the process loads and which file imported each, until the returned value is disposed, by a `load` and a `resolve` hook (`module.registerHooks`,
 * Node 22.15 and later) on the main thread that pass every load and resolve on unchanged. Runs overlap: the hook stays until the last recording ends. Only the pipeline records. It never runs in a plugin, a
 * rewrite host or a loader, because app code must not carry a hook of golem.
 */
export function recordLoadedFiles(): Disposable {
  recordings += 1;
  hooks ??= registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (context.parentURL?.startsWith('file:') && result.url.startsWith('file:')) {
        const parent = fileURLToPath(context.parentURL);
        imports.set(parent, (imports.get(parent) ?? new Set<string>()).add(fileURLToPath(result.url)));
      }
      return result;
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.startsWith('file:')) {
        const filename = fileURLToPath(url);
        const loadDigest = diskDigest(filename);
        if (loadDigest !== undefined) loaded.set(filename, loadDigest);
      }
      return result;
    },
  });
  return {
    [Symbol.dispose]() {
      recordings -= 1;
      if (recordings > 0) return;
      hooks?.deregister();
      hooks = undefined;
    },
  };
}

/** The digest at load of each file this process has loaded, by absolute path. */
export function loadedFileDigests(): ReadonlyMap<string, string> {
  return loaded;
}

/** The files that `entries` import, directly or not, as the recordings saw it; the entries themselves are in it. A file for which `skip` is true is neither returned nor followed. */
export function loadedClosure(entries: readonly string[], skip: (filename: string) => boolean): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = entries.filter(entry => !skip(entry));
  for (let filename = pending.pop(); filename !== undefined; filename = pending.pop()) {
    if (reached.has(filename)) continue;
    reached.add(filename);
    pending.push(...[...imports.get(filename) ?? []].filter(imported => !skip(imported)));
  }
  return reached;
}
