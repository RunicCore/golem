import { existsSync } from 'node:fs';
import path from 'node:path';

import { modelsRootOf, resolveConfig } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import type { GolemConfig } from './config.js';
import { displayPath, GolemDiagnosticSeverity } from './generator-api.js';
import { applyRewrites } from './rewrite.js';
import { requestTypeScriptRoot } from './typescript-selection.js';
import type { RewriteScanner } from './rewrite-scan.js';
import { composeSourceMaps, decodeMappings } from './source-map.js';
import type { SourceMapV3 } from './source-map.js';
import type * as ts from './typescript-ns.js';

/**
 * What every host shares: the Node loader and the Vite and esbuild plugins. A host opens a `RewriteProject` and asks it
 * per file. Only `openRewriteProject` loads TypeScript, and it does so lazily.
 */

/** The TypeScript files every host takes, `.tsx` included. */
export const TYPESCRIPT_FILE = /\.(?:ts|mts|cts|tsx)$/;

/** A file that Node cannot load without a compile, whatever it holds. */
export const TSX_FILE = /\.tsx$/;

/**
 * `code` with `map` as an inline source map. The map's source is the module's own file name: a host that reads an
 * inline map resolves `sources` against the module's own location.
 */
export function withInlineSourceMap(code: string, map: SourceMapV3, file: string): string {
  const json = JSON.stringify({ ...map, sources: [path.basename(file)] });
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}\n`;
}

const SOURCE_MAP_COMMENT = '//# sourceMappingURL=';

/** Text that can hold a construct Node cannot strip: a decorator, an enum, a namespace, or a parameter property's modifier. */
const COMPILE_HINT = /@|\b(?:enum|namespace|module|private|protected|public|readonly|override)\b/;

/** Whether a namespace or module declaration holds a value, so that it runs code. A dotted name nests one declaration in the next. */
function isInstantiated(compiler: typeof ts, node: ts.ModuleDeclaration): boolean {
  const { body } = node;
  if (body === undefined) return false;
  if (compiler.isModuleDeclaration(body)) return isInstantiated(compiler, body);
  return compiler.isModuleBlock(body) && body.statements.some((statement) =>
    !(compiler.isInterfaceDeclaration(statement) || compiler.isTypeAliasDeclaration(statement) || compiler.isModuleDeclaration(statement) && !isInstantiated(compiler, statement)));
}

/**
 * Whether `node` or a node below it is a construct that Node's type stripping rejects, because it needs code and not only the
 * removal of types: a decorator, an `enum`, a namespace with a value, or a constructor parameter with an accessibility,
 * `override` or `readonly` modifier. A `declare` form is only a type, with everything inside it.
 */
function needsCompile(compiler: typeof ts, node: ts.Node): boolean {
  const { SyntaxKind } = compiler;
  const modifiers = compiler.canHaveModifiers(node) ? compiler.getModifiers(node) ?? [] : [];
  // Nothing inside a `declare` form runs.
  if (modifiers.some((modifier) => modifier.kind === SyntaxKind.DeclareKeyword)) return false;
  const parameterProperty = [SyntaxKind.PublicKeyword, SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.OverrideKeyword, SyntaxKind.ReadonlyKeyword];
  const here = compiler.isDecorator(node)
    || compiler.isEnumDeclaration(node)
    || compiler.isModuleDeclaration(node) && isInstantiated(compiler, node)
    || compiler.isParameter(node) && modifiers.some((modifier) => parameterProperty.includes(modifier.kind));
  return here || compiler.forEachChild(node, (child) => needsCompile(compiler, child) || undefined) === true;
}

/** The 1-based line of `position` in `text`; with `map`, the line of the original file that the line maps to, or undefined when it maps to none. */
function lineAt(text: string, position: number, map: SourceMapV3 | undefined): number | undefined {
  const line = text.slice(0, position).split('\n').length - 1;
  if (map === undefined) return line + 1;
  const original = decodeMappings(map.mappings)[line]?.[0]?.[2];
  return original === undefined ? undefined : original + 1;
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
  /** The codec key file the yaml's models job writes, whether or not it exists yet: what a host watches after a failed rewrite so that `golem generate` brings it back. */
  readonly expectedGenerated: readonly string[];
  /**
   * Edits for one file as the host will compile it, `dependencies` as absolute paths; undefined when the file has no
   * rewrite. A file outside the tsconfig's directory is scanned and rewritten like any other. Throws a `GolemHostError` (file, line, "run golem generate") on scan diagnostics.
   */
  rewrite(filename: string, text: string): { code: string; map: SourceMapV3; dependencies: readonly string[] } | undefined;
  /** Tell the session these files changed on disk (new, edited or removed). */
  changed(filenames: readonly string[]): void;
  /**
   * The JavaScript of a file that Node's own type stripping cannot load: a `.tsx` file, or a file with a decorator, an `enum`, a
   * namespace with a value or a parameter property. It is an ES module that follows the tsconfig's `jsx`, decorator and `target`
   * options, with a source map back to `text`; undefined for any other file. `rewritten` is the result of `rewrite` for the same
   * `text`, which the module then compiles in place of `text`. A `.tsx` file with no `jsx` option throws a `GolemHostError`.
   */
  transpile(filename: string, text: string, rewritten: { code: string; map: SourceMapV3 } | undefined): { code: string; map: SourceMapV3 } | undefined;
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
  readonly configFile: string;
  readonly expectedGenerated: readonly string[];
  private readonly session: ts.ProgramSession;
  private program: ts.Program | undefined;
  /** The tsconfig's compiler options as the latest program was opened with them. */
  private options: ts.CompilerOptions = {};
  private scanner: RewriteScanner | undefined;
  private stale = false;
  /** Text the host holds for files that differ from the disk, by canonical file. */
  private readonly overlays = new Map<string, string>();
  /** Files that the tsconfig's own file list misses, such as `.mts`: the program gets them as roots. */
  private readonly extras = new Set<string>();

  constructor(private readonly config: GolemConfig, private readonly nest: boolean, private readonly compiler: Compiler) {
    this.root = path.dirname(config.tsconfig);
    this.configFile = config.configFile;
    this.expectedGenerated = config.jobs.some((job) => job.kind === 'models') ? [codecKeysPath(config.directory)] : [];
    this.session = new compiler.ts.ProgramSession({ cwd: this.root });
  }

  private open(): void {
    const parsed = this.session.parseConfigFile(this.config.tsconfig);
    this.options = parsed.options;
    const { canonicalFilename } = this.compiler;
    const sources = [...new Set([...parsed.fileNames.map(canonicalFilename), ...this.extras])];
    const program = this.session.openProgram({ root: this.root, sources, configFile: this.config.tsconfig, overlays: new Map(this.overlays) });
    this.program?.close();
    this.program = program;
    const models = this.config.jobs.find((job) => job.kind === 'models');
    this.scanner = new this.compiler.RewriteScanner({ root: this.root, directory: this.config.directory, modelsRoot: modelsRootOf(this.config), suffixes: models?.options.suffixes, output: models?.options.output, program, codecKeysFile: codecKeysPath(this.config.directory), checker: program.getTypeChecker(), nest: this.nest, nonModelInputs: this.config.nonModelInputs });
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
        `golem cannot rewrite ${displayPath(file)}:`,
        ...errors.map((diagnostic) => `  ${diagnostic.file === undefined ? '' : displayPath(path.resolve(this.root, diagnostic.file))}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`} ${diagnostic.code}: ${diagnostic.message}`),
        'If a model changed, run golem generate.',
      ].join('\n'), { file, ...(line === undefined ? {} : { line }) });
    }
    if (scanned.edits.length === 0) return undefined;
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    const applied = applyRewrites(text, scanned, file);
    return { code: applied.code, map: { ...applied.map, sources: [relative] }, dependencies: scanned.dependencies.map((dependency) => path.join(this.root, dependency)) };
  }

  transpile(filename: string, text: string, rewritten: { code: string; map: SourceMapV3 } | undefined): { code: string; map: SourceMapV3 } | undefined {
    const file = this.compiler.canonicalFilename(filename);
    const held = this.holds(file, withoutByteOrderMark(text)).getSourceFile(file);
    const tsx = TSX_FILE.test(file);
    // The walk is for the files whose text can hold such a construct.
    if (!tsx && !(COMPILE_HINT.test(text) && held !== undefined && needsCompile(this.compiler.ts, held))) return undefined;
    const { ts } = this.compiler;
    // Node cannot run JSX, so a file that no `jsx` option turns into calls would fail later with a syntax error.
    const { jsx } = this.options;
    if (tsx && (!jsx || jsx === ts.JsxEmit.Preserve || jsx === ts.JsxEmit.ReactNative)) throw new GolemHostError(`golem cannot compile ${displayPath(file)}: set compilerOptions.jsx in ${displayPath(this.config.tsconfig)} to react, react-jsx or react-jsxdev; preserve and react-native leave JSX in the output`, { file });
    // Node runs ES modules only, and a module resolution that matches another `module` is of no use to a single file.
    const options = { ...this.options, module: ts.ModuleKind.ESNext, moduleResolution: undefined, sourceMap: true, inlineSourceMap: false, inlineSources: false };
    const compiled = rewritten?.code ?? text;
    const { outputText, sourceMapText, diagnostics } = this.session.transpileModule(file, compiled, options);
    if (diagnostics.length > 0) {
      const places = diagnostics.map((diagnostic) => ({ diagnostic, line: diagnostic.pos === undefined ? undefined : lineAt(compiled, diagnostic.pos, rewritten?.map) }));
      const line = places.find((place) => place.line !== undefined)?.line;
      throw new GolemHostError([
        `golem cannot compile ${displayPath(file)}:`,
        ...places.map((place) => `  ${displayPath(file)}${place.line === undefined ? '' : `:${place.line}`} TS${place.diagnostic.code}: ${place.diagnostic.text}`),
      ].join('\n'), { file, ...(line === undefined ? {} : { line }) });
    }
    // The compiler ends its output with a comment that names a map file; the host carries the map inline.
    const comment = outputText.lastIndexOf(SOURCE_MAP_COMMENT);
    const emitted = JSON.parse(sourceMapText) as SourceMapV3;
    return { code: comment < 0 ? outputText : outputText.slice(0, comment), map: rewritten === undefined ? emitted : composeSourceMaps(emitted, rewritten.map) };
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
  // An empty config option or GOLEM_CONFIG is no setting: it would resolve to the working directory itself.
  const named = options.config || process.env.GOLEM_CONFIG || undefined;
  const requested = path.resolve(options.cwd, named ?? 'golem.yaml');
  if (!existsSync(requested)) throw new GolemHostError(named === undefined ? NO_GOLEM_YAML : `${NO_GOLEM_YAML} (${displayPath(requested)} does not exist)`);
  const config = resolveConfig(requested);
  const key = config.configFile;
  let shared = projects.get(key);
  if (shared === undefined) {
    shared = {
      holders: 0,
      project: (async (): Promise<ScanningProject> => {
        if (!existsSync(config.tsconfig)) throw new GolemHostError(`golem cannot find ${displayPath(config.tsconfig)}, the tsconfig ${displayPath(config.configFile)} names; create it or name another with tsconfig:`);
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
    expectedGenerated: project.expectedGenerated,
    rewrite: (filename, text) => project.rewrite(filename, text),
    transpile: (filename, text, rewritten) => project.transpile(filename, text, rewritten),
    changed: (filenames) => { project.changed(filenames); },
    close() {
      if (closed) return;
      closed = true;
      release(key, holding);
    },
  };
}
