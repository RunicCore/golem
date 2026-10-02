import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { contains, resolveConfig } from './config.js';
import { GolemDiagnosticSeverity } from './generator-api.js';
import type { GolemDiagnostic } from './generator-api.js';
import { atomicWrite } from './outputs.js';
import { applyRewrites } from './rewrite.js';
import type { RewriteIndex } from './rewrite.js';
import { projectConfigFile, projectDirectory, scanRewrites, writeRewriteIndex } from './rewrite-scan.js';
import { composeSourceMaps } from './source-map.js';
import type { SourceMapV3 } from './source-map.js';
import * as ts from './typescript-ns.js';
import { resolveTypeScript } from './typescript-version.js';
import { signature } from './watch.js';

export interface BuildOptions {
  /** A tsconfig file, or a directory that holds `tsconfig.json`, as `tsc -p` takes it. */
  readonly project: string;
  readonly watch: boolean;
  /** The golem.yaml whose controllers jobs turn on the Nest rewrites. Without it, `golem.yaml` in the working directory when there is one, as `golem generate` finds it. */
  readonly config?: string;
  /** Stops a watching build; the returned promise resolves when the current build has finished. */
  readonly signal?: AbortSignal;
}

export const BUILD_REFERENCES_REJECTION = 'golem build does not support project references (-b); run golem build -p <tsconfig> per project.';

const GOLEM_DIRECTORY = '.golem';
const POLL_MS = 200;

/** What a build needs from the project's configuration, read once per build from the compiler's own parse. */
interface Project {
  readonly root: string;
  readonly configFile: string;
  /** `<root>/.golem/build/<config name>`: the staged copy and the compiler's incremental state of this tsconfig alone. */
  readonly buildDirectory: string;
  readonly files: readonly string[];
  readonly outDir: string;
  readonly declarationDir?: string;
  readonly rootDir?: string;
  readonly baseUrl?: string;
  readonly paths?: Readonly<Record<string, readonly string[]>>;
  /** The original configuration emits declarations, so the check writes them from the original sources. */
  readonly declaration: boolean;
  /** `noEmit` and `emitDeclarationOnly` leave no JavaScript to emit: the build is the check alone. */
  readonly emitsJavaScript: boolean;
  readonly noEmit: boolean;
}

function posix(filename: string): string {
  return filename.split(path.sep).join('/');
}

function stringOption(options: ts.CompilerOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

function pathsOption(options: ts.CompilerOptions): Readonly<Record<string, readonly string[]>> | undefined {
  const value = options.paths;
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.fromEntries(Object.entries(value).map(([pattern, targets]) => [pattern, (targets as readonly unknown[]).map(String)]));
}

function resolveProject(project: string): string {
  const requested = path.resolve(project);
  const stat = fs.statSync(requested, { throwIfNoEntry: false });
  if (!stat) throw new Error(`golem build cannot find ${requested}.`);
  const configFile = stat.isDirectory() ? path.join(requested, 'tsconfig.json') : requested;
  if (!fs.existsSync(configFile)) throw new Error(`golem build cannot find ${configFile}.`);
  return fs.realpathSync(configFile);
}

/** Read the build settings, or fail on a configuration the staged copy cannot mirror. */
function readProject(configFile: string, parsed: { readonly options: ts.CompilerOptions; readonly fileNames: readonly string[] }): Project {
  const { options } = parsed;
  const root = path.dirname(configFile);
  const unsupported = (what: string): Error => new Error(`golem build does not support ${what} (${configFile}).`);
  if (parsed.fileNames.length === 0) {
    throw new Error(`${configFile} includes no files. golem build builds one project and does not follow project references; run golem build -p <tsconfig> per project.`);
  }
  const outDir = stringOption(options, 'outDir');
  if (outDir === undefined) throw new Error(`golem build requires compilerOptions.outDir in ${configFile}: it emits the rewritten sources there.`);
  if (stringOption(options, 'outFile') !== undefined) throw unsupported('outFile');
  if (Array.isArray(options.rootDirs)) throw unsupported('rootDirs');
  if (options.inlineSourceMap === true) throw unsupported('inlineSourceMap');
  if (stringOption(options, 'sourceRoot') !== undefined) throw unsupported('sourceRoot');
  const rootDir = stringOption(options, 'rootDir');
  if (rootDir !== undefined && !contains(root, rootDir)) {
    throw new Error(`golem build cannot stage rootDir ${rootDir}: it is outside the project root ${root}.`);
  }
  const baseUrl = stringOption(options, 'baseUrl');
  const declarationDir = stringOption(options, 'declarationDir');
  const paths = pathsOption(options);
  const declaration = options.declaration === true || options.composite === true;
  const noEmit = options.noEmit === true;
  return {
    root,
    configFile,
    buildDirectory: path.join(root, GOLEM_DIRECTORY, 'build', path.basename(configFile).replace(/\.json$/, '')),
    files: parsed.fileNames,
    outDir,
    ...(declarationDir === undefined ? {} : { declarationDir }),
    ...(rootDir === undefined ? {} : { rootDir }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(paths === undefined ? {} : { paths: rebasePaths(paths, baseUrl ?? stringOption(options, 'pathsBasePath') ?? root) }),
    declaration,
    emitsJavaScript: !noEmit && options.emitDeclarationOnly !== true,
    noEmit,
  };
}

/** Each `paths` target as an absolute path: the staged copy is elsewhere, so a target relative to the original config would reach the originals. */
function rebasePaths(paths: Readonly<Record<string, readonly string[]>>, base: string): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(paths).map(([pattern, targets]) => [pattern, targets.map((target) => posix(path.resolve(base, target)))]));
}

