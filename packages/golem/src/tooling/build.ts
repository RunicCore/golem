import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalFile, modelsRootOf, resolveConfig } from './config.js';
import type { GolemConfig } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import { GolemDiagnosticSeverity, isInsideDirectory, isRecord } from './generator-api.js';
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
import { requestTypeScriptRoot, selectedTypeScript } from './typescript-selection.js';
import { changedPaths, InputPoller, ownDirectories, RunBaseline } from './input-poller.js';

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
  /** Every argument golem build does not take itself: both compiler runs get them unchanged. */
  readonly tscArguments?: readonly string[];
  /** Called after the generate step of each build with the ids of the jobs that executed; a job its record showed to be current is not among them. */
  readonly onGenerated?: (ran: ReadonlySet<string>) => void;
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

/** Fail on a configuration the staged copy cannot mirror: the tsconfig's, with the forwarded arguments applied. It reads options alone, so it runs before anything is generated. */
function assertSupported(configFile: string, parsed: { readonly options: ts.CompilerOptions; readonly fileNames: readonly string[] }, effective: EffectiveOptions): void {
  const { options } = parsed;
  const unsupported = (what: string): Error => new Error(`golem build does not support ${what} (${configFile}).`);
  if (parsed.fileNames.length === 0) {
    throw new Error(`${configFile} includes no files. golem build builds one project and does not follow project references; run golem build -p <tsconfig> per project.`);
  }
  if (!effective.outDir) throw new Error(`golem build requires compilerOptions.outDir in ${configFile}: it emits the rewritten sources there.`);
  if (effective.outFile) throw unsupported('outFile');
  if (Array.isArray(options.rootDirs)) throw unsupported('rootDirs');
  if (effective.inlineSourceMap) throw unsupported('inlineSourceMap');
  if (effective.sourceRoot) throw unsupported('sourceRoot');
}

/** Read the build settings from a configuration `assertSupported` accepted. */
function readProject(configFile: string, parsed: { readonly options: ts.CompilerOptions; readonly fileNames: readonly string[] }, effective: EffectiveOptions): Project {
  const { options } = parsed;
  const root = path.dirname(configFile);
  const outDir = stringOption(options, 'outDir');
  if (outDir === undefined) throw new Error(`golem build requires compilerOptions.outDir in ${configFile}: it emits the rewritten sources there.`);
  const rootDir = stringOption(options, 'rootDir');
  const baseUrl = stringOption(options, 'baseUrl');
  const declarationDir = stringOption(options, 'declarationDir');
  const paths = pathsOption(options);
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
    declaration: effective.declaration,
    emitsJavaScript: emitsJavaScript(options),
    noEmit,
    noEmitOnError: effective.noEmitOnError,
  };
}

/** Each `paths` target as an absolute path: the staged copy is elsewhere, so a target relative to the original config would reach the originals. */
function rebasePaths(paths: Readonly<Record<string, readonly string[]>>, base: string): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(paths).map(([pattern, targets]) => [pattern, targets.map((target) => posix(path.resolve(base, target)))]));
}

