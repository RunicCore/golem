import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalFile, modelsRootOf, resolveConfig } from './config.js';
import type { GolemConfig } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import { displayPath, errorMessage, GolemDiagnosticSeverity, hasErrorCode, isInsideDirectory } from './generator-api.js';
import type { GolemDiagnostic } from './generator-api.js';
import { nodeSpecifierEdits } from './node-specifiers.js';
import { atomicWrite } from './outputs.js';
import { GeneratorSessionResources, runPipeline } from './pipeline.js';
import type { PipelineState } from './pipeline.js';
import { applyRewrites } from './rewrite.js';
import type { FileRewrite } from './rewrite.js';
import { emitsJavaScript, projectSources, RewriteScanner } from './rewrite-scan.js';
import { pointDeclarationMap, pointInlineSourceMap, pointSourceMap } from './source-map.js';
import type { SourceMapV3 } from './source-map.js';
import { referenceClosure } from './typescript-config.js';
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
  /** `-b` or `--build` was given: the build refuses it before it generates, with the command for each project the tsconfig references. */
  readonly compilerBuild?: boolean;
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

/** The command that builds a referenced project: its own golem.yaml names it. */
function referencedCommand(project: string): string {
  return `golem build --config ${displayPath(path.join(path.dirname(project), 'golem.yaml'))}`;
}

/**
 * The refusal of a build that would follow project references. A golem.yaml names one project, and `tsc -b` would also build projects that have
 * no golem.yaml, whose calls would not be rewritten. It names each referenced project with the command that builds it.
 */
function referencesRefusal(configFile: string, references: readonly ts.ProjectReference[], reason: string): Error {
  const commands = references.map((reference) => `  ${displayPath(reference.path)}: ${referencedCommand(reference.path)}`);
  return new Error([`${reason} A golem.yaml names one project.${commands.length === 0 ? '' : ` Build each project of ${displayPath(configFile)} with its own golem.yaml, in dependency order:`}`, ...commands].join('\n'));
}

