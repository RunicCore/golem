import { existsSync } from 'node:fs';
import path from 'node:path';

import { resolveConfig } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import type { GolemConfig } from './config.js';
import { GolemDiagnosticSeverity } from './generator-api.js';
import { applyRewrites } from './rewrite.js';
import { requestTypeScriptRoot } from './typescript-selection.js';
import type { RewriteScanner } from './rewrite-scan.js';
import type { SourceMapV3 } from './source-map.js';
import type * as ts from './typescript-ns.js';

/**
 * What every host shares: the Node loader and the Vite and esbuild plugins. A host opens a `RewriteProject` and asks it
 * per file. Only `openRewriteProject` loads TypeScript, and it does so lazily.
 */

/** Paths a host's bundler can strip types from; `.tsx` is a bundler's to handle, not Node's. */
export const BUNDLER_TYPESCRIPT_FILE = /\.(?:ts|mts|cts|tsx)$/;
export const NODE_MODULES = /[\\/]node_modules[\\/]/;

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
  /** The file and 1-based line of the first scan error, for a host that reports locations itself. */
  readonly location: { readonly file: string; readonly line?: number } | undefined;

  constructor(message: string, location?: { readonly file: string; readonly line?: number }) {
    super(message);
    this.name = 'GolemHostError';
    this.location = location;
  }
}

export interface GolemHostOptions {
  /** The golem.yaml. Default: `GOLEM_CONFIG`, else `./golem.yaml` from the host's working directory. */
  readonly config?: string;
}

export interface RewriteProject {
  /** Directory of the yaml's tsconfig. */
  readonly root: string;
  /** The codec key file the yaml's models job writes, whether or not it exists yet: what a host watches after a failed rewrite so that `golem generate` brings it back. */
  readonly expectedGenerated: readonly string[];
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
class ScanningProject {
  readonly root: string;
  readonly expectedGenerated: readonly string[];
  private readonly session: ts.ProgramSession;
  private program: ts.Program | undefined;
  private scanner: RewriteScanner | undefined;
  private stale = false;
  /** Text the host holds for files that differ from the disk, by canonical file. */
  private readonly overlays = new Map<string, string>();
  /** Files that the tsconfig's own file list misses, such as `.mts`: the program gets them as roots. */
  private readonly extras = new Set<string>();

  constructor(private readonly config: GolemConfig, private readonly nest: boolean, private readonly compiler: Compiler) {
    this.root = path.dirname(config.tsconfig);
    this.expectedGenerated = config.jobs.some((job) => job.kind === 'models') ? [codecKeysPath(config.directory)] : [];
    this.session = new compiler.ts.ProgramSession({ cwd: this.root });
  }

  private open(): void {
    const parsed = this.session.parseConfigFile(this.config.tsconfig);
    const { canonicalFilename } = this.compiler;
    const sources = [...new Set([...parsed.fileNames.map(canonicalFilename), ...this.extras])];
    const program = this.session.openProgram({ root: this.root, sources, configFile: this.config.tsconfig, overlays: new Map(this.overlays) });
    this.program?.close();
    this.program = program;
    this.scanner = new this.compiler.RewriteScanner({ root: this.root, program, codecKeysFile: codecKeysPath(this.config.directory), checker: program.getTypeChecker(), nest: this.nest });
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
      const line = errors.find((diagnostic) => diagnostic.line !== undefined)?.line;
      throw new GolemHostError([
        `golem cannot rewrite ${path.relative(this.root, file).split(path.sep).join('/')}:`,
        ...errors.map((diagnostic) => `  ${diagnostic.file ?? ''}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`} ${diagnostic.code}: ${diagnostic.message}`),
        'If a model changed, run golem generate.',
      ].join('\n'), { file, ...(line === undefined ? {} : { line }) });
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

  dispose(): void {
    this.program?.close();
    this.program = undefined;
    this.scanner = undefined;
    this.session[Symbol.dispose]();
  }
}

interface SharedProject {
  readonly project: Promise<ScanningProject>;
  /** The project once opened: a handle exists only then, so the last close disposes it at once. */
  opened?: ScanningProject;
  holders: number;
}

const projects = new Map<string, SharedProject>();

/** Drops one holder; the last one disposes the session, and a later open starts a new one. */
function release(key: string, shared: SharedProject): void {
  shared.holders -= 1;
  if (shared.holders > 0) return;
  if (projects.get(key) === shared) projects.delete(key);
  shared.opened?.dispose();
}

/**
 * The rewrite project of one golem.yaml, shared by every host of the process: each open gets a handle of its own, and
 * the session lives until the last handle closes. It loads TypeScript, the checker and the scanner only here, so a
 * missing TypeScript fails with its install hint when a host first needs a rewrite.
 */
export async function openRewriteProject(options: GolemHostOptions & { cwd: string }): Promise<RewriteProject> {
  const requested = path.resolve(options.cwd, options.config ?? process.env.GOLEM_CONFIG ?? 'golem.yaml');
  if (!existsSync(requested)) throw new GolemHostError(options.config === undefined && process.env.GOLEM_CONFIG === undefined ? NO_GOLEM_YAML : `${NO_GOLEM_YAML} (${requested} does not exist)`);
  const config = resolveConfig(requested);
  const key = config.configFile;
  let shared = projects.get(key);
  if (shared === undefined) {
    shared = {
      holders: 0,
      project: (async (): Promise<ScanningProject> => {
        if (!existsSync(config.tsconfig)) throw new GolemHostError(`golem cannot find ${config.tsconfig}, the tsconfig ${config.configFile} names; create it or name another with tsconfig:`);
        // The compiler seam loads once per process, so the project's TypeScript is requested before the seam is imported.
        requestTypeScriptRoot(path.dirname(config.tsconfig));
        const [seam, scan, analysis] = await Promise.all([import('./typescript-ns.js'), import('./rewrite-scan.js'), import('./type-analysis/project.js')]);
        return new ScanningProject(config, config.jobs.some((job) => job.kind === 'controllers'),
          { ts: seam, RewriteScanner: scan.RewriteScanner, canonicalFilename: analysis.canonicalFilename });
      })(),
    };
    projects.set(key, shared);
  }
  const holding = shared;
  holding.holders += 1;
  let project: ScanningProject;
  try {
    project = await holding.project;
    holding.opened = project;
  } catch (error) {
    // A failed open is not kept: the next open tries again.
    if (projects.get(key) === holding) projects.delete(key);
    throw error;
  }
  let closed = false;
  return {
    root: project.root,
    expectedGenerated: project.expectedGenerated,
    rewrite: (filename, text) => project.rewrite(filename, text),
    changed: (filenames) => { project.changed(filenames); },
    close() {
      if (closed) return;
      closed = true;
      release(key, holding);
    },
  };
}