/** The compiler CLI of the TypeScript the seam loaded: a project on a different install would check with one compiler and emit with another. */
function compilerCli(root: string): string {
  requestTypeScriptRoot(root);
  return path.join(selectedTypeScript().packageDir, 'bin', 'tsc');
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
 * The options the build's decisions depend on, as the compiler resolves them from the tsconfig and the forwarded arguments. The
 * path options are whether they are set: the staged copy handles their values itself.
 */
interface EffectiveOptions {
  readonly declaration: boolean;
  readonly noEmitOnError: boolean;
  readonly outDir: boolean;
  readonly outFile: boolean;
  readonly inlineSourceMap: boolean;
  readonly sourceRoot: boolean;
}

function effectiveOf(options: ts.CompilerOptions): EffectiveOptions {
  return {
    declaration: options.declaration === true || options.composite === true,
    noEmitOnError: options.noEmitOnError === true,
    outDir: stringOption(options, 'outDir') !== undefined,
    outFile: stringOption(options, 'outFile') !== undefined,
    inlineSourceMap: options.inlineSourceMap === true,
    sourceRoot: stringOption(options, 'sourceRoot') !== undefined,
  };
}

/** The options `tsc --showConfig` printed. Output that is not a configuration cannot say what the forwarded arguments changed, so it fails. */
export function shownOptions(stdout: string, configFile: string, tscArguments: readonly string[]): EffectiveOptions {
  let shown: unknown;
  try {
    shown = JSON.parse(stdout);
  } catch {
    shown = undefined;
  }
  if (!isRecord(shown)) {
    throw new Error(`golem build cannot read what tsc --showConfig printed for ${configFile} with ${tscArguments.join(' ')}: ${stdout.trim() || 'nothing'}. Run tsc -p ${configFile} ${tscArguments.join(' ')} --showConfig to see it.`);
  }
  return effectiveOf(isRecord(shown.compilerOptions) ? shown.compilerOptions : {});
}

/**
 * Forwarded arguments can change what the tsconfig says, and only the compiler's own parser knows how: `tsc --showConfig` prints the
 * configuration it resolved. Without forwarded arguments the tsconfig is the answer, and the compiler is not asked. An argument the
 * compiler rejects leaves the tsconfig's answer; the check run reports the compiler's own message.
 */
async function effectiveOptions(cli: string, root: string, configFile: string, parsed: ts.CompilerOptions, tscArguments: readonly string[]): Promise<EffectiveOptions> {
  if (tscArguments.length === 0) return effectiveOf(parsed);
  const shown = await runTsc(cli, root, ['-p', configFile, ...tscArguments, '--showConfig'], false);
  if (shown.code !== 0) return effectiveOf(parsed);
  return shownOptions(shown.stdout, configFile, tscArguments);
}

function scanFailure(errors: readonly GolemDiagnostic[]): Error {
  const location = (diagnostic: GolemDiagnostic): string => (diagnostic.file === undefined ? '' : ` (${diagnostic.file}${diagnostic.line === undefined ? '' : `:${diagnostic.line}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`})`);
  return new Error([
    `golem rewrite scan reported ${errors.length} error diagnostic${errors.length === 1 ? '' : 's'}:`,
    ...errors.map((diagnostic) => `  ${diagnostic.code}${location(diagnostic)}: ${diagnostic.message}`),
  ].join('\n'));
}

/** The stage's own guard: nothing is written, linked or removed outside the stage directory, whatever computed the path. */
function insideStage(stageDirectory: string, target: string): string {
  if (!isInsideDirectory(stageDirectory, target)) throw new Error(`golem build would change ${target}, which is outside its stage ${stageDirectory}.`);
  return target;
}

/** The deepest directory that holds every one of `directories`. */
function commonDirectory(directories: readonly string[]): string {
  const [first, ...others] = directories.map((directory) => path.resolve(directory).split(path.sep));
  if (first === undefined) throw new Error('golem build has no directory to stage from.');
  let length = first.length;
  for (const other of others) {
    let shared = 0;
    while (shared < length && shared < other.length && other[shared] === first[shared]) shared += 1;
    length = shared;
  }
  if (length === 0) throw new Error(`golem build cannot stage sources that share no directory: ${directories.join(', ')}.`);
  return path.resolve(`${first.slice(0, length).join(path.sep)}${path.sep}`);
}

/**
 * The directory the compiler writes outputs relative to: the common directory of the tsconfig's directory, the `rootDir` and every source.
 * With a `rootDir` the output layout starts at that directory instead.
 */
function sourceBase(project: Project, sources: readonly ts.SourceFile[]): string {
  return commonDirectory([project.root, ...sources.map((source) => path.dirname(source.fileName)), ...project.rootDir === undefined ? [] : [project.rootDir]]);
}

/** The `package.json` that governs `directory`: its own, or the nearest one above. */
function nearestManifest(directory: string): string | undefined {
  for (let current = directory; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}

/** Delete staged files whose source left the program. A link is removed as itself and never entered: its target is not the stage's. */
function pruneStage(stageDirectory: string, keep: ReadonlySet<string>): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filename);
        if (fs.readdirSync(filename).length === 0) fs.rmdirSync(insideStage(stageDirectory, filename));
      } else if (!keep.has(posix(path.relative(stageDirectory, filename)))) fs.unlinkSync(insideStage(stageDirectory, filename));
    }
  };
  if (fs.existsSync(stageDirectory)) visit(stageDirectory);
}