/** The compiler CLI of the TypeScript the seam loaded: a different install would check with one compiler and emit with another. */
function compilerCli(root: string): string {
  const selected = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? root);
  if (selected.version !== ts.typescriptVersion) {
    throw new Error(`golem build would run TypeScript ${selected.version} from ${selected.packageDir}, but golem loaded TypeScript ${ts.typescriptVersion}; run golem from the project directory.`);
  }
  return path.join(selected.packageDir, 'bin', 'tsc');
}

interface TscResult { readonly code: number; readonly stdout: string; readonly stderr: string }

/** Run the compiler CLI; `forward` prints its output as it arrives, exactly as the compiler wrote it. */
function runTsc(cli: string, cwd: string, args: readonly string[], forward: boolean): Promise<TscResult> {
  return new Promise((resolve, reject) => {
    const pretty = forward && process.stdout.isTTY ? ['--pretty'] : [];
    const child = spawn(process.execPath, [cli, ...args, ...pretty], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; if (forward) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; if (forward) process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Whether the project's rewrites include the Nest codec decorators: a controllers job of the golem.yaml maps to this
 * project, as `golem generate` decides it. A golem.yaml named by `--config` must exist; the default one need not.
 */
function nestEnabled(root: string, config: { readonly file: string; readonly explicit: boolean }, observe: (filename: string) => void): boolean {
  observe(config.file);
  if (!fs.existsSync(config.file)) {
    if (config.explicit) throw new Error(`golem build cannot find ${config.file}.`);
    return false;
  }
  return resolveConfig(config.file).jobs.some((job) => job.kind === 'controllers' && projectDirectory(job.options.root) === root);
}

function scanFailure(errors: readonly GolemDiagnostic[]): Error {
  const location = (diagnostic: GolemDiagnostic): string => (diagnostic.file === undefined ? '' : ` (${diagnostic.file}${diagnostic.line === undefined ? '' : `:${diagnostic.line}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`})`);
  return new Error([
    `golem rewrite scan reported ${errors.length} error diagnostic${errors.length === 1 ? '' : 's'}:`,
    ...errors.map((diagnostic) => `  ${diagnostic.code}${location(diagnostic)}: ${diagnostic.message}`),
  ].join('\n'));
}

/** Delete staged files whose source left the program. */
function pruneStage(stageDirectory: string, keep: ReadonlySet<string>): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filename);
        if (fs.readdirSync(filename).length === 0) fs.rmdirSync(filename);
      } else if (!keep.has(posix(path.relative(stageDirectory, filename)))) fs.unlinkSync(filename);
    }
  };
  if (fs.existsSync(stageDirectory)) visit(stageDirectory);
}

interface StageResult {
  readonly configFile: string;
  /** The applier's map for each rewritten file, keyed by its root-relative path. */
  readonly maps: ReadonlyMap<string, SourceMapV3>;
}

/**
 * Mirror the program's local sources into `<root>/.golem/build/<config name>/stage`: the rewritten text for an indexed file, the file itself
 * otherwise. A file is written only when its content differs, so the compiler's incremental state keeps every other file.
 * The stage sits inside the root so packages resolve exactly as they do for the originals.
 */
