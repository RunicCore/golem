import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveConfig } from './config.js';
import type { GolemConfig } from './config.js';
import { GolemDiagnosticSeverity } from './generator-api.js';
import { applyRewrites, GolemRewriteStaleError, readRewriteIndex, REWRITE_INDEX_PATH, sha256Hex, type RewriteIndex } from './rewrite.js';
import type { RewriteScanner } from './rewrite-scan.js';
import type { SourceMapV3 } from './source-map.js';
import type * as ts from './typescript-ns.js';
import { GOLEM_VERSION } from './version.js';

/**
 * What every host shares: the Node loader and the Vite and esbuild plugins. A host that scans for itself opens a
 * `RewriteProject` and asks it per file. A host that still reads `.golem/rewrites.json` finds the index of a
 * TypeScript file, reads it again only when the index file changes, and names the file by its project root-relative
 * POSIX path. Only `openRewriteProject` loads TypeScript, and it does so lazily.
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
 * Apply the index entry of `file` (a project root-relative POSIX path) to its text; `undefined` for a file the index
 * does not list. The map names `file`.
 */
export function applyIndexedRewrites(file: string, text: string, index: RewriteIndex): { readonly code: string; readonly map: SourceMapV3 } | undefined {
  const entry = index.files[file];
  if (!entry) return undefined;
  if (index.golem !== GOLEM_VERSION) {
    throw new GolemRewriteStaleError(file, `rewrite index was written by golem ${index.golem}; run golem generate`);
  }
  if (sha256Hex(text) !== entry.sha256) {
    throw new GolemRewriteStaleError(file, `${file} changed after golem generate; run golem generate, or keep golem watch running.`);
  }
  const applied = applyRewrites(text, entry, file);
  return { code: applied.code, map: { ...applied.map, sources: [file] } };
}

/**
 * `code` with `map` as an inline source map. The map's source is the module's own file name: a host that reads an
 * inline map resolves `sources` against the module's own location.
 */
