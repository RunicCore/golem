import { existsSync } from 'node:fs';
import path from 'node:path';

import { modelsRootOf, resolveConfig } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import type { GolemConfig } from './config.js';
import { displayPath, GolemDiagnosticSeverity } from './generator-core.js';
import { fileSignature } from './input-watcher.js';
import { loadInventory } from './outputs.js';
import { sourceComments } from './source-comments.js';
import type { SourceComment } from './source-comments.js';
import type { GolemDiagnostic } from './generator-core.js';
import { applyRewrites } from './rewrite.js';
import { assertNotSolutionTsconfig } from './typescript-config.js';
import { requestTypeScriptRoot } from './typescript-selection.js';
import type { FileScanResult, RewriteScanner } from './rewrite-scan.js';
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

/** Text that can hold a construct Node cannot strip: a decorator, an enum, a namespace, a parameter property's modifier, `import x = require()` or `export =`. */
const COMPILE_HINT = /@|=\s*require\b|\bexport\s*=|\b(?:enum|namespace|module|private|protected|public|readonly|override)\b/;

/** Whether a namespace or module declaration holds a value, so that it runs code. A dotted name nests one declaration in the next. */
function isInstantiated(compiler: typeof ts, node: ts.ModuleDeclaration): boolean {
  const { body } = node;
  if (body === undefined) return false;
  if (compiler.isModuleDeclaration(body)) return isInstantiated(compiler, body);
  return compiler.isModuleBlock(body) && body.statements.some((statement) =>
    !(compiler.isInterfaceDeclaration(statement) || compiler.isTypeAliasDeclaration(statement) || compiler.isModuleDeclaration(statement) && !isInstantiated(compiler, statement)));
}

/** What a walk of one file found: whether a construct needs the compile, and the first construct that only CommonJS holds. */
interface Forms {
  compiled: boolean;
  commonJsOnly?: ts.Node;
}

/**
 * Walks `node` and the nodes below it into `forms`. The walk stops at the first CommonJS-only construct, and returns true
 * then. Nothing inside a `declare` form runs, so the walk skips it.
 */
function findForms(compiler: typeof ts, node: ts.Node, forms: Forms): boolean {
  const modifiers = compiler.canHaveModifiers(node) ? compiler.getModifiers(node) ?? [] : [];
  if (modifiers.some((modifier) => modifier.kind === compiler.SyntaxKind.DeclareKeyword)) return false;
  if (isCommonJsOnlyForm(compiler, node)) {
    forms.commonJsOnly = node;
    return true;
  }
  if (isCompiledForm(compiler, node)) forms.compiled = true;
  return compiler.forEachChild(node, (child) => findForms(compiler, child, forms) || undefined) === true;
}

/**
 * A construct that Node's type stripping rejects, because it needs code and not only the removal of types: a decorator, an
 * `enum`, a namespace with a value, or a constructor parameter with an accessibility, `override` or `readonly` modifier.
 */
function isCompiledForm(compiler: typeof ts, node: ts.Node): boolean {
  const { SyntaxKind } = compiler;
  const parameterProperty = [SyntaxKind.PublicKeyword, SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.OverrideKeyword, SyntaxKind.ReadonlyKeyword];
  return compiler.isDecorator(node)
    || compiler.isEnumDeclaration(node)
    || compiler.isModuleDeclaration(node) && isInstantiated(compiler, node)
    || compiler.isParameter(node) && (compiler.getModifiers(node) ?? []).some((modifier) => parameterProperty.includes(modifier.kind));
}

/**
 * A construct that Node rejects and that only CommonJS holds: `import x = require('...')` and `export = x`. A type-only
 * `import type x = require()` is erased. In an ES module golem names it and does not compile it.
 */