/** Fail on a configuration the build cannot emit: the tsconfig's, with the forwarded arguments applied. It reads options alone, so it runs before anything is generated. */
function assertSupported(configFile: string, parsed: ts.ParsedProject): void {
  const { options } = parsed;
  if (parsed.fileNames.length === 0) {
    if (parsed.projectReferences.length > 0) throw referencesRefusal(configFile, parsed.projectReferences, `${displayPath(configFile)} only lists project references, so it has no files to build.`);
    throw new Error(`${displayPath(configFile)} includes no files.`);
  }
  if (stringOption(options, 'outDir') === undefined) throw new Error(`golem build requires compilerOptions.outDir in ${displayPath(configFile)}: it emits the rewritten sources there.`);
  // The lanes disagree on outFile: TS 6 writes one file, TS 7 ignores it and writes one file per source. One build cannot write the same files on both.
  if (stringOption(options, 'outFile') !== undefined) {
    throw new Error(`golem build does not support outFile (${displayPath(configFile)}): TypeScript 7 removed it (TS5102) and TypeScript 6 deprecates it (TS5101), so one build cannot write the same files on both. Emit one file for each source, then bundle with esbuild or Vite and the golem plugin.`);
  }
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

/** A referenced project with its parse: `tsc -p` reads the declaration output of its sources in place of the sources. */
interface ReferencedProject {
  readonly configFile: string;
  readonly options: ts.CompilerOptions;
  readonly fileNames: readonly string[];
}

/**
 * Parse the referenced projects, and the projects they reference: `tsc` loads the whole closure. A project that is not composite is an error of
 * `tsc -p` (TS6306), and the TypeScript 7 program would not report it.
 */
function readReferences(session: ts.ProgramSession, configFile: string, references: readonly ts.ProjectReference[], observe: (filename: string) => void): ReferencedProject[] {
  return referenceClosure(references, (referenced) => {
    const parsed = session.parseConfigFile(referenced, observe);
    if (parsed.options.composite !== true) {
      throw new Error(`${displayPath(referenced)} is referenced by ${displayPath(configFile)}, so it must set composite: true (TS6306).`);
    }
    return parsed;
  }).map(({ configFile: referenced, parsed }) => ({ configFile: referenced, options: parsed.options, fileNames: parsed.fileNames }));
}

/**
 * The lines that name the project to build first: one for each referenced project that owns a source an import of the program reached
 * and found without a declaration output, with the first such source. The compiler reports the failed import itself.
 */
function unbuiltReferences(references: readonly ReferencedProject[], unbuilt: readonly string[]): string[] {
  const lines = new Map<string, string>();
  for (const source of unbuilt) {
    const owner = references.find((reference) => reference.fileNames.some((file) => path.resolve(file) === path.resolve(source)));
    if (owner !== undefined && !lines.has(owner.configFile)) {
      lines.set(owner.configFile, `${displayPath(owner.configFile)} has not been built: ${displayPath(source)} has no declaration output. Build it first with ${referencedCommand(owner.configFile)}.`);
    }
  }
  return [...lines.values()];
}

/** Read the build settings from a configuration `assertSupported` accepted. */
function readProject(configFile: string, parsed: { readonly options: ts.CompilerOptions; readonly fileNames: readonly string[] }): Project {
  const { options } = parsed;
  const root = path.dirname(configFile);
  const outDir = stringOption(options, 'outDir');
  if (outDir === undefined) throw new Error(`golem build requires compilerOptions.outDir in ${displayPath(configFile)}: it emits the rewritten sources there.`);
  const declarationDir = stringOption(options, 'declarationDir');
  const noEmit = options.noEmit === true;
  return {
    root,
    configFile,
    files: parsed.fileNames,
    outDir,
    ...(declarationDir === undefined ? {} : { declarationDir }),
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

/** The extension of the file that holds a declaration's text in the program that reads it: `.d.ts` is read as `.ts`, `.d.mts` as `.mts`, `.d.cts` as `.cts`. */
const DECLARATION_MODULE = /\.d(\.[cm]?ts)$/;
const DECLARATION_MAP = /\.d\.[cm]?ts\.map$/;

/**
 * Give the declarations the check program emitted from the original sources the import paths Node resolves, as the emitted JavaScript has
 * them (`nodeSpecifierEdits`): a NodeNext consumer reads these files. A declaration's text is read as a module beside its source, so
 * a specifier resolves from where the source's own does, and the edits apply to the declaration. The result is the emitted files with
 * the edited text of those that needed an edit, and the declaration map of each of them pointed at the edited text. The compiler names the source
 * of each output, and the declaration map is found from that, as the JavaScript map is, never from the name of the declaration.
 */
function rewriteDeclarations(session: ts.ProgramSession, project: Project, sources: readonly ts.SourceFile[], rootNames: readonly string[], flags: readonly string[], emitted: ts.MemoryEmit): ReadonlyMap<string, string> {
  // The seam names a source by its resolved path; the overlay takes the program's own file name for it, as the program reads it.
  const projectFiles = new Map(sources.filter((candidate) => !candidate.isDeclarationFile).map((candidate) => [path.resolve(candidate.fileName), candidate.fileName]));
  const declarations = new Map<string, { readonly file: string; readonly text: string }>();
  for (const [file, text] of emitted.files) {
    const kind = DECLARATION_MODULE.exec(file)?.[1];
    const source = projectFiles.get(emitted.sources.get(file) ?? '');
    if (kind === undefined || source === undefined) continue;
    declarations.set(`${source.slice(0, source.length - path.extname(source).length)}.golem-declaration${kind}`, { file, text });
  }
  if (declarations.size === 0) return emitted.files;
  const overlays = new Map([...declarations].map(([module, { text }]) => [module, text]));
  using program = session.openProgram({ root: project.root, sources: [...rootNames, ...overlays.keys()], configFile: project.configFile, flags, overlays });
  const checker = program.getTypeChecker();
  const options = { compilerOptions: program.getCompilerOptions(), projectSources: new Set(sources.map((source) => source.fileName)) };
  const rewritten = new Map(emitted.files);
  const editMaps = new Map<string, SourceMapV3>();
  for (const [module, { file, text }] of declarations) {
    const declaration = program.getSourceFile(module);
    if (declaration === undefined) throw new Error(`golem build could not read the declaration ${displayPath(file)} to change its import paths.`);
    const { edits } = nodeSpecifierEdits(declaration, checker, options);
    if (edits.length === 0) continue;
    const edited = applyRewrites(text, { edits, imports: [], importsAt: 0 }, file);
    rewritten.set(file, edited.code);
    editMaps.set(emitted.sources.get(file)!, edited.map);
  }
  for (const [file, text] of emitted.files) {
    const edit = editMaps.get(emitted.sources.get(file) ?? '');
    if (edit !== undefined && DECLARATION_MAP.test(file)) rewritten.set(file, pointDeclarationMap(text, edit));
  }
  return rewritten;
}

/**
 * Keep the files the compiler emitted for each source of the program, and remove those of a source that left the program since
 * the build before: its JavaScript, declaration and maps, and the directories that leave empty inside the output. A file that a
 * source still in the program owns stays. `emitted` names the source the compiler made each output from. Only the files recorded here are removed: a file another tool wrote is never touched.
 */
function settleOutputs(run: BuildRun, project: Project, sources: readonly ts.SourceFile[], emitted: ReadonlyMap<string, string>): void {
  const { emitted: record } = run;
  if (record === undefined) return;
  const local = sources.filter((source) => !source.isDeclarationFile);
  // The seam names a source by its resolved path, and the program by its own file name (with `/` on Windows): both are compared resolved.
  const present = new Set(local.map((source) => path.resolve(source.fileName)));
  for (const [file, source] of emitted) {
    if (present.has(source)) record.set(source, new Set([...record.get(source) ?? [], path.resolve(file)]));
  }
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
  /** Whether the leftovers of an older golem build were looked for: once for each run, not for each build of a watch. */
  oldStateRemoved: boolean;
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
 * Nothing reads them now. Only these paths go, and then the folders they leave empty. A failure is a warning, once for each run.
 */
function removeOldBuildState(root: string, configFile: string): void {
  const build = path.join(root, '.golem', 'build');
  const directory = path.join(build, path.basename(configFile).replace(/\.json$/, ''));
  try {
    for (const old of ['stage', 'emit.tsbuildinfo', 'check.tsbuildinfo']) fs.rmSync(path.join(directory, old), { recursive: true, force: true });
    for (const folder of [directory, build]) {
      if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
    }
  } catch (error) {
    // The leftovers are of no use to the build, so a file system that will not give them up (a permission, a busy file, a file where a folder was) does not stop it.
    if (!['EACCES', 'EPERM', 'EBUSY', 'ENOTDIR', 'ENOTEMPTY'].some((code) => hasErrorCode(error, code))) throw error;
    process.stderr.write(`golem build could not remove ${displayPath(directory)}, which an older golem build left: ${errorMessage(error)}\n`);
  }
}

/** The map file of a JavaScript output. */
const JS_SOURCE_MAP = /\.[cm]?jsx?\.map$/;
/** A JavaScript output. */
const JS_OUTPUT = /\.[cm]?jsx?$/;

/**
 * Write one output when it differs from the file on disk, so a file another tool changed is repaired and a file that is current keeps its time stamp.
 * A file that exists is written in place, as `tsc` does: a link stays a link and the mode of the file, such as an exec bit, stays. A new file is
 * published whole, so no reader sees half of it. A failure names the file.
 */
function writeOutput(file: string, text: string): void {
  try {
    const existing = fs.statSync(file, { throwIfNoEntry: false });
    if (existing === undefined) atomicWrite(file, text);
    else if (existing.isFile() && fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
    else if (!existing.isFile()) throw new Error('it is not a file');
  } catch (error) {
    throw new Error(`golem build could not write ${displayPath(file)}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Refuse a build whose compiler would place an output outside the directory it belongs in: the outDir for JavaScript and maps, the declarationDir
 * (else the outDir) for declarations. With no `rootDir`, or one that does not hold every source, a source outside the project folder lands beside
 * itself, where the build would overwrite files of the project. Nothing is written before every output is checked.
 */
function assertContained(project: Project, configFile: string, javascript: ReadonlyMap<string, string>, declarations: ReadonlyMap<string, string>): void {
  const directories: readonly [ReadonlyMap<string, string>, string][] = [[javascript, project.outDir], [declarations, project.declarationDir ?? project.outDir]];
  for (const [files, directory] of directories) {
    for (const file of files.keys()) {
      if (isInsideDirectory(directory, file)) continue;
      throw new Error(`golem build would write ${displayPath(file)} outside ${displayPath(directory)}, because a source of ${displayPath(configFile)} is outside its rootDir or, with no rootDir, outside the project folder. Set rootDir to a folder that holds every source, or keep the sources inside it.`);
    }
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
  if (!run.oldStateRemoved) {
    run.oldStateRemoved = true;
    removeOldBuildState(root, configFile);
  }
  // The options of the tsconfig with the forwarded arguments applied, as `tsc -p` resolves them. A configuration the build cannot mirror fails before anything is generated.
  const parseOptions = (): ts.ParsedProject => (run.tscArguments.length === 0
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
  const referenced = readReferences(session, configFile, parsed.projectReferences, observe);
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
  // An import that reached a referenced project with no output yet: name the project to build first, and write nothing.
  const unbuilt = unbuiltReferences(referenced, program.unbuiltReferences());
  if (unbuilt.length > 0) {
    process.stdout.write(`${unbuilt.join('\n')}\n`);
    return 1;
  }
  const checkFailed = diagnostics.length > 0;
  // Like the compiler: a failed check still emits unless noEmitOnError is set. The exit status is the check's: 2 when it wrote the declarations, else 1.
  const stopped = checkFailed && project.noEmitOnError;
  const checkCode = !checkFailed ? 0 : declarations !== undefined && !stopped && !declarations.emitSkipped ? 2 : 1;
  if (stopped) return checkCode;
  const sources = projectSources(program);
  for (const source of sources) observe(source.fileName);
  // Nothing is written until the emit has succeeded: a failed build leaves the outputs of the build before as they were.
  const written = declarations === undefined ? new Map<string, string>() : rewriteDeclarations(session, project, sources, parsed.fileNames, run.tscArguments, declarations);
  if (!project.emitsJavaScript) {
    assertContained(project, configFile, new Map(), written);
    for (const [file, text] of written) writeOutput(file, text);
    settleOutputs(run, project, sources, declarations?.sources ?? new Map());
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
    // The declarations of the check are not written either, so the status is not the check's 2.
    return 1;
  }
  // The compiler names the source of each output; the rewrite map is found from that, never from the `sources` text of the map, which sourceRoot and mapRoot change.
  // A map that is composed keeps every field the compiler wrote, and the mappings name the original. A file with no rewrite keeps the map as the compiler wrote it.
  const inline = emitProgram.getCompilerOptions().inlineSourceMap === true;
  const files = new Map<string, string>();
  for (const [file, text] of emitted.files) {
    if (BUILD_INFO.test(file)) continue;
    const source = emitted.sources.get(file);
    const rewriteMap = source === undefined ? undefined : rewriteMaps.get(path.resolve(source));
    if (rewriteMap !== undefined && JS_SOURCE_MAP.test(file)) files.set(file, pointSourceMap(text, rewriteMap));
    else if (rewriteMap !== undefined && inline && JS_OUTPUT.test(file)) files.set(file, pointInlineSourceMap(displayPath(file), text, rewriteMap));
    else files.set(file, text);
  }
  assertContained(project, configFile, files, written);
  for (const [file, text] of [...written, ...files]) writeOutput(file, text);
  settleOutputs(run, project, sources, new Map([...declarations?.sources ?? [], ...emitted.sources]));
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
  // `-b` is refused here, once, before anything is generated or watched: a refusal inside a watching build would be reported and the watch would go on.
  if (options.compilerBuild) {
    const configFile = resolveProject(options.project, first);
    requestTypeScriptRoot(root);
    throw referencesRefusal(configFile, session.parseConfigFile(configFile).projectReferences, 'golem build does not take -b or --build: `tsc -b` would also build projects that have no golem.yaml, whose calls golem would not rewrite.');
  }
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
    oldStateRemoved: false,
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
