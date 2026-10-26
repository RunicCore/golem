import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { displayPath } from './generator-api.js';
import { openRewriteProject, withInlineSourceMap } from './rewrite-host.js';
import { isInstalledFile } from './type-analysis/path-identity.js';
import type { RewriteProject } from './rewrite-host.js';

/**
 * Node module `load` hook that rewrites TypeScript sources in memory, before Node strips their types. The hook scans
 * each file with the project's own TypeScript against the golem.yaml named by `GOLEM_CONFIG`, else `./golem.yaml` in
 * the working directory; with neither, a TypeScript file outside `node_modules` fails the load. The scan needs
 * TypeScript, so the first TypeScript file loads it. The loader thread owns its own compiler session, a second-tier
 * cost beside the one of the build: the program is opened once in the thread and reopened for a file it does not hold.
 * Node's type stripping cannot load a `.tsx` file, nor a file with a decorator, an `enum`, a namespace with a value or a
 * parameter property, so the hook compiles those with the project's TypeScript instead, following the `jsx`, decorator
 * and `target` options of its tsconfig; every other file stays with Node.
 * The `resolve` hook lets a relative `.js`, `.mjs` or `.cjs` import name the TypeScript source (`.ts` or `.tsx`) that has no built file yet,
 * the way the generated companions and validators name their siblings. ES modules only: a rewrite adds imports, which CommonJS cannot run.
 */

const TYPESCRIPT_FILE = /\.(?:ts|mts|cts|tsx)$/;
const TSX_FILE = /\.tsx$/;

/** The TypeScript extensions a built file's extension can come from, in the order the lookup tries them. */
const BUILT_TO_SOURCE: Readonly<Record<string, readonly string[]>> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const RELATIVE_BUILT_FILE = /^\.{1,2}\/.*(\.[cm]?js)$/;

interface ResolveContext { readonly parentURL?: string | undefined; readonly conditions?: readonly string[]; readonly importAttributes?: object }
interface ResolveResult { readonly url: string; readonly format?: string | null | undefined; readonly shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: ResolveContext) => ResolveResult | Promise<ResolveResult>;

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

export async function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): Promise<ResolveResult> {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const built = RELATIVE_BUILT_FILE.exec(specifier)?.[1];
    if (built === undefined || !(error instanceof Error) || Reflect.get(error, 'code') !== 'ERR_MODULE_NOT_FOUND') throw error;
    // The source has the built file's name with its TypeScript extension; when it does not exist either, the first error stands.
    const stem = specifier.slice(0, -built.length);
    for (const extension of BUILT_TO_SOURCE[built] ?? []) {
      try {
        return await nextResolve(`${stem}${extension}`, context);
      } catch {
        // The next extension may exist.
      }
    }
    throw error;
  }
}

export async function load(url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult> {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if (!TYPESCRIPT_FILE.test(file) || isInstalledFile(file)) return nextLoad(url, context);

  const rewriting = await projectOfThisProcess();
  // Node has no format for a `.tsx` file, so the hook reads it; its result is an ES module.
  const loaded: LoadResult = TSX_FILE.test(file) ? { format: 'module', source: await readFile(file) } : await nextLoad(url, context);
  const text = sourceText(loaded.source);
  const rewritten = rewriting.rewrite(file, text);
  const compiled = rewriting.transpile(file, text, rewritten);
  const output = compiled ?? rewritten;
  if (!output) return loaded;
  // The rewrite prepends ES imports and the compile emits an ES module; CommonJS runs neither.
  if (loaded.format === 'commonjs-typescript') {
    const relative = rewritten?.map.sources[0] ?? displayPath(file);
    throw new Error(`${rewritten ? 'golem rewrites need ES modules' : 'golem compiles to ES modules only'}; ${relative} loads as CommonJS. Use .mts, or .ts with "type": "module", or build with golem build`);
  }
  // Compiled output is JavaScript, so Node has no types left to strip.
  return { ...loaded, format: compiled ? 'module' : loaded.format, source: withInlineSourceMap(output.code, output.map, file) };
}
