import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyRewrites, readRewriteIndex, REWRITE_INDEX_PATH, type RewriteIndex } from './rewrite.js';

/**
 * Node module `load` hook that applies golem's rewrite index to TypeScript sources in memory, before Node strips
 * their types. The project root is the nearest ancestor directory that holds `.golem/rewrites.json`. A TypeScript
 * file outside `node_modules` with no index above it fails instead of loading unrewritten. This module imports
 * neither TypeScript nor the checker.
 */

const TYPESCRIPT_FILE = /\.(?:ts|mts|cts|tsx)$/;
const NODE_MODULES = /[\\/]node_modules[\\/]/;
const INLINE_MAP_PREFIX = '\n//# sourceMappingURL=data:application/json;base64,';

interface LoadContext { readonly format?: string | null | undefined }
interface LoadResult { readonly format: string; readonly source?: string | ArrayBuffer | NodeJS.TypedArray | null | undefined; readonly shortCircuit?: boolean }
type NextLoad = (url: string, context?: LoadContext) => LoadResult | Promise<LoadResult>;

const indexes = new Map<string, { readonly stamp: string; readonly index: RewriteIndex | undefined }>();

/** The index of `root`, read again only when the index file changes. */
function indexOf(root: string): RewriteIndex | undefined {
  const filename = path.join(root, REWRITE_INDEX_PATH);
  let stamp = 'absent';
  try {
    const stat = statSync(filename, { bigint: true });
    stamp = `${stat.mtimeNs}:${stat.size}`;
  } catch { /* readRewriteIndex reports a missing file as undefined */ }
  const cached = indexes.get(root);
  if (cached?.stamp === stamp) return cached.index;
  const index = readRewriteIndex(root);
  indexes.set(root, { stamp, index });
  return index;
}

function ancestorsOf(file: string): string[] {
  const directories: string[] = [];
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    directories.push(directory);
    if (path.dirname(directory) === directory) return directories;
  }
}

/** The directory that would hold the index: the nearest one with a tsconfig.json, else the file's own directory. */
function expectedRoot(file: string): string {
  const directories = ancestorsOf(file);
  return directories.find((directory) => existsSync(path.join(directory, 'tsconfig.json'))) ?? directories[0]!;
}

function sourceText(source: LoadResult['source']): string {
  if (typeof source === 'string') return source;
  if (source === undefined || source === null) throw new Error('golem loader got no source text');
  return Buffer.from(source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)).toString('utf8');
}

export async function load(url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult> {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if (!TYPESCRIPT_FILE.test(file) || NODE_MODULES.test(file)) return nextLoad(url, context);

  const root = ancestorsOf(file).find((directory) => existsSync(path.join(directory, REWRITE_INDEX_PATH)));
  const index = root === undefined ? undefined : indexOf(root);
  if (root === undefined || index === undefined) {
    throw new Error(`no golem rewrite index at ${path.join(root ?? expectedRoot(file), REWRITE_INDEX_PATH)}; run golem generate`);
  }

  const loaded = await nextLoad(url, context);
  const applied = applyRewrites(path.relative(root, file).split(path.sep).join('/'), sourceText(loaded.source), index);
  if (!applied) return loaded;
  // The map's source is the module's own file name: an inline map resolves `sources` against the module's URL.
  const map = JSON.stringify({ ...applied.map, sources: [path.basename(file)] });
  return { ...loaded, source: `${applied.code}${INLINE_MAP_PREFIX}${Buffer.from(map, 'utf8').toString('base64')}\n` };
}