/** Point `link` at the directory `target`, replacing a link that points elsewhere. Anything at `link` that is not a link is a fault. */
function linkDirectory(stageDirectory: string, link: string, target: string): void {
  insideStage(stageDirectory, link);
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) throw new Error(`golem build found ${link} in its stage, where it links ${target}, and it is not a link.`);
    if (fs.realpathSync(link) === target) return;
    fs.unlinkSync(link);
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
}

interface StageResult {
  readonly configFile: string;
  readonly directory: string;
  /** The original directory the stage mirrors: a staged file's path under the stage is its path under this one. */
  readonly base: string;
  /** The applier's map for each rewritten file, keyed by its path under the base. */
  readonly maps: ReadonlyMap<string, SourceMapV3>;
  /** The original `package.json` files the stage holds a copy of. */
  readonly manifests: readonly string[];
}

/**
 * Mirror the program's local sources into `<root>/.golem/build/<config name>/stage`: the rewritten text for a file with a site to rewrite or a specifier to change, the file itself
 * otherwise. A file is written only when its content differs, so the compiler's incremental state keeps every other file.
 * The stage mirrors the common directory of the tsconfig's directory and every source, as the compiler's own source root is, so a source
 * outside the tsconfig's directory lands in the output where the compiler would put it. A mirrored directory holds a copy of its original's `package.json`
 * and a link to its `node_modules`, so a staged file resolves packages, `type` and `exports` as the original does.
 */
