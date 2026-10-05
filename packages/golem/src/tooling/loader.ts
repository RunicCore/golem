import { fileURLToPath } from 'node:url';

import { applyIndexedRewrites, findRewriteIndex, NODE_MODULES, withInlineSourceMap } from './rewrite-host.js';

/**
 * Node module `load` hook that applies golem's rewrite index to TypeScript sources in memory, before Node strips
 * their types. The project root is the nearest ancestor directory that holds `.golem/rewrites.json`. A TypeScript
 * file outside `node_modules` with no index above it fails instead of loading unrewritten. `.tsx` goes straight to
 * Node, which cannot strip it. This module imports neither TypeScript nor the checker.
 */

const TYPESCRIPT_FILE = /\.(?:ts|mts|cts)$/;

interface LoadContext { readonly format?: string | null | undefined }
interface LoadResult { readonly format: string; readonly source?: string | ArrayBuffer | NodeJS.TypedArray | null | undefined; readonly shortCircuit?: boolean }
type NextLoad = (url: string, context?: LoadContext) => LoadResult | Promise<LoadResult>;

function sourceText(source: LoadResult['source']): string {
  if (typeof source === 'string') return source;
  if (source === undefined || source === null) throw new Error('golem loader got no source text');
  return Buffer.from(source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)).toString('utf8');
}

export async function load(url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult> {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if (!TYPESCRIPT_FILE.test(file) || NODE_MODULES.test(file)) return nextLoad(url, context);

  const { index, relative } = findRewriteIndex(file);
  const loaded = await nextLoad(url, context);
  // The rewrite prepends ES imports, which CommonJS cannot run.
  if (loaded.format === 'commonjs-typescript' && relative in index.files) {
    throw new Error(`golem rewrites need ES modules; ${relative} loads as CommonJS. Use .mts, or .ts with "type": "module", or build with golem build`);
  }
  const applied = applyIndexedRewrites(relative, sourceText(loaded.source), index);
  if (!applied) return loaded;
  return { ...loaded, source: withInlineSourceMap(applied.code, applied.map, file) };
}