function isCommonJsOnlyForm(compiler: typeof ts, node: ts.Node): boolean {
  return compiler.isImportEqualsDeclaration(node) && !node.isTypeOnly && node.moduleReference.kind === compiler.SyntaxKind.ExternalModuleReference
    || compiler.isExportAssignment(node) && node.isExportEquals;
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
  /**
   * The errors of the scan of one file as the host will compile it: what `rewrite` throws for, one entry each. Empty for a file with no error or no rewrite.
   * It is for a host with no watch, such as a lint run: it keeps the overlay of this file only, and reopens the program when `golem generate` wrote a new generation record.
   */
  diagnose(filename: string, text: string): readonly GolemDiagnostic[];
  /**
   * The comments of one file, from the compiler's scanner, for a host that parses the file itself. Empty when the file is no source of the program.
   */
  comments(filename: string, text: string): readonly SourceComment[];
  /** Tell the session these files changed on disk (new, edited or removed). */
  changed(filenames: readonly string[]): void;
  /**
   * The JavaScript of a file that Node's own type stripping cannot load: a `.tsx` file, or a file with a decorator, an `enum`, a
   * namespace with a value or a parameter property. It is an ES module that follows the tsconfig's `jsx`, decorator and `target`
   * options, with a source map back to `text`; undefined for any other file. `rewritten` is the result of `rewrite` for the same
   * `text`, which the module then compiles in place of `text`. A `.tsx` file with no `jsx` option throws a `GolemHostError`. So does an
   * ES module (`esModule`) with `import x = require()` or `export =`, which only CommonJS holds.
   */
  transpile(filename: string, text: string, rewritten: { code: string; map: SourceMapV3 } | undefined, esModule: boolean): { code: string; map: SourceMapV3 } | undefined;
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
  /** The signature of the generation record before the latest program was opened. */
  private recordSignature: string | undefined;
  /** The files the generation record listed before the latest program was opened; read only by a host that lints. */
  private recorded: readonly string[] = [];
  private readsRecord = false;
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

  /** The files the generation record lists, as absolute paths. */
  private recordedFiles(): string[] {
    return Object.keys(loadInventory(this.config).files).map((key) => path.resolve(this.config.directory, key));
  }

  private open(): void {
    // The record is read before the program: a `golem generate` that ends in between is seen as a move at the next read.
    const signature = fileSignature(this.config.inventoryFile);
    const recorded = this.readsRecord ? this.recordedFiles() : [];
    const parsed = this.session.parseConfigFile(this.config.tsconfig);
    assertNotSolutionTsconfig(this.config.tsconfig, parsed, 'yaml');
    this.options = parsed.options;
    const { canonicalFilename } = this.compiler;
    const sources = [...new Set([...parsed.fileNames.map(canonicalFilename), ...this.extras])];
    const program = this.session.openProgram({ root: this.root, sources, configFile: this.config.tsconfig, overlays: new Map(this.overlays) });
    this.program?.close();
    this.program = program;
    const models = this.config.jobs.find((job) => job.kind === 'models');
    this.scanner = new this.compiler.RewriteScanner({ root: this.root, directory: this.config.directory, modelsRoot: modelsRootOf(this.config), suffixes: models?.options.suffixes, output: models?.options.output, program, codecKeysFile: codecKeysPath(this.config.directory), checker: program.getTypeChecker(), nest: this.nest, nonModelInputs: this.config.nonModelInputs });
    this.stale = false;
    this.recordSignature = signature;
    this.recorded = recorded;
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

  /** The scan of a file with the host's `text`, and its errors; undefined when the file is no rewrite candidate. */
  private scan(filename: string, text: string): { readonly file: string; readonly scanned: FileScanResult; readonly errors: readonly GolemDiagnostic[] } | undefined {
    const file = this.compiler.canonicalFilename(filename);
    this.holds(file, withoutByteOrderMark(text));
    const scanned = this.scanner!.scanFile(file);
    return scanned && { file, scanned, errors: scanned.diagnostics.filter((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error) };
  }

  diagnose(filename: string, text: string): readonly GolemDiagnostic[] {
    this.readsRecord = true;
    this.syncToDisk(this.compiler.canonicalFilename(filename));
    return this.scan(filename, text)?.errors ?? [];
  }

  comments(filename: string, text: string): readonly SourceComment[] {
    this.readsRecord = true;
    const file = this.compiler.canonicalFilename(filename);
    const held = this.holds(file, withoutByteOrderMark(text)).getSourceFile(file);
    return held === undefined ? [] : sourceComments(this.compiler.ts, held);
  }

  /**
   * What a host with no watch does before it reads a file: only the file in hand keeps its overlay, so the text of a closed buffer
   * leaves the program, and a generation record that moved since the program opened means `golem generate` wrote files, which
   * the program reads again. One stat of the record, not one for each file of the program.
   */
  private syncToDisk(file: string): void {
    for (const other of [...this.overlays.keys()].filter((key) => key !== file)) {
      this.overlays.delete(other);
      this.stale = true;
    }
    if (this.program !== undefined && fileSignature(this.config.inventoryFile) !== this.recordSignature) {
      // The files of the old record too: one that `golem generate` removed is changed as well.
      this.changed([...this.recorded, ...this.recordedFiles(), ...this.expectedGenerated]);
    }
  }

  rewrite(filename: string, text: string): { code: string; map: SourceMapV3; dependencies: readonly string[] } | undefined {
    const found = this.scan(filename, text);
    if (found === undefined) return undefined;
    const { file, scanned, errors } = found;
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

  transpile(filename: string, text: string, rewritten: { code: string; map: SourceMapV3 } | undefined, esModule: boolean): { code: string; map: SourceMapV3 } | undefined {
    const file = this.compiler.canonicalFilename(filename);
    const held = this.holds(file, withoutByteOrderMark(text)).getSourceFile(file);
    const tsx = TSX_FILE.test(file);
    // The walk is for the files whose text can hold such a construct.
    const forms: Forms = { compiled: false };
    if (held !== undefined && COMPILE_HINT.test(text)) findForms(this.compiler.ts, held, forms);
    const { commonJsOnly } = forms;
    // A CommonJS file is refused by the loader after the compile, with the module format named.
    if (esModule && held !== undefined && commonJsOnly !== undefined) {
      const line = held.getLineAndCharacterOfPosition(commonJsOnly.getStart(held)).line + 1;
      const [form, instead] = this.compiler.ts.isExportAssignment(commonJsOnly)
        ? ['export =', 'export default <value>']
        : ['import <name> = require()', "import <name> from '<module>' or import * as <name> from '<module>'"];
      throw new GolemHostError(`golem cannot load ${displayPath(file)}:${line}: ${form} is CommonJS only, and golem compiles to ES modules only. Write ${instead}`, { file, line });
    }
    if (!tsx && !forms.compiled && commonJsOnly === undefined) return undefined;
    const { ts } = this.compiler;
    // Node cannot run JSX, so a file that no `jsx` option turns into calls would fail later with a syntax error.
    const { jsx } = this.options;
    if (tsx && (!jsx || jsx === ts.JsxEmit.Preserve || jsx === ts.JsxEmit.ReactNative)) throw new GolemHostError(`golem cannot compile ${displayPath(file)}: set compilerOptions.jsx in ${displayPath(this.config.tsconfig)} to react, react-jsx or react-jsxdev; preserve and react-native leave JSX in the output`, { file });
    // Node runs ES modules only, and a module resolution that matches another `module` is of no use to a single file.
    const kept = Object.entries(this.options).filter(([name]) => name !== 'moduleResolution');
    const options = { ...Object.fromEntries(kept), module: ts.ModuleKind.ESNext, sourceMap: true, inlineSourceMap: false, inlineSources: false };
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
    diagnose: (filename, text) => project.diagnose(filename, text),
    comments: (filename, text) => project.comments(filename, text),
    transpile: (filename, text, rewritten, esModule) => project.transpile(filename, text, rewritten, esModule),
    changed: (filenames) => { project.changed(filenames); },
    close() {
      if (closed) return;
      closed = true;
      release(key, holding);
    },
  };
}
