import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { readRewriteIndex, REWRITE_INDEX_PATH, type RewriteIndex } from './rewrite.js';
import type { SourceMapV3 } from './source-map.js';

/**
 * What every host of the rewrite index shares: the Node loader and the Vite and esbuild plugins. A host finds the
 * index of a TypeScript file, reads it again only when the index file changes, and names the file by its project
 * root-relative POSIX path. This module imports neither TypeScript nor the checker.
 */

/** Paths a host's bundler can strip types from; `.tsx` is a bundler's to handle, not Node's. */
export const BUNDLER_TYPESCRIPT_FILE = /\.(?:ts|mts|cts|tsx)$/;
export interface GolemBundlerOptions {
  /**
   * The project root that holds `.golem/rewrites.json`. A relative path resolves against Vite's `root`, or against
   * esbuild's `absWorkingDir` (default: the current directory). Default: the nearest ancestor directory of each file
   * that holds one.
   */
  readonly root?: string;
}

export const NODE_MODULES = /[\\/]node_modules[\\/]/;

const indexes = new Map<string, { readonly stamp: string; readonly index: RewriteIndex | undefined }>();

/** The index of `root`, read again only when the index file changes; `undefined` when `root` has none. */
export function rewriteIndexOf(root: string): RewriteIndex | undefined {
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

export interface RewriteHostIndex {
  readonly root: string;
  readonly index: RewriteIndex;
  /** `file`'s path from `root`, with `/` separators: the key of `index.files`. */
  readonly relative: string;
}

/** The directory whose index owns `file`: `root` when given, else the nearest ancestor that holds an index, else where one is expected. */
export function rewriteIndexRoot(file: string, root?: string): string {
  return root ?? ancestorsOf(file).find((directory) => existsSync(path.join(directory, REWRITE_INDEX_PATH))) ?? expectedRoot(file);
}

/**
 * The index that owns `file`: the one in `root` when given, else the nearest ancestor directory that holds one.
 * Throws when there is none, so a host never passes a TypeScript file on unrewritten.
 */
export function findRewriteIndex(file: string, root?: string): RewriteHostIndex {
  const owner = rewriteIndexRoot(file, root);
  const index = rewriteIndexOf(owner);
  if (index === undefined) throw new Error(`no golem rewrite index at ${path.join(owner, REWRITE_INDEX_PATH)}; run golem generate`);
  return { root: owner, index, relative: path.relative(owner, file).split(path.sep).join('/') };
}

/**
 * `code` with `map` as an inline source map. The map's source is the module's own file name: a host that reads an
 * inline map resolves `sources` against the module's own location.
 */
export function withInlineSourceMap(code: string, map: SourceMapV3, file: string): string {
  const json = JSON.stringify({ ...map, sources: [path.basename(file)] });
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}\n`;
}