function writeStage(project: Project, sources: readonly ts.SourceFile[], index: RewriteIndex): StageResult {
  const { root } = project;
  const stageDirectory = path.join(project.buildDirectory, 'stage');
  const maps = new Map<string, SourceMapV3>();
  const keep = new Set<string>(['tsconfig.json']);
  for (const source of sources) {
    const relative = posix(path.relative(root, source.fileName));
    const rewritten = applyRewrites(relative, source.text, index);
    if (rewritten) maps.set(relative, rewritten.map);
    atomicWrite(path.join(stageDirectory, relative), rewritten?.code ?? source.text);
    keep.add(relative);
  }
  pruneStage(stageDirectory, keep);

  const stageOf = (absolute: string): string => (contains(root, absolute) ? posix(path.join(stageDirectory, path.relative(root, absolute))) : absolute);
  const configFile = path.join(stageDirectory, 'tsconfig.json');
  const stageConfig = {
    extends: posix(path.relative(stageDirectory, project.configFile)),
    compilerOptions: {
      outDir: project.outDir,
      ...(project.rootDir === undefined ? {} : { rootDir: stageOf(project.rootDir) }),
      // Declarations follow the original, so the stage reports what the original reports. The real ones come from the check;
      // these go where nothing reads them.
      declaration: project.declaration,
      ...(project.declaration ? { declarationDir: path.join(project.buildDirectory, 'stage-declarations') } : {}),
      declarationMap: false,
      composite: false,
      noEmit: false,
      emitDeclarationOnly: false,
      noEmitOnError: false,
      ...(project.baseUrl === undefined ? {} : { baseUrl: stageOf(project.baseUrl) }),
      ...(project.paths === undefined ? {} : {
        paths: Object.fromEntries(Object.entries(project.paths).map(([pattern, targets]) => [pattern, targets.map(stageOf)])),
      }),
    },
    files: project.files.map((file) => posix(path.relative(root, file))),
    include: [],
    exclude: [],
  };
  atomicWrite(configFile, `${JSON.stringify(stageConfig, null, 2)}\n`);
  return { configFile, maps };
}

/** The emitted files the compiler listed (`--listEmittedFiles`), and its output without those lines. */
function emittedFiles(output: string): { readonly files: readonly string[]; readonly rest: string } {
  const files: string[] = [];
  const rest: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('TSFILE: ')) files.push(line.slice('TSFILE: '.length));
    else rest.push(line);
  }
  return { files, rest: rest.join('\n').trim() };
}

/**
 * Point a map the compiler wrote for a staged file at the original. A rewritten file's map is composed with the
 * applier's, so a position in the emitted JavaScript resolves to the original line and column.
 */
function remapSourceMap(mapFile: string, project: Project, maps: ReadonlyMap<string, SourceMapV3>): void {
  const stageDirectory = path.join(project.buildDirectory, 'stage');
  const emitted = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as SourceMapV3;
  const [source] = emitted.sources;
  if (emitted.sources.length !== 1 || source === undefined) return;
  const staged = path.resolve(path.dirname(mapFile), source);
  if (!contains(stageDirectory, staged)) return;
  const relative = posix(path.relative(stageDirectory, staged));
  const original = posix(path.relative(path.dirname(mapFile), path.join(project.root, relative)));
  const inner = maps.get(relative);
  const composed = inner ? composeSourceMaps(emitted, inner) : emitted;
  const { sourcesContent, ...kept } = composed;
  const remapped = {
    ...kept,
    sources: [original],
    // Keep embedded sources only when the compiler embedded them; they are the original text.
    ...(emitted.sourcesContent === undefined ? {} : { sourcesContent: inner ? inner.sourcesContent : sourcesContent }),
  };
  fs.writeFileSync(mapFile, JSON.stringify(remapped));
}

