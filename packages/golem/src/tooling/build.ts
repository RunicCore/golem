import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalFile, contains, resolveConfig } from './config.js';
import type { GolemConfig } from './config.js';
import { GolemDiagnosticSeverity } from './generator-api.js';
import type { GolemDiagnostic } from './generator-api.js';
import { atomicWrite } from './outputs.js';
import type { RewriteIndex } from './rewrite.js';
import { applyIndexedRewrites } from './rewrite-host.js';
import { assertRewriteIndexOwner, scanRewrites, writeRewriteIndex } from './rewrite-scan.js';
import { composeSourceMaps } from './source-map.js';
import type { SourceMapV3 } from './source-map.js';
import * as ts from './typescript-ns.js';
import { resolveTypeScript } from './typescript-version.js';
import { signature } from './watch.js';

export interface BuildOptions {
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
}

export const NO_GOLEM_YAML = 'golem build needs a golem.yaml; run it next to one or pass --config';

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

/** The golem.yaml a build starts from. Nothing above the working directory is searched. */
function readGolemConfig(requested: string | undefined, observe: (filename: string) => void): GolemConfig {
  const file = path.resolve(requested ?? 'golem.yaml');
  observe(file);
  if (!fs.existsSync(file)) throw new Error(requested === undefined ? NO_GOLEM_YAML : `golem build cannot find ${file}.`);
  return resolveConfig(file, observe);
}

