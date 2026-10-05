import { fileURLToPath } from 'node:url';

import { NODE_MODULES, openRewriteProject, withInlineSourceMap } from './rewrite-host.js';
import type { RewriteProject } from './rewrite-host.js';

/**
 * Node module `load` hook that rewrites TypeScript sources in memory, before Node strips their types. The hook scans
 * each file with the project's own TypeScript against the golem.yaml named by `GOLEM_CONFIG`, else `./golem.yaml` in
 * the working directory; with neither, a TypeScript file outside `node_modules` fails the load. The scan needs
 * TypeScript, so the first TypeScript file loads it. The loader thread owns its own compiler session, a second-tier
 * cost beside the one of the build: the program is opened once in the thread and reopened for a file it does not hold.
 * ES modules only: a rewrite adds imports, which CommonJS cannot run. `.tsx` goes straight to Node, which cannot strip it.
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

let project: Promise<RewriteProject> | undefined;

function projectOfThisProcess(): Promise<RewriteProject> {
  project ??= openRewriteProject({ cwd: process.cwd() });
  return project;
}

export async function load(url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult> {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if (!TYPESCRIPT_FILE.test(file) || NODE_MODULES.test(file)) return nextLoad(url, context);

  const rewriting = await projectOfThisProcess();
  const loaded = await nextLoad(url, context);
  const rewritten = rewriting.rewrite(file, sourceText(loaded.source));
  if (!rewritten) return loaded;
  // The rewrite prepends ES imports, which CommonJS cannot run.
  if (loaded.format === 'commonjs-typescript') {
    const relative = rewritten.map.sources[0] ?? file;
    throw new Error(`golem rewrites need ES modules; ${relative} loads as CommonJS. Use .mts, or .ts with "type": "module", or build with golem build`);
  }
  return { ...loaded, source: withInlineSourceMap(rewritten.code, rewritten.map, file) };
}