/** One build. `inputs` collects every file the build read, for a watching build to poll. */
async function buildOnce(session: ts.ProgramSession, configFile: string, golemConfig: { readonly file: string; readonly explicit: boolean }, inputs: Set<string>): Promise<number> {
  const root = path.dirname(configFile);
  const observe = (filename: string): void => { inputs.add(path.resolve(filename)); };
  observe(configFile);
  const cli = compilerCli(root);
  const parsed = session.parseConfigFile(configFile, observe);
  const project = readProject(configFile, parsed);
  const checkState = path.join(project.buildDirectory, 'check.tsbuildinfo');
  const emitState = path.join(project.buildDirectory, 'emit.tsbuildinfo');
  // The incremental state outlives the output: with the outDir gone, the compiler would find nothing to write.
  if (!project.noEmit && [project.outDir, project.declarationDir].some((directory) => directory !== undefined && !fs.existsSync(directory))) {
    fs.rmSync(checkState, { force: true });
    fs.rmSync(emitState, { force: true });
  }

  // The original sources are what the compiler checks; its output is the compiler's own.
  const check = await runTsc(cli, root, [
    '-p', configFile,
    '--incremental', '--tsBuildInfoFile', checkState,
    project.declaration && !project.noEmit ? '--emitDeclarationOnly' : '--noEmit',
  ], true);
  if (check.code !== 0) return check.code;
  if (!project.emitsJavaScript) return 0;

  using program = session.openProgram({ root, sources: parsed.fileNames, configFile, onInput: observe });
  const sources = program.getSourceFiles().filter((file) => !program.isSourceFileDefaultLibrary(file)
    && !program.isSourceFileFromExternalLibrary(file)
    && !file.fileName.split(/[\\/]/).includes('node_modules'));
  for (const source of sources) {
    observe(source.fileName);
    if (!contains(root, source.fileName)) {
      throw new Error(`golem build cannot stage ${source.fileName}: it is outside the project root ${root}. Move it under the root, or build the package that holds it with golem build -p.`);
    }
  }
  const scanned = scanRewrites({ root, program, checker: program.getTypeChecker(), nest: nestEnabled(root, golemConfig, observe) });
  const errors = scanned.diagnostics.filter((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error);
  if (errors.length > 0) throw scanFailure(errors);
  // The index belongs to the tsconfig `golem generate` resolves for this root; another tsconfig's build keeps its scan in memory.
  if (projectConfigFile(root, observe) === configFile) writeRewriteIndex(root, scanned.index);

  const stage = writeStage(project, sources, scanned.index);
  const emit = await runTsc(cli, root, [
    '-p', stage.configFile,
    '--noCheck', '--listEmittedFiles',
    '--incremental', '--tsBuildInfoFile', emitState,
  ], false);
  const { files, rest } = emittedFiles(emit.stdout);
  for (const file of files.filter((candidate) => /\.[cm]?jsx?\.map$/.test(candidate))) remapSourceMap(file, project, stage.maps);
  if (emit.code !== 0) {
    if (rest !== '') process.stdout.write(`${rest}\n`);
    process.stderr.write(emit.stderr);
  }
  return emit.code;
}

/** A directory's mtime moves when a file is added or removed in it, which is how a new source is noticed. */
function directorySignature(directory: string): string {
  const stat = fs.statSync(directory, { throwIfNoEntry: false });
  return stat === undefined ? 'missing' : String(stat.mtimeMs);
}

/** The directories above each input up to the root: a file added beside an input changes one of them. */
function watchedDirectories(root: string, inputs: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>();
  for (const input of inputs) {
    for (let directory = path.dirname(input); contains(root, directory) && !directories.has(directory); directory = path.dirname(directory)) {
      if (directory.split(path.sep).includes('node_modules') || directory === path.join(root, GOLEM_DIRECTORY)) break;
      directories.add(directory);
    }
  }
  return directories;
}

/**
 * Check the original sources of one tsconfig and emit the rewritten ones into its outDir. The project's own compiler
 * does both, incrementally. With `watch`, the build repeats when an input changes and ends on `signal`.
 */
export async function runBuild(options: BuildOptions): Promise<{ exitCode: number }> {
  const configFile = resolveProject(options.project);
  const root = path.dirname(configFile);
  const label = path.relative(process.cwd(), configFile) || configFile;
  using session = new ts.ProgramSession({ cwd: root });
  const golemConfig = { file: path.resolve(options.config ?? 'golem.yaml'), explicit: options.config !== undefined };
  const inputs = new Set<string>();
  const run = async (): Promise<number> => {
    const exitCode = await buildOnce(session, configFile, golemConfig, inputs);
    if (exitCode === 0) process.stdout.write(`Built ${label}.\n`);
    else if (options.watch) process.stdout.write('Build failed.\n');
    return exitCode;
  };
  if (!options.watch) return { exitCode: await run() };

  let exitCode = 0;
  let previous = new Map<string, string>();
  let directories = new Map<string, string>();
  const fingerprints = (): Map<string, string> => new Map([...inputs].map((input) => [input, signature(input)]));
  const attempt = async (): Promise<void> => {
    // Signatures from before the build, so an edit or a new file made during it starts the next build.
    const before = fingerprints();
    const directoriesBefore = new Map([...watchedDirectories(root, inputs)].map((directory) => [directory, directorySignature(directory)]));
    try {
      exitCode = await run();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    previous = new Map([...fingerprints()].map(([input, value]) => [input, before.get(input) ?? value]));
    directories = new Map([...watchedDirectories(root, inputs)].map((directory) => [directory, directoriesBefore.get(directory) ?? directorySignature(directory)]));
  };
  await attempt();
  process.stdout.write('Watching for changes.\n');
  await new Promise<void>((resolve) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      const changed = [...fingerprints()].filter(([input, value]) => previous.get(input) !== value).map(([input]) => input);
      const added = [...directories].some(([directory, value]) => directorySignature(directory) !== value);
      if (changed.length === 0 && !added) return;
      busy = true;
      session.inputsChanged(changed);
      void attempt().finally(() => { busy = false; if (options.signal?.aborted) { clearInterval(timer); resolve(); } });
    }, POLL_MS);
    const stop = (): void => { clearInterval(timer); if (!busy) resolve(); };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
  });
  return { exitCode };
}
