import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalFile, modelsRootOf, resolveConfig } from './config.js';
import type { GolemConfig } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import { displayPath, errorMessage, GolemDiagnosticSeverity, isInsideDirectory } from './generator-api.js';
import type { GolemDiagnostic } from './generator-api.js';
import { nodeSpecifierEdits } from './node-specifiers.js';
import { atomicWrite } from './outputs.js';
import { GeneratorSessionResources, runPipeline } from './pipeline.js';
import type { PipelineState } from './pipeline.js';
import { applyRewrites } from './rewrite.js';
import type { FileRewrite } from './rewrite.js';
import { emitsJavaScript, projectSources, RewriteScanner } from './rewrite-scan.js';
import { composeSourceMaps } from './source-map.js';
import type { SourceMapV3 } from './source-map.js';
import * as ts from './typescript-ns.js';
import { requestTypeScriptRoot } from './typescript-selection.js';
import { changedPaths, InputScan, InputWatcher, outsideFolder, OwnedOutputIndex, realInputFiles, RunBaseline } from './input-watcher.js';
import type { InputSnapshot } from './input-watcher.js';

interface BuildOptions {
  /**
   * Another build config of the same project: a tsconfig file, or a directory that holds `tsconfig.json`, as `tsc -p` takes it.
   * It lives in the directory of the golem.yaml's tsconfig. Without it the build is that tsconfig.
   */
  readonly project?: string;
  readonly watch: boolean;
  /** The golem.yaml the build starts from; `golem.yaml` in the working directory without it. */
  readonly config?: string;
  /** Stops a watching build; the returned promise resolves when the current build has finished. */
  readonly signal?: AbortSignal;
  /** Every argument golem build does not take itself: the check program and the emit program get them unchanged. */
  readonly tscArguments?: readonly string[];
  /** Called after the generate step of each build with the ids of the jobs that executed; a job its record showed to be current is not among them. */
  readonly onGenerated?: (ran: ReadonlySet<string>) => void;
  /**
   * Called once when each build has finished, after a watching build has recorded what it read: `exitCode` is the build's own, 1 for a build that threw.
   * The build prints nothing about its end; the caller says it. An exception from this function is not caught here: a build without `watch` rejects
   * with it, and a build of a watch, the first included, is reported through the watch's own error path while the watch goes on.
   */
  readonly onBuilt?: (run: { readonly label: string; readonly exitCode: number }) => void;
}

export const NO_GOLEM_YAML = 'golem build needs a golem.yaml; run it next to one or pass --config';

/** What a build needs from the project's configuration, read once per build from the compiler's own parse. */
interface Project {
  readonly root: string;
  readonly configFile: string;
  readonly files: readonly string[];
  readonly outDir: string;
  readonly declarationDir?: string;
  readonly rootDir?: string;
  /** The original configuration emits declarations, so the check writes them from the original sources and the build changes their import paths. */
  readonly declaration: boolean;
  /** `noEmit` and `emitDeclarationOnly` leave no JavaScript to emit: the build is the check alone. */
  readonly emitsJavaScript: boolean;
  readonly noEmit: boolean;
  readonly noEmitOnError: boolean;
}

function posix(filename: string): string {
  return filename.split(path.sep).join('/');
}