export function withInlineSourceMap(code: string, map: SourceMapV3, file: string): string {
  const json = JSON.stringify({ ...map, sources: [path.basename(file)] });
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}\n`;
}

/** A host cannot rewrite a file; the message names the file and line and what to run. */
export class GolemHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GolemHostError';
  }
}

export interface GolemHostOptions {
  /** The golem.yaml. Default: `GOLEM_CONFIG`, else `./golem.yaml` from the host's working directory. */
  readonly config?: string;
}

export interface RewriteProject {
  /** Directory of the yaml's tsconfig. */
  readonly root: string;
  /**
   * Edits for one file as the host will compile it, `dependencies` as absolute paths; undefined when the file has no
   * rewrite. A file outside the tsconfig's directory is scanned like any other, and the scan fails one that needs a rewrite. Throws a `GolemHostError` (file, line, "run golem generate") on scan diagnostics.
   */
  rewrite(filename: string, text: string): { code: string; map: SourceMapV3; dependencies: readonly string[] } | undefined;
  /** Tell the session these files changed on disk (new, edited or removed). */
  changed(filenames: readonly string[]): void;
  close(): void;
}

const NO_GOLEM_YAML = 'golem needs a golem.yaml to rewrite parse<T>() calls; set config or GOLEM_CONFIG';

const BYTE_ORDER_MARK = '\uFEFF';

/** The compiler holds a file's text without a leading U+FEFF. */
function withoutByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

interface Compiler {
  readonly ts: typeof ts;
  readonly RewriteScanner: typeof RewriteScanner;
  readonly canonicalFilename: (filename: string) => string;
}

/** A project's compiler session and the program of its latest state; a changed or new file reopens the program. */
class ScanningProject implements RewriteProject {
  readonly root: string;
  private readonly session: ts.ProgramSession;
  private program: ts.Program | undefined;
  private scanner: RewriteScanner | undefined;
  private stale = false;
  /** Text the host holds for files that differ from the disk, by canonical file. */
  private readonly overlays = new Map<string, string>();
  /** Files that the tsconfig's own file list misses, such as `.mts`: the program gets them as roots. */
  private readonly extras = new Set<string>();

  constructor(private readonly config: GolemConfig, private readonly nest: boolean, private readonly compiler: Compiler, private readonly forget: () => void) {
    this.root = path.dirname(config.tsconfig);
    this.session = new compiler.ts.ProgramSession({ cwd: this.root });
  }

  private open(): void {
    const parsed = this.session.parseConfigFile(this.config.tsconfig);
    const { canonicalFilename } = this.compiler;
    const sources = [...new Set([...parsed.fileNames.map(canonicalFilename), ...this.extras])];
    const program = this.session.openProgram({ root: this.root, sources, configFile: this.config.tsconfig, overlays: new Map(this.overlays) });
    this.program?.close();
    this.program = program;
    this.scanner = new this.compiler.RewriteScanner({ root: this.root, program, checker: program.getTypeChecker(), nest: this.nest });
    this.stale = false;
  }

  /** The program holds `file` with the host's `text`, reopened when it does not. */
  private holds(file: string, text: string): ts.Program {
    if (this.program === undefined || this.stale) this.open();
    if (this.program!.getSourceFile(file) === undefined) {
      this.extras.add(file);
      this.open();
    }
    const held = this.program!.getSourceFile(file);
    if (held !== undefined && held.text !== text) {
      this.overlays.set(file, text);
      this.open();
    }
    return this.program!;
  }

  rewrite(filename: string, text: string): { code: string; map: SourceMapV3; dependencies: readonly string[] } | undefined {
    const file = this.compiler.canonicalFilename(filename);
    this.holds(file, withoutByteOrderMark(text));
    const scanned = this.scanner!.scanFile(file);
    if (scanned === undefined) return undefined;
    const errors = scanned.diagnostics.filter((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error);
    if (errors.length > 0) {
      throw new GolemHostError([
        `golem cannot rewrite ${path.relative(this.root, file).split(path.sep).join('/')}:`,
        ...errors.map((diagnostic) => `  ${diagnostic.file ?? ''}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`} ${diagnostic.code}: ${diagnostic.message}`),
        'If a model changed, run golem generate.',
      ].join('\n'));
    }
    if (scanned.edits.length === 0) return undefined;
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    const applied = applyRewrites(text, scanned, relative);
    return { code: applied.code, map: { ...applied.map, sources: [relative] }, dependencies: scanned.dependencies.map((dependency) => path.join(this.root, dependency)) };
  }

  changed(filenames: readonly string[]): void {
    const files = filenames.map(this.compiler.canonicalFilename);
    this.session.inputsChanged(files);
    for (const file of files) {
      this.overlays.delete(file);
      if (!existsSync(file)) this.extras.delete(file);
    }
    this.stale = true;
  }

  close(): void {
    this.forget();
    this.program?.close();
    this.program = undefined;
    this.scanner = undefined;
    this.session[Symbol.dispose]();
  }
}

const projects = new Map<string, Promise<RewriteProject>>();

/**
 * The rewrite project of one golem.yaml, shared by every host of the process. It loads TypeScript, the checker and the
 * scanner only here, so a missing TypeScript fails with its install hint when a host first needs a rewrite.
 */
export async function openRewriteProject(options: GolemHostOptions & { cwd: string }): Promise<RewriteProject> {
  const requested = path.resolve(options.cwd, options.config ?? process.env.GOLEM_CONFIG ?? 'golem.yaml');
  if (!existsSync(requested)) throw new GolemHostError(options.config === undefined && process.env.GOLEM_CONFIG === undefined ? NO_GOLEM_YAML : `${NO_GOLEM_YAML} (${requested} does not exist)`);
  const config = resolveConfig(requested);
  const existing = projects.get(config.configFile);
  if (existing) return existing;
  const opened = (async (): Promise<RewriteProject> => {
    if (!existsSync(config.tsconfig)) throw new GolemHostError(`golem cannot find ${config.tsconfig}, the tsconfig ${config.configFile} names; create it or name another with tsconfig:`);
    const [seam, scan, analysis] = await Promise.all([import('./typescript-ns.js'), import('./rewrite-scan.js'), import('./type-analysis/project.js')]);
    return new ScanningProject(config, config.jobs.some((job) => job.kind === 'controllers'),
      { ts: seam, RewriteScanner: scan.RewriteScanner, canonicalFilename: analysis.canonicalFilename },
      () => { projects.delete(config.configFile); });
  })();
  projects.set(config.configFile, opened);
  opened.catch(() => { projects.delete(config.configFile); });
  return opened;
}