function writeStage(project: Project, sources: readonly ts.SourceFile[], rewrites: ReadonlyMap<string, FileRewrite>): StageResult {
  const { root } = project;
  const stageDirectory = path.join(project.buildDirectory, 'stage');
  const base = sourceBase(project, sources);
  const stagePath = (original: string): string => insideStage(stageDirectory, path.join(stageDirectory, path.relative(base, original)));
  const keyOf = (original: string): string => posix(path.relative(base, original));
  const maps = new Map<string, SourceMapV3>();
  const manifests: string[] = [];
  const keep = new Set<string>(['tsconfig.json']);
  for (const source of sources) {
    const key = keyOf(source.fileName);
    const rewrite = rewrites.get(posix(path.relative(root, source.fileName)));
    const rewritten = rewrite && applyRewrites(source.text, rewrite, key);
    if (rewritten) maps.set(key, rewritten.map);
    atomicWrite(stagePath(source.fileName), rewritten?.code ?? source.text);
    keep.add(key);
  }

  const mirrored = new Set<string>([base]);
  for (const source of sources) {
    for (let directory = path.dirname(source.fileName); !mirrored.has(directory); directory = path.dirname(directory)) mirrored.add(directory);
  }
  for (const directory of mirrored) {
    // Above the base the stage reaches the project's own files, not the original's: the base holds the manifest that governs it.
    const manifest = directory === base && base !== root ? nearestManifest(base) : fs.existsSync(path.join(directory, 'package.json')) ? path.join(directory, 'package.json') : undefined;
    const staged = stagePath(path.join(directory, 'package.json'));
    if (manifest !== undefined) {
      atomicWrite(staged, fs.readFileSync(manifest, 'utf8'));
      manifests.push(manifest);
      keep.add(keyOf(path.join(directory, 'package.json')));
    } else if (directory === base && base !== root) {
      atomicWrite(staged, '{}\n');
      keep.add(keyOf(path.join(directory, 'package.json')));
    }
    const modules = path.join(directory, 'node_modules');
    if (fs.statSync(modules, { throwIfNoEntry: false })?.isDirectory()) {
      linkDirectory(stageDirectory, stagePath(modules), fs.realpathSync(modules));
      keep.add(keyOf(modules));
    }
  }
  pruneStage(stageDirectory, keep);

  const stageOf = (absolute: string): string => (isInsideDirectory(base, absolute) ? posix(stagePath(absolute)) : absolute);
  const configFile = path.join(stageDirectory, 'tsconfig.json');
  const stageConfig = {
    extends: posix(path.relative(stageDirectory, project.configFile)),
    compilerOptions: {
      outDir: project.outDir,
      ...(project.rootDir === undefined ? {} : { rootDir: stageOf(project.rootDir) }),
      // The stage's text has the calls rewritten, so its types differ from the original's: the declarations come from the check.
      declaration: false,
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
    files: project.files.map((file) => keyOf(file)),
    include: [],
    exclude: [],
  };
  atomicWrite(insideStage(stageDirectory, configFile), `${JSON.stringify(stageConfig, null, 2)}\n`);
  return { configFile, directory: stageDirectory, base, maps, manifests };
}

/**
 * The scanner's rewrites with the edits that give each import specifier of a staged source the text Node loads as ESM. An import
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
 * Give the declarations the check wrote from the original sources the import paths Node resolves, as the emitted JavaScript has
 * them (`nodeSpecifierEdits`): a NodeNext consumer reads these files. A declaration's text is read as a module beside its source, so
 * a specifier resolves from where the source's own does, and the edits apply to the declaration. A declaration that needs no edit
 * is not written, so the incremental state of the check keeps it.
 */
function rewriteDeclarations(session: ts.ProgramSession, project: Project, sources: readonly ts.SourceFile[], rootNames: readonly string[]): void {
  const layoutRoot = project.rootDir ?? sourceBase(project, sources);
  const directory = project.declarationDir ?? project.outDir;
  const declarations = new Map<string, { readonly file: string; readonly text: string }>();
  for (const source of sources.filter((candidate) => !candidate.isDeclarationFile)) {
    const extension = Object.keys(DECLARATION_FILES).find((candidate) => source.fileName.endsWith(candidate));
    if (extension === undefined) continue;
    const kind = DECLARATION_FILES[extension]!;
    const stem = source.fileName.slice(0, source.fileName.length - extension.length);
    const file = path.join(directory, `${path.relative(layoutRoot, stem)}${kind.declaration}`);
    const text = fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(file, 'utf8') : undefined;
    if (text !== undefined) declarations.set(`${stem}.golem-declaration${kind.module}`, { file, text });
  }
  if (declarations.size === 0) return;
  const overlays = new Map([...declarations].map(([module, { text }]) => [module, text]));
  using program = session.openProgram({ root: project.root, sources: [...rootNames, ...overlays.keys()], configFile: project.configFile, overlays });
  const checker = program.getTypeChecker();
  const options = { compilerOptions: program.getCompilerOptions(), projectSources: new Set(sources.map((source) => source.fileName)) };
  for (const [module, { file, text }] of declarations) {
    const declaration = program.getSourceFile(module);
    if (declaration === undefined) throw new Error(`golem build could not read the declaration ${file} to change its import paths.`);
    const { edits } = nodeSpecifierEdits(declaration, checker, options);
    if (edits.length > 0) atomicWrite(file, applyRewrites(text, { edits, imports: [] }, file).code);
  }
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
function remapSourceMap(mapFile: string, stage: StageResult): void {
  const emitted = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as SourceMapV3;
  const [source] = emitted.sources;
  if (emitted.sources.length !== 1 || source === undefined) return;
  const staged = path.resolve(path.dirname(mapFile), source);
  if (!isInsideDirectory(stage.directory, staged)) return;
  const relative = posix(path.relative(stage.directory, staged));
  const original = posix(path.relative(path.dirname(mapFile), path.join(stage.base, relative)));
  const inner = stage.maps.get(relative);
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

/** What one build and the builds after it share: the files a watching build polls, and the generate step's state. */
interface BuildRun {
  readonly project: string | undefined;
  readonly config: string | undefined;
  readonly tscArguments: readonly string[];
  /** Every file the build read, for a watching build to poll. */
  readonly inputs: Set<string>;
  readonly outputs: Set<string>;
  /** The files the generate step wrote or kept. Generating one is the build's own doing, so it is no change to watch for. */
  readonly owned: Set<string>;
  /** The directories that hold the program's sources outside the tsconfig's directory: a source added beside one is a change to build for. */
  readonly outsideDirectories: Set<string>;
  /** For a watching build, what the build reads first and what it was then: the only baseline a file the build has not met before can have. */
  baseline?: RunBaseline;
  readonly generation: GeneratorSessionResources;
  readonly onGenerated?: (ran: ReadonlySet<string>) => void;
  /** The last generate run that finished: the next run reruns only the jobs a changed input reaches. Empty after a failed run. */
  pipeline?: PipelineState;
}

/** One build: generate, check the original sources, emit the rewritten ones. `changed` are the inputs that changed since the build before. */
async function buildOnce(session: ts.ProgramSession, run: BuildRun, changed?: readonly string[]): Promise<number> {
  const { inputs, outputs, outsideDirectories } = run;
  const observe = (filename: string): void => {
    const file = path.resolve(filename);
    inputs.add(file);
    run.baseline?.observe(file);
  };
  const golemConfig = readGolemConfig(run.config, observe);
  const configFile = resolveProject(run.project, golemConfig);
  const root = path.dirname(configFile);
  observe(configFile);
  const cli = compilerCli(root);
  // A configuration the build cannot mirror, with the forwarded arguments applied, fails before anything is generated.
  const configured = session.parseConfigFile(configFile, observe);
  const effective = await effectiveOptions(cli, root, configFile, configured.options, run.tscArguments);
  assertSupported(configFile, configured, effective);
  // The generated files are part of the program the next steps read, so they are written first. A job whose inputs did not change is skipped.
  const previous = run.pipeline;
  run.pipeline = undefined;
  // The compiler output is this build's own: a job that lists the project must not see it change.
  const ignoredDirectories = [stringOption(configured.options, 'outDir'), stringOption(configured.options, 'declarationDir')].filter((directory) => directory !== undefined);
  const generated = await runPipeline(golemConfig.configFile, { session: run.generation, onInput: observe, ignoredDirectories, ...(previous === undefined || changed === undefined ? {} : { previous, changedInputs: changed }) });
  for (const output of generated.owned) run.owned.add(output);
  // The compiler session knows only the changes it was told about.
  if (generated.ran.size > 0) session.inputsChanged(generated.owned);
  run.pipeline = generated;
  run.onGenerated?.(generated.ran);
  const parsed = session.parseConfigFile(configFile, observe);
  const project = readProject(configFile, parsed, effective);
  // The sources are inputs from here on: a failed check ends the build before any later step reads them.
  outsideDirectories.clear();
  const observeSource = (filename: string): void => {
    observe(filename);
    if (!isInsideDirectory(root, filename)) {
      outsideDirectories.add(path.dirname(filename));
      run.baseline?.observeFolder(path.dirname(filename));
    }
  };
  for (const filename of parsed.fileNames) observeSource(filename);
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
    ...run.tscArguments,
  ], true);
  // Like the compiler: a failed check still emits unless noEmitOnError is set, and the exit status stays the check's.
  if (check.code !== 0 && project.noEmitOnError) return check.code;
  const writesDeclarations = project.declaration && !project.noEmit;
  if (!project.emitsJavaScript && !writesDeclarations) return check.code;

  using program = session.openProgram({ root, sources: parsed.fileNames, configFile, onInput: observe });
  const sources = projectSources(program);
  for (const source of sources) observeSource(source.fileName);
  if (writesDeclarations) rewriteDeclarations(session, project, sources, parsed.fileNames);
  if (!project.emitsJavaScript) return check.code;
  const checker = program.getTypeChecker();
  const models = golemConfig.jobs.find((job) => job.kind === 'models');
  const scanned = new RewriteScanner({ root, directory: golemConfig.directory, modelsRoot: modelsRootOf(golemConfig), suffixes: models?.options.suffixes, output: models?.options.output, program, checker, codecKeysFile: codecKeysPath(golemConfig.directory), nest: golemConfig.jobs.some((job) => job.kind === 'controllers'), nonModelInputs: golemConfig.nonModelInputs })
    .scanFiles(sources.map((source) => source.fileName));
  const errors = scanned.diagnostics.filter((diagnostic) => diagnostic.severity === GolemDiagnosticSeverity.Error);
  if (errors.length > 0) throw scanFailure(errors);
  for (const warning of scanned.diagnostics) {
    if (warning.severity === GolemDiagnosticSeverity.Warning) process.stderr.write(`${warning.code} (${warning.file}:${warning.line}:${warning.column}): ${warning.message}\n`);
  }

  const stage = writeStage(project, sources, withNodeSpecifiers(root, sources, checker, program.getCompilerOptions(), scanned.files));
  // The stage holds copies of these: a change to one is a change to build for.
  for (const manifest of stage.manifests) observe(manifest);
  const emit = await runTsc(cli, root, [
    '-p', stage.configFile,
    '--noCheck', '--listEmittedFiles',
    '--incremental', '--tsBuildInfoFile', emitState,
    ...run.tscArguments,
    // A forwarded --declaration or --declarationMap beats the stage's configuration: the emit run writes JavaScript alone.
    '--declaration', 'false', '--declarationMap', 'false',
  ], false);
  const { files, rest } = emittedFiles(emit.stdout);
  for (const file of files.filter((candidate) => /\.[cm]?jsx?\.map$/.test(candidate))) remapSourceMap(file, stage);
  // After a failed check the compiler already reported what the emit run would report.
  if (emit.code !== 0 && check.code === 0) {
    if (rest !== '') process.stdout.write(`${rest}\n`);
    process.stderr.write(emit.stderr);
  }
  return check.code !== 0 ? check.code : emit.code;
}

/**
 * Generate the golem.yaml's code, check the original sources of its tsconfig and emit the rewritten ones into its outDir. The project's
 * own compiler does both, incrementally. With `watch`, the build repeats when an input changes and ends on `signal`.
 */
export async function runBuild(options: BuildOptions): Promise<{ exitCode: number }> {
  const first = readGolemConfig(options.config, () => {});
  const root = path.dirname(first.tsconfig);
  const label = path.relative(process.cwd(), options.project === undefined ? first.tsconfig : path.resolve(options.project)) || first.tsconfig;
  using session = new ts.ProgramSession({ cwd: root });
  using generation = new GeneratorSessionResources();
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  const outputsPresent = (): boolean => [...outputs].every((directory) => fs.existsSync(directory));
  // Whether the directories the build writes existed when it ended: one that vanishes afterwards, such as a deleted outDir, is rebuilt once.
  // Taken before "Built" is printed, so a deletion that follows that line is seen.
  let wrote = true;
  const state: BuildRun = {
    project: options.project,
    config: options.config,
    tscArguments: options.tscArguments ?? [],
    inputs,
    outputs,
    owned: new Set<string>(),
    outsideDirectories: new Set<string>(),
    generation,
    ...(options.onGenerated === undefined ? {} : { onGenerated: options.onGenerated }),
  };
  const run = async (changed?: readonly string[], beforeAnnouncing: () => void = () => {}): Promise<number> => {
    const exitCode = await buildOnce(session, state, changed);
    wrote = exitCode === 0 && outputsPresent();
    // The watch baseline is recorded before the build is announced: whoever reacts to the announcement may edit a source at once.
    beforeAnnouncing();
    if (exitCode === 0) process.stdout.write(`Built ${label}.\n`);
    else if (options.watch) process.stdout.write('Build failed.\n');
    return exitCode;
  };
  if (!options.watch) return { exitCode: await run() };

  let exitCode = 0;
  const pollerOf = (): InputPoller => new InputPoller(inputs, { root, outsideDirectories: state.outsideDirectories });
  // The build's own names, which come and go with the build itself: the directories it writes and the files it generates.
  const ownership = (): ((filename: string) => boolean) => {
    const own = ownDirectories(root, outputs);
    return (filename) => own.has(filename) || state.owned.has(filename);
  };
  let poller = pollerOf();
  let previous = poller.snapshot();
  const attempt = async (changed: readonly string[] | undefined, before = poller.snapshot()): Promise<void> => {
    // The poll from before the build, so an edit or a new file made during it starts the next build. The first build has no
    // inputs yet: its files carry the signature they had when the build first read them.
    const baseline = new RunBaseline(before, root);
    state.baseline = baseline;
    const record = (): void => {
      // A file the generate step wrote is the build's own: its signature after the build is the one the next build compares with.
      poller = pollerOf();
      previous = baseline.settle(poller.snapshot(), (file) => state.owned.has(file));
    };
    try {
      exitCode = await run(changed, record);
    } catch (error) {
      exitCode = 1;
      wrote = false;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.stdout.write('Build failed.\n');
      record();
    }
  };
  await attempt(undefined);
  process.stdout.write('Watching for changes.\n');
  await new Promise<void>((resolve) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      const current = poller.snapshot();
      const changed = changedPaths(previous, current, ownership());
      if (changed.length === 0 && !(wrote && !outputsPresent())) return;
      busy = true;
      session.inputsChanged(changed);
      void attempt(changed, current).finally(() => { busy = false; if (options.signal?.aborted) { clearInterval(timer); resolve(); } });
    }, POLL_MS);
    const stop = (): void => { clearInterval(timer); if (!busy) resolve(); };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
  });
  return { exitCode };
}