function stringOption(options: ts.CompilerOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

/** The golem.yaml a build starts from. Nothing above the working directory is searched. */
function readGolemConfig(requested: string | undefined, observe: (filename: string) => void): GolemConfig {
  const file = path.resolve(requested ?? 'golem.yaml');
  observe(file);
  if (!fs.existsSync(file)) throw new Error(requested === undefined ? NO_GOLEM_YAML : `golem build cannot find ${displayPath(file)}.`);
  return resolveConfig(file, observe);
}

/** The tsconfig to build: the golem.yaml's own, or the alternate `-p` names beside it. */
function resolveProject(project: string | undefined, config: GolemConfig): string {
  if (project === undefined) {
    if (!fs.existsSync(config.tsconfig)) throw new Error(`golem build cannot find ${displayPath(config.tsconfig)}, the tsconfig ${displayPath(config.configFile)} names.`);
    return config.tsconfig;
  }
  const requested = path.resolve(project);
  const stat = fs.statSync(requested, { throwIfNoEntry: false });
  if (!stat) throw new Error(`golem build cannot find ${displayPath(requested)}.`);
  const configFile = canonicalFile(stat.isDirectory() ? path.join(requested, 'tsconfig.json') : requested);
  if (!fs.existsSync(configFile)) throw new Error(`golem build cannot find ${displayPath(configFile)}.`);
  if (path.dirname(configFile) !== path.dirname(config.tsconfig)) {
    throw new Error(`golem build -p ${project} must name a config in the same directory as ${displayPath(config.tsconfig)}, the tsconfig ${displayPath(config.configFile)} names.`);
  }
  return configFile;
}

/**
 * Options that are features of the `tsc` command, not of a program: the command measures its own process, which golem build does not run.
 * `listFiles` is printed by the build from its program; the others are refused with the command that gives them.
 */
const TSC_COMMAND_OPTIONS = [
  { name: 'generateTrace', flag: '--generateTrace <dir>', set: (value: unknown) => typeof value === 'string' && value !== '' },
  { name: 'extendedDiagnostics', flag: '--extendedDiagnostics', set: (value: unknown) => value === true },
  { name: 'explainFiles', flag: '--explainFiles', set: (value: unknown) => value === true },
  { name: 'traceResolution', flag: '--traceResolution', set: (value: unknown) => value === true },
  { name: 'diagnostics', flag: '--diagnostics', set: (value: unknown) => value === true },
] as const;

/** Options that only the `tsc` command takes: they ask it to print or write something other than a build. */
const TSC_COMMANDS = ['showConfig', 'listFilesOnly', 'version', 'help', 'init'] as const;

/** Fail on a configuration the build cannot emit: the tsconfig's, with the forwarded arguments applied. It reads options alone, so it runs before anything is generated. */
function assertSupported(configFile: string, parsed: { readonly options: ts.CompilerOptions; readonly fileNames: readonly string[] }): void {
  const { options } = parsed;
  const unsupported = (what: string): Error => new Error(`golem build does not support ${what} (${displayPath(configFile)}).`);
  if (parsed.fileNames.length === 0) {
    throw new Error(`${displayPath(configFile)} includes no files. golem build builds one project and does not follow project references; run golem build -p <tsconfig> per project.`);
  }
  if (stringOption(options, 'outDir') === undefined) throw new Error(`golem build requires compilerOptions.outDir in ${displayPath(configFile)}: it emits the rewritten sources there.`);
  if (stringOption(options, 'outFile') !== undefined) throw unsupported('outFile');
  if (Array.isArray(options.rootDirs)) throw unsupported('rootDirs');
  if (options.inlineSourceMap === true) throw unsupported('inlineSourceMap');
  if (stringOption(options, 'sourceRoot') !== undefined) throw unsupported('sourceRoot');
  for (const name of TSC_COMMANDS) {
    if (options[name] === true) throw new Error(`golem build does not support --${name} (${displayPath(configFile)}): it is a command of tsc, not an option of a build. Run tsc --${name} instead.`);
  }
  // The tsconfig and the forwarded arguments are the same to the build: a setting in either is refused, never ignored.
  for (const option of TSC_COMMAND_OPTIONS) {
    if (option.set(options[option.name])) {
      throw new Error(`golem build does not support ${option.name} (${displayPath(configFile)}): it measures the tsc process. Run tsc -p ${displayPath(configFile)} --noEmit ${option.flag} to get it.`);
    }
  }
}

/** Read the build settings from a configuration `assertSupported` accepted. */
function readProject(configFile: string, parsed: { readonly options: ts.CompilerOptions; readonly fileNames: readonly string[] }): Project {
  const { options } = parsed;
  const root = path.dirname(configFile);
  const outDir = stringOption(options, 'outDir');
  if (outDir === undefined) throw new Error(`golem build requires compilerOptions.outDir in ${displayPath(configFile)}: it emits the rewritten sources there.`);
  const rootDir = stringOption(options, 'rootDir');
  const declarationDir = stringOption(options, 'declarationDir');
  const noEmit = options.noEmit === true;
  return {
    root,
    configFile,
    files: parsed.fileNames,
    outDir,
    ...(declarationDir === undefined ? {} : { declarationDir }),
    ...(rootDir === undefined ? {} : { rootDir }),
    declaration: options.declaration === true || options.composite === true,
    emitsJavaScript: emitsJavaScript(options),
    noEmit,
    noEmitOnError: options.noEmitOnError === true,
  };
}

function scanFailure(root: string, errors: readonly GolemDiagnostic[]): Error {
  const location = (diagnostic: GolemDiagnostic): string => (diagnostic.file === undefined ? '' : ` (${displayPath(path.resolve(root, diagnostic.file))}${diagnostic.line === undefined ? '' : `:${diagnostic.line}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`})`);
  return new Error([
    `golem rewrite scan reported ${errors.length} error diagnostic${errors.length === 1 ? '' : 's'}:`,
    ...errors.map((diagnostic) => `  ${diagnostic.code}${location(diagnostic)}: ${diagnostic.message}`),
  ].join('\n'));
}

/** The deepest directory that holds every one of `directories`. */
function commonDirectory(directories: readonly string[]): string {
  const [first, ...others] = directories.map((directory) => path.resolve(directory).split(path.sep));
  if (first === undefined) throw new Error('golem build has no directory to lay its output out from.');
  let length = first.length;
  for (const other of others) {
    let shared = 0;
    while (shared < length && shared < other.length && other[shared] === first[shared]) shared += 1;
    length = shared;
  }
  if (length === 0) throw new Error(`golem build cannot lay out sources that share no directory: ${directories.map(displayPath).join(', ')}.`);
  return path.resolve(`${first.slice(0, length).join(path.sep)}${path.sep}`);
}

/**
 * The directory the compiler writes outputs relative to: the common directory of the tsconfig's directory, the `rootDir` and every source.
 * With a `rootDir` the output layout starts at that directory instead.
 */
function sourceBase(project: Project, sources: readonly ts.SourceFile[]): string {
  return commonDirectory([project.root, ...sources.map((source) => path.dirname(source.fileName)), ...project.rootDir === undefined ? [] : [project.rootDir]]);
}

/**
 * The scanner's rewrites with the edits that give each import specifier of a source the text Node loads as ESM. An import
 * the scanner adds for a type-only import copies that import's path text, so it takes the new text of the same specifier.
 */
function withNodeSpecifiers(root: string, sources: readonly ts.SourceFile[], checker: ts.TypeChecker, compilerOptions: ts.CompilerOptions, scanned: ReadonlyMap<string, FileRewrite>): ReadonlyMap<string, FileRewrite> {
  const options = { compilerOptions, projectSources: new Set(sources.map((source) => source.fileName)) };
  const rewrites = new Map(scanned);
  for (const source of sources.filter((candidate) => !candidate.isDeclarationFile)) {
    const { edits, specifiers } = nodeSpecifierEdits(source, checker, options);
    if (edits.length === 0) continue;
    const key = posix(path.relative(root, source.fileName));
    const scan = scanned.get(key);
    rewrites.set(key, {
      edits: [...scan?.edits ?? [], ...edits].sort((left, right) => left.start - right.start || left.end - right.end),
      imports: (scan?.imports ?? []).map((added) => ({ ...added, from: specifiers.get(added.from) ?? added.from })),
      importsAt: scan?.importsAt ?? 0,
    });
  }
  return rewrites;
}

/** How the compiler names the declaration file of a source by its extension, and the extension of the file that holds that declaration's text in the program that reads it. */
const DECLARATION_FILES: Readonly<Record<string, { readonly declaration: string; readonly module: string }>> = {
  '.ts': { declaration: '.d.ts', module: '.ts' },
  '.tsx': { declaration: '.d.ts', module: '.ts' },
  '.js': { declaration: '.d.ts', module: '.ts' },
  '.jsx': { declaration: '.d.ts', module: '.ts' },
  '.mts': { declaration: '.d.mts', module: '.mts' },
  '.mjs': { declaration: '.d.mts', module: '.mts' },
  '.cts': { declaration: '.d.cts', module: '.cts' },
  '.cjs': { declaration: '.d.cts', module: '.cts' },
};

/**
 * Give the declarations the check program emitted from the original sources the import paths Node resolves, as the emitted JavaScript has
 * them (`nodeSpecifierEdits`): a NodeNext consumer reads these files. A declaration's text is read as a module beside its source, so
 * a specifier resolves from where the source's own does, and the edits apply to the declaration. The result is the emitted files with
 * the edited text of those that needed an edit.
 */
function rewriteDeclarations(session: ts.ProgramSession, project: Project, sources: readonly ts.SourceFile[], rootNames: readonly string[], flags: readonly string[], emitted: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const layoutRoot = project.rootDir ?? sourceBase(project, sources);
  const directory = project.declarationDir ?? project.outDir;
  const declarations = new Map<string, { readonly file: string; readonly text: string }>();
  for (const source of sources.filter((candidate) => !candidate.isDeclarationFile)) {
    const extension = Object.keys(DECLARATION_FILES).find((candidate) => source.fileName.endsWith(candidate));
    if (extension === undefined) continue;
    const kind = DECLARATION_FILES[extension]!;
    const stem = source.fileName.slice(0, source.fileName.length - extension.length);
    const file = path.join(directory, `${path.relative(layoutRoot, stem)}${kind.declaration}`);
    const text = emitted.get(file);
    if (text !== undefined) declarations.set(`${stem}.golem-declaration${kind.module}`, { file, text });
  }
  if (declarations.size === 0) return emitted;
  const overlays = new Map([...declarations].map(([module, { text }]) => [module, text]));
  using program = session.openProgram({ root: project.root, sources: [...rootNames, ...overlays.keys()], configFile: project.configFile, flags, overlays });
  const checker = program.getTypeChecker();
  const options = { compilerOptions: program.getCompilerOptions(), projectSources: new Set(sources.map((source) => source.fileName)) };
  const rewritten = new Map(emitted);
  for (const [module, { file, text }] of declarations) {
    const declaration = program.getSourceFile(module);
    if (declaration === undefined) throw new Error(`golem build could not read the declaration ${displayPath(file)} to change its import paths.`);
    const { edits } = nodeSpecifierEdits(declaration, checker, options);
    if (edits.length > 0) rewritten.set(file, applyRewrites(text, { edits, imports: [], importsAt: 0 }, file).code);
  }
  return rewritten;
}

/** The endings of the files the compiler writes for a source, longest first: the JavaScript, the declaration and their maps. */
const EMITTED_ENDINGS = ['.d.ts.map', '.d.mts.map', '.d.cts.map', '.d.ts', '.d.mts', '.d.cts', '.js.map', '.mjs.map', '.cjs.map', '.jsx.map', '.js', '.mjs', '.cjs', '.jsx'] as const;

/**
 * The source an emitted file belongs to: the one whose path, without its extension, is the file's path under the output directory,
 * from a folder that holds every source. Undecided when none or several do, so the file is not attributed and not removed later.
 */
function sourceOfEmitted(project: Project, local: readonly ts.SourceFile[], file: string): string | undefined {
  const ending = EMITTED_ENDINGS.find((candidate) => file.endsWith(candidate));
  if (ending === undefined) return undefined;
  const stem = file.slice(0, file.length - ending.length);
  const directory = ending.startsWith('.d.') ? project.declarationDir ?? project.outDir : project.outDir;
  const relative = path.relative(directory, stem);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const matches = local.filter((source) => {
    const extension = Object.keys(DECLARATION_FILES).find((candidate) => source.fileName.endsWith(candidate));
    if (extension === undefined) return false;
    const sourceStem = source.fileName.slice(0, source.fileName.length - extension.length);
    if (sourceStem !== relative && !sourceStem.endsWith(`${path.sep}${relative}`)) return false;
    const layoutRoot = sourceStem.slice(0, sourceStem.length - relative.length);
    return local.every((other) => isInsideDirectory(layoutRoot, other.fileName));
  });
  return matches.length === 1 ? matches[0]!.fileName : undefined;
}

/**
 * Keep the files the compiler emitted for each source of the program, and remove those of a source that left the program since
 * the build before: its JavaScript, declaration and maps, and the directories that leave empty inside the output. A file that a
 * source still in the program owns stays. Only the files recorded here are removed: a file another tool wrote is never touched.
 */
function settleOutputs(run: BuildRun, project: Project, sources: readonly ts.SourceFile[], emitted: readonly string[]): void {
  const { emitted: record } = run;
  if (record === undefined) return;
  const local = sources.filter((source) => !source.isDeclarationFile);
  for (const file of emitted) {
    const source = sourceOfEmitted(project, local, path.resolve(file));
    if (source !== undefined) record.set(source, new Set([...record.get(source) ?? [], path.resolve(file)]));
  }
  const present = new Set(local.map((source) => source.fileName));
  const kept = new Set([...record].filter(([source]) => present.has(source)).flatMap(([, files]) => [...files]));
  for (const [source, files] of [...record]) {
    if (present.has(source)) continue;
    record.delete(source);
    for (const file of [...files].filter((candidate) => !kept.has(candidate))) {
      fs.rmSync(file, { force: true });
      // Directories that this leaves empty go too, but never the output directory itself or anything above it.
      const inOutput = (directory: string): boolean => [project.outDir, project.declarationDir].some((output) => output !== undefined && output !== directory && isInsideDirectory(output, directory));
      for (let directory = path.dirname(file); inOutput(directory) && fs.existsSync(directory) && fs.readdirSync(directory).length === 0; directory = path.dirname(directory)) fs.rmdirSync(directory);
    }
  }
}

/** The directories this build writes: a watching build builds again once when one of them has vanished. */
function writtenDirectories(project: Project): Set<string> {
  if (project.noEmit) return new Set();
  return new Set([
    ...project.emitsJavaScript ? [project.outDir] : [],
    ...project.declaration ? [project.declarationDir ?? project.outDir] : [],
  ]);
}

/** What one build and the builds after it share: the files a watching build looks at, and the generate step's state. */
interface BuildRun {
  readonly project: string | undefined;
  readonly config: string | undefined;
  readonly tscArguments: readonly string[];
  /** Every file the build read, for a watching build to look at. */
  readonly inputs: Set<string>;
  readonly outputs: Set<string>;
  /** The files the generate step wrote or kept. Generating one is the build's own doing, so it is no change to watch for. */
  readonly owned: Set<string>;
  /** For a watching build: the files the compiler emitted for each source, over all its builds. A source that leaves the program takes them with it. */
  readonly emitted?: Map<string, Set<string>>;
  /** For a watching build, what the build reads first and what it was then: the only baseline a file the build has not met before can have. */
  baseline?: RunBaseline;
  readonly generation: GeneratorSessionResources;
  readonly onGenerated?: (ran: ReadonlySet<string>) => void;
  /** The last generate run that finished: the next run reruns only the jobs a changed input reaches. Empty after a failed run. */
  pipeline?: PipelineState;
}

/**
 * Print what `tsc -p` prints for a check: each diagnostic, plain or pretty (the `pretty` option, else when stdout is a terminal), then the
 * files of `listFiles`, then in the pretty form the line that counts the errors.
 */
function reportCheck(root: string, program: ts.Program, diagnostics: readonly ts.Diagnostic[]): void {
  const host = diagnosticHost(root);
  const options = program.getCompilerOptions();
  const listed = options.listFiles === true ? program.getSourceFiles().map((file) => `${file.fileName}${host.getNewLine()}`).join('') : '';
  const output = `${diagnosticText(root, options, diagnostics)}${listed}${isPretty(options) ? ts.formatErrorSummary(diagnostics, host) : ''}`;
  if (output !== '') process.stdout.write(output);
}

function diagnosticHost(root: string): ts.DiagnosticFormatHost {
  return { getCanonicalFileName: (name: string) => name, getCurrentDirectory: () => root, getNewLine: () => os.EOL };
}

/** The `pretty` option, else whether stdout is a terminal. */
function isPretty(options: ts.CompilerOptions): boolean {
  return typeof options.pretty === 'boolean' ? options.pretty : process.stdout.isTTY === true && !process.env.NO_COLOR;
}

/** Each diagnostic as `tsc` prints it, plain or pretty. */
function diagnosticText(root: string, options: ts.CompilerOptions, diagnostics: readonly ts.Diagnostic[]): string {
  const host = diagnosticHost(root);
  return diagnostics.map((diagnostic) => (isPretty(options) ? `${ts.formatDiagnosticsWithColorAndContext([diagnostic], host)}${host.getNewLine()}` : ts.formatDiagnostics([diagnostic], host))).join('');
}

/** The options of the emit program: it emits JavaScript and its maps from the rewritten text, and leaves the check and the declarations to the check program. Each beats a forwarded argument. */
const EMIT_OPTIONS = { noCheck: true, declaration: false, declarationMap: false, composite: false, noEmit: false, emitDeclarationOnly: false, noEmitOnError: false } as const;

/** The build state file that a program with `incremental` or `composite` hands out with its outputs: golem keeps no TypeScript build state, so it is not written. */
const BUILD_INFO = /\.tsbuildinfo$/;

/**
 * Remove what a golem build before the in-process emit kept under `.golem/build/<config name>`: the staged copy of the sources, with the
 * links it holds to the `node_modules` of the project (a link is removed, never entered), and the build state of the check and of the emit.
 * Nothing reads them now. Only these paths go, and then the folders they leave empty.
 */
function removeOldBuildState(root: string, configFile: string): void {
  const build = path.join(root, '.golem', 'build');
  const directory = path.join(build, path.basename(configFile).replace(/\.json$/, ''));
  for (const old of ['stage', 'emit.tsbuildinfo', 'check.tsbuildinfo']) fs.rmSync(path.join(directory, old), { recursive: true, force: true });
  for (const folder of [directory, build]) {
    if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
  }
}

/** The map file of a JavaScript output. */
const JS_SOURCE_MAP = /\.[cm]?jsx?\.map$/;

/**
 * Point the map the compiler made for a rewritten file at the original. The compiler read the rewritten text, so a position in the emitted
 * JavaScript is a position in that text; composing with the applier's map gives the original line and column.
 */
function pointSourceMap(mapFile: string, text: string, rewriteMaps: ReadonlyMap<string, SourceMapV3>): string {
  const emitted = JSON.parse(text) as SourceMapV3;
  const [source] = emitted.sources;
  if (emitted.sources.length !== 1 || source === undefined) return text;
  const inner = rewriteMaps.get(path.resolve(path.dirname(mapFile), source));
  const composed = inner ? composeSourceMaps(emitted, inner) : emitted;
  const { sourcesContent, ...kept } = composed;
  return JSON.stringify({
    ...kept,
    sources: [source],
    // Keep embedded sources only when the compiler embedded them; they are the original text.
    ...(emitted.sourcesContent === undefined ? {} : { sourcesContent: inner ? inner.sourcesContent : sourcesContent }),
  });
}

/** Write one output when it differs from the file on disk, so a file another tool changed is repaired and a file that is current keeps its time stamp. A failure names the file. */
function writeOutput(file: string, text: string): void {
  try {
    atomicWrite(file, text);
  } catch (error) {
    throw new Error(`golem build could not write ${displayPath(file)}: ${errorMessage(error)}`, { cause: error });
  }
}

/** One build: generate, check the original sources, emit the rewritten ones. `changed` are the inputs that changed since the build before. */
async function buildOnce(session: ts.ProgramSession, run: BuildRun, changed?: readonly string[]): Promise<number> {
  const { inputs, outputs } = run;
  // The folder of an input outside the root is recorded as it is when the run first reads it, like the input itself.
  let root: string | undefined;
  const observe = (filename: string): void => {
    const file = path.resolve(filename);
    inputs.add(file);
    run.baseline?.observe(file);
    const folder = root === undefined ? undefined : outsideFolder(root, file);
    if (folder !== undefined) run.baseline?.observeFolder(folder);
  };
  const golemConfig = readGolemConfig(run.config, observe);
  const configFile = resolveProject(run.project, golemConfig);
  root = path.dirname(configFile);
  for (const input of inputs) {
    const folder = outsideFolder(root, input);
    if (folder !== undefined) run.baseline?.observeFolder(folder);
  }
  observe(configFile);
  requestTypeScriptRoot(root);
  removeOldBuildState(root, configFile);
  // The options of the tsconfig with the forwarded arguments applied, as `tsc -p` resolves them. A configuration the build cannot mirror fails before anything is generated.
  const parseOptions = (): { options: ts.CompilerOptions; fileNames: string[] } => (run.tscArguments.length === 0
    ? session.parseConfigFile(configFile, observe)
    : session.parseConfigFileWithFlags(configFile, run.tscArguments, observe));
  const configured = parseOptions();
  assertSupported(configFile, configured);
  // The generated files are part of the program the next steps read, so they are written first. A job whose inputs did not change is skipped.
  const previous = run.pipeline;
  run.pipeline = undefined;
  // The compiler output is this build's own: a job that lists the project must not see it change.
  const ignoredDirectories = [stringOption(configured.options, 'outDir'), stringOption(configured.options, 'declarationDir')].filter((directory) => directory !== undefined);
  const generated = await runPipeline(golemConfig.configFile, { session: run.generation, onInput: observe, ignoredDirectories, ...(previous === undefined || changed === undefined ? {} : { previous, changedInputs: changed }) });
  for (const output of generated.owned) run.owned.add(output);
  // The session compares file signatures, and a write within the timestamp resolution of the file system leaves a signature as it was: the files this step wrote are told to it.
  if (generated.ran.size > 0) session.inputsChanged(generated.owned);
  run.pipeline = generated;
  run.onGenerated?.(generated.ran);
  const parsed = parseOptions();
  const project = readProject(configFile, parsed);
  // The sources are inputs from here on: a failed check ends the build before any later step reads them.
  for (const filename of parsed.fileNames) observe(filename);
  outputs.clear();
  for (const directory of writtenDirectories(project)) outputs.add(directory);

  // The original sources are what the check program holds; it also writes the declarations, to memory.
  using program = session.openProgram({ root, sources: parsed.fileNames, configFile, flags: run.tscArguments, onInput: observe });
  const writesDeclarations = project.declaration && !project.noEmit;
  const declarations = writesDeclarations ? program.emitToMemory('declarations') : undefined;
  const diagnostics = ts.getTscDiagnostics(program, declarations?.diagnostics);
  reportCheck(root, program, diagnostics);
  const checkFailed = diagnostics.length > 0;
  // Like the compiler: a failed check still emits unless noEmitOnError is set. The exit status is the check's: 2 when it wrote the declarations, else 1.
  const stopped = checkFailed && project.noEmitOnError;
  const checkCode = !checkFailed ? 0 : declarations !== undefined && !stopped && !declarations.emitSkipped ? 2 : 1;
  if (stopped) return checkCode;
  const sources = projectSources(program);
  for (const source of sources) observe(source.fileName);
  const written = declarations === undefined ? new Map<string, string>() : rewriteDeclarations(session, project, sources, parsed.fileNames, run.tscArguments, declarations.files);
  for (const [file, text] of written) writeOutput(file, text);
  const checkFiles = [...written.keys()];
  if (!project.emitsJavaScript) {
    settleOutputs(run, project, sources, checkFiles);
    return checkCode;
  }
  const checker = program.getTypeChecker();
  const models = golemConfig.jobs.find((job) => job.kind === 'models');
  const scanned = new RewriteScanner({ root, directory: golemConfig.directory, modelsRoot: modelsRootOf(golemConfig), suffixes: models?.options.suffixes, output: models?.options.output, program, checker, codecKeysFile: codecKeysPath(golemConfig.directory), nest: golemConfig.jobs.some((job) => job.kind === 'controllers'), nonModelInputs: golemConfig.nonModelInputs })
    .scanFiles(sources.map((source) => source.fileName));
  const errors = scanned.diagnostics.filter((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error);
  if (errors.length > 0) throw scanFailure(root, errors);
  for (const warning of scanned.diagnostics) {
    if (warning.severity === GolemDiagnosticSeverity.Warning) process.stderr.write(`${warning.code} (${warning.file === undefined ? '' : displayPath(path.resolve(root, warning.file))}:${warning.line}:${warning.column}): ${warning.message}\n`);
  }

  // The emit program reads the original paths, with the rewritten text served over the sources that have a call to rewrite or a specifier to change.
  // It skips the check and writes no declaration: the declarations come from the check program, whose types the rewritten text would change.
  const rewrites = withNodeSpecifiers(root, sources, checker, program.getCompilerOptions(), scanned.files);
  const overlays = new Map<string, string>();
  const rewriteMaps = new Map<string, SourceMapV3>();
  for (const source of sources) {
    const rewrite = rewrites.get(posix(path.relative(root, source.fileName)));
    const rewritten = rewrite && applyRewrites(source.text, rewrite, source.fileName);
    if (rewritten) {
      overlays.set(source.fileName, rewritten.code);
      rewriteMaps.set(path.resolve(source.fileName), rewritten.map);
    }
  }
  using emitProgram = session.openProgram({ root, sources: parsed.fileNames, configFile, flags: run.tscArguments, overlays, compilerOptionOverrides: EMIT_OPTIONS, onInput: observe });
  const emitted = emitProgram.emitToMemory('javascript');
  // A failed emit writes no file: the outputs of the builds before stay as they were. After a failed check the check program already reported what the emit would report.
  if (emitted.emitSkipped || emitted.diagnostics.length > 0) {
    if (!checkFailed) {
      const printed = diagnosticText(root, emitProgram.getCompilerOptions(), emitted.diagnostics);
      process.stdout.write(printed === '' ? `golem build: the compiler emitted no JavaScript for ${displayPath(configFile)}.\n` : printed);
    }
    return checkFailed ? checkCode : 1;
  }
  const files = new Map<string, string>();
  for (const [file, text] of emitted.files) {
    if (!BUILD_INFO.test(file)) files.set(file, JS_SOURCE_MAP.test(file) ? pointSourceMap(file, text, rewriteMaps) : text);
  }
  for (const [file, text] of files) writeOutput(file, text);
  settleOutputs(run, project, sources, [...checkFiles, ...files.keys()]);
  return checkFailed ? checkCode : 0;
}

/**
 * Generate the golem.yaml's code, check the original sources of its tsconfig and emit the rewritten ones into its outDir. The project's
 * compiler checks and emits in process, to memory; the build writes each output that differs from the file on disk. With `watch`, the build repeats when an input changes and ends on `signal`.
 */
export async function runBuild(options: BuildOptions): Promise<{ exitCode: number }> {
  const first = readGolemConfig(options.config, () => {});
  const root = path.dirname(first.tsconfig);
  const label = displayPath(options.project === undefined ? first.tsconfig : path.resolve(options.project));
  using session = new ts.ProgramSession({ cwd: root });
  using generation = new GeneratorSessionResources();
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  const outputsPresent = (): boolean => [...outputs].every((directory) => fs.existsSync(directory));
  // Whether the directories the build writes existed when it ended: one that vanishes afterwards, such as a deleted outDir, is rebuilt once.
  // Taken before the build is announced, so a deletion that follows the announcement is seen.
  let wrote = true;
  const state: BuildRun = {
    project: options.project,
    config: options.config,
    tscArguments: options.tscArguments ?? [],
    inputs,
    outputs,
    owned: new Set<string>(),
    ...(options.watch ? { emitted: new Map<string, Set<string>>() } : {}),
    generation,
    ...(options.onGenerated === undefined ? {} : { onGenerated: options.onGenerated }),
  };
  const run = async (changed?: readonly string[], beforeAnnouncing: () => void = () => {}): Promise<number> => {
    const exitCode = await buildOnce(session, state, changed);
    wrote = exitCode === 0 && outputsPresent();
    // The watch baseline is recorded before the build is announced: whoever reacts to the announcement may edit a source at once.
    beforeAnnouncing();
    return exitCode;
  };
  if (!options.watch) {
    const exitCode = await run();
    options.onBuilt?.({ label, exitCode });
    return { exitCode };
  }

  let exitCode = 0;
  const scanOf = (): InputScan => new InputScan(inputs, { root }, realInputFiles);
  // The build's own names, which come and go with the build itself: the directories it writes, the files it generates and the directories it created for them. It changes only when a build ends.
  let own = new OwnedOutputIndex();
  let scan = scanOf();
  // A deleted output directory is seen in the folder above it, so that folder is watched too.
  const outputParents = (): string[] => [...outputs].map((directory) => path.dirname(directory));
  let busy = false;
  let unwatchable = false;
  let starting = true;
  let finish = (): void => {};
  // A folder or file the scan cannot read (a permission, too many open files) is reported once; the watch goes on with the next event.
  let unreadable: string | undefined;
  const watcher = new InputWatcher({
    root: () => root,
    tick: async (installed) => {
      if (options.signal?.aborted) return;
      busy = true;
      try {
        if (starting) {
          // The first build runs as the first tick, so no tick runs beside it. What changed while it ran is told by its baseline, in the tick that follows.
          starting = false;
          try {
            await attempt(undefined);
          } finally {
            // An `onBuilt` that throws is reported by the watcher's error path, and the watch goes on.
            if (!unwatchable) {
              process.stdout.write('Watching for changes.\n');
              watcher.request();
            }
          }
          return;
        }
        let current: InputSnapshot;
        let changed: string[];
        try {
          current = watcher.snapshotWatching(scan, outputParents());
          changed = changedPaths(previous, current, (filename) => own.covers(filename));
          unreadable = undefined;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== unreadable) process.stderr.write(`${message}\n`);
          unreadable = message;
          return;
        }
        if (changed.length === 0 && !installed && !(wrote && !outputsPresent())) return;
        session.inputsChanged(changed);
        // An install can change any package a job or the compiler read: everything is built again.
        await attempt(installed ? undefined : changed, current);
      } finally {
        busy = false;
        if (options.signal?.aborted || unwatchable) finish();
      }
    },
    onError: (error) => { process.stderr.write(`${error.message}\n`); },
    // Nothing will start another build, so the watch ends, and its exit code says it failed.
    onUnwatchable: () => {
      unwatchable = true;
      if (!busy) finish();
    },
  });
  let previous: InputSnapshot = { files: new Map(), folders: new Map() };
  const attempt = async (changed: readonly string[] | undefined, before = watcher.snapshotWatching(scan, outputParents())): Promise<void> => {
    // The scan from before the build, so an edit or a new file made during it starts the next build. The first build has no
    // inputs yet: its files carry the signature they had when the build first read them.
    const baseline = new RunBaseline(before, root, realInputFiles);
    state.baseline = baseline;
    const record = (): void => {
      // A file the generate step wrote, and the directory it created for it, is the build's own: its signature after the build is the one the next build compares with.
      own = new OwnedOutputIndex([...outputs, ...state.owned]);
      scan = scanOf();
      previous = baseline.settle(watcher.snapshotWatching(scan, outputParents()), (file) => own.covers(file));
    };
    try {
      exitCode = await run(changed, record);
    } catch (error) {
      exitCode = 1;
      wrote = false;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      record();
    }
    options.onBuilt?.({ label, exitCode });
  };
  await new Promise<void>((resolve) => {
    finish = () => { watcher.close(); resolve(); };
    const stop = (): void => { if (!busy) finish(); };
    if (options.signal?.aborted) stop();
    else {
      options.signal?.addEventListener('abort', stop, { once: true });
      watcher.start();
    }
  });
  return { exitCode: unwatchable ? 1 : exitCode };
}