/** The tsconfig to build: the golem.yaml's own, or the alternate `-p` names beside it. */
function resolveProject(project: string | undefined, config: GolemConfig): string {
  if (project === undefined) {
    if (!fs.existsSync(config.tsconfig)) throw new Error(`golem build cannot find ${config.tsconfig}, the tsconfig ${config.configFile} names.`);
    return config.tsconfig;
  }
  const requested = path.resolve(project);
  const stat = fs.statSync(requested, { throwIfNoEntry: false });
  if (!stat) throw new Error(`golem build cannot find ${requested}.`);
  const configFile = canonicalFile(stat.isDirectory() ? path.join(requested, 'tsconfig.json') : requested);
  if (!fs.existsSync(configFile)) throw new Error(`golem build cannot find ${configFile}.`);
  if (path.dirname(configFile) !== path.dirname(config.tsconfig)) {
    throw new Error(`golem build -p ${project} must name a config in the same directory as ${config.tsconfig}, the tsconfig ${config.configFile} names.`);
  }
  return configFile;
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
    const rewritten = applyIndexedRewrites(relative, source.text, index);
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

/** The directories this build writes: the compiler's own output, where the incremental state would otherwise find nothing to do. */
function writtenDirectories(project: Project): Set<string> {
  if (project.noEmit) return new Set();
  return new Set([
    ...project.emitsJavaScript ? [project.outDir] : [],
    ...project.declaration ? [project.declarationDir ?? project.outDir] : [],
  ]);
}

/**
 * One build. `inputs` collects every file the build read, for a watching build to poll. `baselines`, for a watching build, takes
 * each file's signature when the build first reads it, which is the only baseline a file the build has not met before can have.
 */
async function buildOnce(session: ts.ProgramSession, request: { readonly project: string | undefined; readonly config: string | undefined }, inputs: Set<string>, outputs: Set<string>, baselines?: Map<string, string>): Promise<number> {
  const observe = (filename: string): void => {
    const file = path.resolve(filename);
    inputs.add(file);
    if (baselines !== undefined && !baselines.has(file)) baselines.set(file, signature(file));
  };
  const golemConfig = readGolemConfig(request.config, observe);
  const configFile = resolveProject(request.project, golemConfig);
  const root = path.dirname(configFile);
  observe(configFile);
  // The index belongs to the tsconfig the golem.yaml names, and to that yaml; another config of the directory keeps its scan in memory.
  // Every build of the directory answers to the owner, since its emit replaces the owner's output whether or not it writes the index.
  assertRewriteIndexOwner(root, golemConfig.configFile);
  const writesIndex = configFile === golemConfig.tsconfig;
  const cli = compilerCli(root);
  const parsed = session.parseConfigFile(configFile, observe);
  const project = readProject(configFile, parsed);
  // The sources are inputs from here on: a failed check ends the build before any later step reads them.
  for (const filename of parsed.fileNames) observe(filename);
  const checkState = path.join(project.buildDirectory, 'check.tsbuildinfo');
  const emitState = path.join(project.buildDirectory, 'emit.tsbuildinfo');
  outputs.clear();
  for (const directory of writtenDirectories(project)) outputs.add(directory);
  // The incremental state outlives the output: with a directory this build writes gone, the compiler would find nothing to write.
  if ([...outputs].some((directory) => !fs.existsSync(directory))) {
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
  const scanned = scanRewrites({ root, program, checker: program.getTypeChecker(), nest: golemConfig.jobs.some((job) => job.kind === 'controllers') });
  const errors = scanned.diagnostics.filter((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error);
  if (errors.length > 0) throw scanFailure(errors);
  if (writesIndex) writeRewriteIndex(root, scanned.index, golemConfig.configFile);

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

/**
 * The names in a directory, without the build's own: what a watching build compares to notice a source that was added or
 * removed. Its output and state directories come and go with the build itself, which is no reason to build again.
 */
function directorySignature(directory: string, ownDirectories: ReadonlySet<string>): string {
  try {
    return fs.readdirSync(directory).filter((name) => !ownDirectories.has(path.join(directory, name))).sort().join('\n');
  } catch {
    return 'missing';
  }
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

/** The build's own directories: `.golem`, every directory it writes, and the directories between the root and those. */
function ownDirectories(root: string, outputs: ReadonlySet<string>): Set<string> {
  const own = new Set([path.join(root, GOLEM_DIRECTORY)]);
  for (const output of outputs) {
    for (let directory = output; contains(root, directory) && directory !== root; directory = path.dirname(directory)) own.add(directory);
  }
  return own;
}

/**
 * Check the original sources of the golem.yaml's tsconfig and emit the rewritten ones into its outDir. The project's own
 * compiler does both, incrementally. With `watch`, the build repeats when an input changes and ends on `signal`.
 */
export async function runBuild(options: BuildOptions): Promise<{ exitCode: number }> {
  const request = { project: options.project, config: options.config };
  const first = readGolemConfig(options.config, () => {});
  const root = path.dirname(first.tsconfig);
  const label = path.relative(process.cwd(), options.project === undefined ? first.tsconfig : path.resolve(options.project)) || first.tsconfig;
  using session = new ts.ProgramSession({ cwd: root });
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  const outputsPresent = (): boolean => [...outputs].every((directory) => fs.existsSync(directory));
  // Whether the directories the build writes existed when it ended: one that vanishes afterwards, such as a deleted outDir, is rebuilt once.
  // Taken before "Built" is printed, so a deletion that follows that line is seen.
  let wrote = true;
  const baselines = options.watch ? new Map<string, string>() : undefined;
  const run = async (beforeAnnouncing: () => void = () => {}): Promise<number> => {
    const exitCode = await buildOnce(session, request, inputs, outputs, baselines);
    wrote = exitCode === 0 && outputsPresent();
    // The watch baseline is recorded before the build is announced: whoever reacts to the announcement may edit a source at once.
    beforeAnnouncing();
    if (exitCode === 0) process.stdout.write(`Built ${label}.\n`);
    else if (options.watch) process.stdout.write('Build failed.\n');
    return exitCode;
  };
  if (!options.watch) return { exitCode: await run() };

  let exitCode = 0;
  let previous = new Map<string, string>();
  let directories = new Map<string, string>();
  const fingerprints = (): Map<string, string> => new Map([...inputs].map((input) => [input, signature(input)]));
  const directorySignatures = (): Map<string, string> => {
    const own = ownDirectories(root, outputs);
    return new Map([...watchedDirectories(root, inputs)].map((directory) => [directory, directorySignature(directory, own)]));
  };
  const attempt = async (): Promise<void> => {
    // Signatures from before the build, so an edit or a new file made during it starts the next build. The first build has no
    // inputs yet: its files carry the signature they had when the build first read them.
    const before = fingerprints();
    const directoriesBefore = directorySignatures();
    baselines?.clear();
    const record = (): void => {
      previous = new Map([...fingerprints()].map(([input, value]) => [input, before.get(input) ?? baselines?.get(input) ?? value]));
      directories = new Map([...directorySignatures()].map(([directory, value]) => [directory, directoriesBefore.get(directory) ?? value]));
    };
    try {
      exitCode = await run(record);
    } catch (error) {
      exitCode = 1;
      wrote = false;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      record();
    }
  };
  await attempt();
  process.stdout.write('Watching for changes.\n');
  await new Promise<void>((resolve) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      const changed = [...fingerprints()].filter(([input, value]) => previous.get(input) !== value).map(([input]) => input);
      const own = ownDirectories(root, outputs);
      const added = [...directories].some(([directory, value]) => directorySignature(directory, own) !== value);
      if (changed.length === 0 && !added && !(wrote && !outputsPresent())) return;
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
