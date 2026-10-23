
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import * as ts from '../typescript-ns.js';
import { readManifest } from './package-specifier.js';
import { DEFAULT_MODEL_SUFFIXES, GolemDiagnosticSeverity, canonicalPath, compareText, discoverSources, hasErrorCode, isInsideDirectory, parseYamlFile, suffixPattern, YamlFileError, type GeneratorSession, type GolemDiagnostic, type InputObserver } from '../generator-api.js';
import { canonicalFilename } from './path-identity.js';

export { canonicalFilename };

export interface ProgramInfo {
  readonly configPath?: string;
  /** The referenced project that holds the sources when `configPath` is a solution tsconfig; the program opens from it. */
  readonly referencedConfigPath?: string;
  readonly projectFiles: readonly string[];
  readonly ambientFiles: readonly string[];
  readonly options: ts.CompilerOptions;
  readonly rootNames: readonly string[];
  readonly program: ts.Program;
  readonly host: ts.CompilerHost;
}

/**
 * Stable source identity used in generated metadata.  Absolute paths are
 * useful while resolving a program but would make generated output depend on
 * the checkout directory.  Keep the first portable workspace boundary and
 * discard the machine-specific prefix.
 */
export function portableRelativeFilename(filename: string, root: string): string {
  return relative(canonicalFilename(root), canonicalFilename(filename)).replace(/\\/g, '/');
}

/** Find a stable project root when a direct generator root is unavailable. */
export function commonDirectory(filenames: readonly string[]): string {
  if (filenames.length === 0) return canonicalFilename('.');
  let current = dirname(canonicalFilename(filenames[0]));
  for (const filename of filenames.slice(1)) {
    const directory = dirname(canonicalFilename(filename));
    while (!isInsideDirectory(current, directory)) {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return current;
}

export function assertAbsolute(filename: string, label: string): string {
  if (!pathIsAbsolute(filename)) throw new TypeError(`${label} must be an absolute path.`);
  return canonicalFilename(filename);
}

function pathIsAbsolute(filename: string): boolean {
  return parse(filename).root.length > 0;
}

/** A TypeScript file, a declaration file included, that is not a generated companion: what a model file can be. */
export function isModelSource(filename: string): boolean {
  return /\.[cm]?ts$/.test(filename) && !isGeneratedCompanion(filename);
}

export function discoverModelSources(
  root = process.cwd(),
  onInput?: InputObserver,
  suffixes: readonly string[] = DEFAULT_MODEL_SUFFIXES,
): string[] {
  return discoverSources(join(root, 'src'), { source: suffixPattern(suffixes), normalize: canonicalFilename, onInput });
}

/** `suffixes` and their declaration forms: `x.model.d.ts`, `x.model.d.cts` and `x.model.d.mts` are model files as `x.model.ts` is. */
function modelFilePattern(suffixes: readonly string[]): RegExp {
  return suffixPattern([...suffixes, ...suffixes.flatMap((suffix) => ['ts', 'cts', 'mts'].map((extension) => suffix.replace(/\.[cm]?ts$/, `.d.${extension}`)))]);
}

/**
 * The model files among `files`: those that end in a model suffix, or in its declaration form, and are not generated
 * companions. Pass the files of the project's program, which are the files the tsconfig includes and the files they import.
 * Which of them are the job's own is `isOwnModelFile`'s answer.
 */
export function includedModelSources(files: readonly string[], suffixes: readonly string[]): string[] {
  const pattern = modelFilePattern(suffixes);
  return uniqueFilenames(files)
    .filter((filename) => pattern.test(filename) && !isGeneratedCompanion(filename))
    .sort(compareText);
}

/** `files` without a second name for one file: a file reached through a folder link counts once, by its real path when the program holds it. */
export function byRealPath(files: readonly string[]): string[] {
  const byReal = new Map<string, string>();
  for (const file of files) {
    const real = canonicalPath(file);
    if (!byReal.has(real) || file === real) byReal.set(real, file);
  }
  return [...byReal.values()];
}

/** What decides which files are the own model sources of one models job. */
export interface ModelBoundary {
  /** The real path of `models.root`. */
  readonly root: string;
  /** The file-name endings that make a file a model file. */
  readonly suffixes: readonly string[];
  /** Where the companion of a shared file goes. Without it every companion is beside its model file. */
  readonly companions?: {
    /** The real path of the directory of the golem.yaml: the search for a shared file's package folder stops there. */
    readonly directory: string;
    /** `models.output`. */
    readonly output: string;
  };
}

export function modelBoundary(modelsRoot: string, suffixes: readonly string[] = DEFAULT_MODEL_SUFFIXES, companions?: { readonly directory: string; readonly output: string }): ModelBoundary {
  return { root: canonicalPath(modelsRoot), suffixes, ...(companions ? { companions: { directory: canonicalPath(companions.directory), output: canonicalFilename(companions.output) } } : {}) };
}

/** Whether `filename` is a model file by name. */
export function isModelFileName(boundary: Pick<ModelBoundary, 'suffixes'>, filename: string): boolean {
  return modelFilePattern(boundary.suffixes).test(basename(filename));
}

/**
 * Whether the models job of `boundary` owns `filename` as a model source: its real path is inside the models root, no folder
 * between the root and the file is `node_modules`, and it is not a declaration file. The job writes the file's generated
 * companion beside it. Any other model file is a shared file: it is the type definition of a shared folder or package.
 */
export function isOwnModelFile(boundary: ModelBoundary, filename: string): boolean {
  const real = canonicalPath(filename);
  return isInsideDirectory(boundary.root, real)
    && !relative(boundary.root, real).split(sep).includes('node_modules')
    && !isAmbientDeclaration(real);
}

/**
 * The golem.yaml files of other models jobs below the root that cover one of `files`, sorted. A file is covered when such a
 * yaml lies in the file's directory or in a directory above it, up to the root. The walk stops at the directory of this
 * job's own golem.yaml: that one and every one above it is never another job. The answer for a directory is read once.
 */
export function nestedModelsJobs(root: string, own: string, files: readonly string[], onInput?: InputObserver): string[] {
  const hasModelsJob = new Map<string, boolean>();
  const directoryHasModelsJob = (directory: string): boolean => {
    const known = hasModelsJob.get(directory);
    if (known !== undefined) return known;
    const found = declaresModelsJob(join(directory, 'golem.yaml'), onInput);
    hasModelsJob.set(directory, found);
    return found;
  };
  const found = new Set<string>();
  for (const file of files) {
    for (let directory = dirname(canonicalPath(file)); isInsideDirectory(root, directory); directory = dirname(directory)) {
      if (directory === own || own.startsWith(`${directory}${sep}`)) break;
      if (directoryHasModelsJob(directory)) found.add(join(directory, 'golem.yaml'));
      if (directory === root || dirname(directory) === directory) break;
    }
  }
  return [...found].sort();
}

/** The job keys of a golem.yaml: a file with one of them configures an app. */
const JOB_KEYS = ['generators', 'controllers', 'openapi', 'models'] as const;

/** The parsed `golemYaml`, or undefined when it does not exist. Throws the parse error or the file-read error. */
function readGolemYaml(golemYaml: string, onInput?: InputObserver): unknown {
  onInput?.(golemYaml);
  if (!existsSync(golemYaml)) return undefined;
  return parseYamlFile(readFileSync(golemYaml, 'utf8'), golemYaml);
}

/** Whether `configuration` has a value under one of `keys`. */
function declaresAny(configuration: unknown, keys: readonly string[]): boolean {
  return typeof configuration === 'object' && configuration !== null
    && keys.some((key) => Reflect.get(configuration, key) !== null && Reflect.get(configuration, key) !== undefined);
}

/** Whether `golemYaml` exists and has a `models` job. A file that is not YAML is the project's to fix: its parse error stops the run. */
function declaresModelsJob(golemYaml: string, onInput?: InputObserver): boolean {
  return declaresAny(readGolemYaml(golemYaml, onInput), ['models']);
}

/**
 * The folder that holds a shared model file's package, or undefined for a file in the folder of the app's own golem.yaml, or above.
 * It is the nearest folder with a package.json that has a `name`: a nameless one (such as `{"type":"module"}`) only scopes the
 * module format. With no such folder, it is the top folder below the stop. A package.json that cannot be read throws.
 */
function packageFolderOf(filename: string, appDirectory: string): string | undefined {
  const app = canonicalPath(appDirectory);
  let top: string | undefined;
  for (let directory = dirname(canonicalPath(filename)); directory !== app && !app.startsWith(`${directory}${sep}`); directory = dirname(directory)) {
    top = directory;
    if (readManifest(join(directory, 'package.json'))?.name) return directory;
    if (dirname(directory) === directory) break;
  }
  return top;
}

/**
 * The name of the package that holds a shared model file: the `name` of the package folder's package.json, else the folder's name.
 * The name becomes a folder in `models.output`, so one that leaves it (an absolute name, or one with a `..` segment) is an error.
 */
function packageNameOf(packageFolder: string): string {
  const manifestFile = join(packageFolder, 'package.json');
  const name = readManifest(manifestFile)?.name;
  if (typeof name !== 'string' || name === '') return basename(packageFolder);
  if (isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.split(/[\\/]/).includes('..')) {
    throw new Error(`${manifestFile} names the package "${name}". The generated files of the package go in a folder of that name in models.output, so the name cannot be absolute or have a ".." segment. Rename the package.`);
  }
  return name;
}

/**
 * The generated companion of a model file. An own file's is beside it: `.generated` before its final extension. A shared file's
 * is in `models.output`: `<package name>/<path of the file in its package folder>`, a declaration file's `.d.ts`, `.d.cts` or `.d.mts` becomes `.ts`.
 * Two shared files can give one path: `assertDistinctCompanions` stops the job.
 */
export function companionFilename(boundary: ModelBoundary | undefined, modelFile: string): string {
  if (boundary?.companions === undefined || isOwnModelFile(boundary, modelFile)) return generatedFilename(modelFile);
  const real = canonicalPath(modelFile);
  const packageFolder = packageFolderOf(real, boundary.companions.directory) ?? dirname(real);
  const inPackage = relative(packageFolder, real).replace(/\\/g, '/').replace(/\.d\.[cm]?ts$/, '.ts');
  return generatedFilename(join(boundary.companions.output, packageNameOf(packageFolder), inPackage));
}

export const CODE_COMPANION_PATH_CLASH = 'RUNM1078';

/** Stops generation when two shared model files get one companion path: both would write the same file. */
export function assertDistinctCompanions(boundary: ModelBoundary, modelFiles: readonly string[]): void {
  const owners = new Map<string, string>();
  for (const file of modelFiles.map(canonicalPath).sort()) {
    const companion = companionFilename(boundary, file);
    const other = owners.get(companion);
    if (other !== undefined && other !== file) {
      throw new Error(`${CODE_COMPANION_PATH_CLASH}: the shared model files ${other} and ${file} have one generated file, ${companion}. Rename one of them, or move it into another package folder.`);
    }
    owners.set(companion, file);
  }
}

/** The companion forms a generator could leave beside a model file: the source form, and the emitted `.js` and `.d.ts` forms. */
function companionsBeside(modelFile: string): string[] {
  const match = /^(.*?)(?:\.d)?\.([cm]?)ts$/.exec(modelFile);
  if (!match) return [];
  const [, stem, module] = match;
  return [`${stem}.generated.${module}ts`, `${stem}.generated.${module}js`, `${stem}.generated.d.${module}ts`];
}

export const CODE_IGNORED_SHARED_FILE = 'RUNM1076';

/**
 * A warning for each file golem ignores beside a shared model file, each reported once: a golem.yaml in the file's package
 * folder or in a folder between them, and a generated companion beside the file. `sharedFiles` are real paths.
 */
export function ignoredSharedFileWarnings(sharedFiles: readonly string[], appDirectory: string, onInput?: InputObserver): GolemDiagnostic[] {
  const warnings = new Map<string, GolemDiagnostic>();
  const warn = (file: string, message: string): void => {
    warnings.set(file, { code: CODE_IGNORED_SHARED_FILE, severity: GolemDiagnosticSeverity.Warning, message, file });
  };
  for (const modelFile of sharedFiles) {
    const packageFolder = packageFolderOf(modelFile, appDirectory);
    for (let directory = dirname(modelFile); packageFolder !== undefined && isInsideDirectory(packageFolder, directory); directory = dirname(directory)) {
      const golemYaml = join(directory, 'golem.yaml');
      onInput?.(golemYaml);
      if (existsSync(golemYaml) && !warnings.has(golemYaml)) {
        warn(golemYaml, ignoredGolemYamlMessage(golemYaml, modelFile));
      }
      if (directory === packageFolder) break;
    }
    for (const companion of companionsBeside(modelFile)) {
      onInput?.(companion);
      if (existsSync(companion) && !warnings.has(companion)) {
        warn(companion, `${companion} is a generated file beside the shared model file ${modelFile}. Golem does not use it: this app uses its own generated file in models.output. Delete it.`);
      }
    }
  }
  return [...warnings.values()].sort((left, right) => (left.file ?? '') < (right.file ?? '') ? -1 : 1);
}

function ignoredGolemYamlMessage(golemYaml: string, modelFile: string): string {
  const ignored = `${golemYaml} is a golem.yaml in the shared folder of the model file ${modelFile}. Golem does not read it.`;
  let belongsToAnApp = false;
  try {
    belongsToAnApp = declaresAny(readGolemYaml(golemYaml), JOB_KEYS);
  } catch (error) {
    // Golem ignores this file, so a file that is not YAML or that it cannot read is ignored like any other.
    if (!(error instanceof YamlFileError || ['EACCES', 'EPERM', 'EISDIR', 'ENOENT'].some((code) => hasErrorCode(error, code)))) throw error;
  }
  return belongsToAnApp
    ? `${ignored} It configures another app that generates ${basename(modelFile)}. Move the model into a shared package that holds no golem.yaml, and have each app use it from there.`
    : `${ignored} A shared package holds no golem.yaml. Delete it.`;
}

/**
 * The project files that `file` imports or re-exports, by canonical filename. A declaration file and a file in `node_modules`
 * are left out, unless it is a model file: a shared model can be declared there.
 */
export function projectFilesImportedBy(file: ts.SourceFile, compilerOptions: ts.CompilerOptions, suffixes: readonly string[] = DEFAULT_MODEL_SUFFIXES): string[] {
  const isModelFile = modelFilePattern(suffixes);
  const found = new Set<string>();
  for (const statement of file.statements) {
    const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) continue;
    const resolved = ts.resolveModuleName(specifier.text, file.fileName, compilerOptions, ts.sys, file.impliedNodeFormat).resolvedModule?.resolvedFileName;
    if (resolved === undefined) continue;
    if ((isAmbientDeclaration(resolved) || /(?:^|[\\/])node_modules[\\/]/.test(resolved)) && !isModelFile.test(resolved)) continue;
    found.add(canonicalFilename(resolved));
  }
  return [...found];
}

/** The import specifier that `output` writes for `source`: relative, with the extension the emitted file has. */
export function sourceImportPath(source: string, output: string): string {
  const relativePath = relative(dirname(output), source)
    .replace(/\\/g, '/')
    .replace(/\.ts$/, '.js')
    .replace(/\.mts$/, '.mjs')
    .replace(/\.cts$/, '.cjs');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/** The companion of a source: `.generated` before its final extension. */
export function generatedFilename(source: string): string {
  const generated = source.replace(/\.([cm]?ts)$/, '.generated.$1');
  return pathIsAbsolute(source) ? canonicalFilename(generated) : generated;
}

function isAmbientDeclaration(filename: string): boolean {
  return filename.endsWith('.d.ts') || filename.endsWith('.d.mts') || filename.endsWith('.d.cts');
}

export function isGeneratedCompanion(filename: string): boolean {
  return filename.endsWith('.generated.ts')
    || filename.endsWith('.generated.mts')
    || filename.endsWith('.generated.cts');
}

function uniqueFilenames(filenames: readonly string[]): string[] {
  return [...new Set(filenames.map(canonicalFilename))];
}

/**
 * The project configurations a solution tsconfig references. Both compilers parse a solution (`files: []` plus
 * `references`) to no files and no options, and the TypeScript 7 parse reports no references, so the list is read here.
 */
function referencedConfigs(solutionPath: string, onInput?: InputObserver): string[] {
  onInput?.(canonicalFilename(solutionPath));
  // The compiler parsed this file, so it is JSON with comments and trailing commas; strings match first and stay whole.
  const json = (ts.sys.readFile(solutionPath) ?? '').replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*[}\]])/g,
    (_match, text: string | undefined) => text ?? '',
  );
  const { references } = JSON.parse(json) as { references?: readonly { readonly path: string }[] };
  return (references ?? []).map(({ path }) => {
    const target = resolve(dirname(solutionPath), path);
    return path.endsWith('.json') ? target : join(target, 'tsconfig.json');
  });
}

/**
 * The project a solution tsconfig leaves to a reference: the first referenced configuration whose files include every
 * requested source, with the options of that project. Without references the file is no solution.
 */
function referencedProject(
  solutionPath: string,
  sources: readonly string[],
  session: ts.ProgramSession,
  onInput?: InputObserver,
): { readonly configPath: string; readonly parsed: ReturnType<ts.ProgramSession['parseConfigFile']> } | undefined {
  const references = referencedConfigs(solutionPath, onInput);
  if (references.length === 0) return undefined;
  const requested = uniqueFilenames(sources);
  for (const configPath of references) {
    const parsed = session.parseConfigFile(configPath, onInput);
    const files = new Set(uniqueFilenames(parsed.fileNames));
    if (requested.every((source) => files.has(source))) return { configPath, parsed };
  }
  throw new Error(`The solution tsconfig ${canonicalFilename(solutionPath)} references no project that includes ${requested.join(', ')}.`);
}

function parsedProject(
  root: string,
  sources: readonly string[],
  session: ts.ProgramSession,
  onInput?: InputObserver,
  /** The tsconfig to read, from the golem.yaml; without it the one that `tsc` would find from `root` upward. */
  configFile?: string,
): {
  readonly configPath?: string;
  readonly referencedConfigPath?: string;
  readonly projectFiles: readonly string[];
  readonly ambientFiles: readonly string[];
  readonly options: ts.CompilerOptions;
} {
  const configPath = configFile === undefined
    ? ts.findConfigFile(root, (filename) => {
      onInput?.(canonicalFilename(filename));
      return ts.sys.fileExists(filename);
    }, 'tsconfig.json')
    : (onInput?.(canonicalFilename(configFile)), ts.sys.fileExists(configFile) ? configFile : undefined);
  if (!configPath) {
    return {
      projectFiles: [],
      ambientFiles: [],
      options: {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
    };
  }
  let project = { configPath, parsed: session.parseConfigFile(configPath, onInput) };
  // A solution tsconfig lists no files of its own; the referenced project that holds the sources has the files and options.
  const referenced = project.parsed.fileNames.length === 0 ? referencedProject(configPath, sources, session, onInput) : undefined;
  if (referenced) project = referenced;
  const { parsed } = project;
  const projectFiles = uniqueFilenames(parsed.fileNames);
  const ambientFiles = projectFiles.filter(isAmbientDeclaration).filter((filename) => !isGeneratedCompanion(filename));
  return {
    configPath: canonicalFilename(configPath),
    ...(referenced ? { referencedConfigPath: canonicalFilename(referenced.configPath) } : {}),
    projectFiles,
    ambientFiles,
    options: parsed.options,
  };
}

/**
 * The compiler session a provider keeps for one project root across the
 * generation runs of a CLI pipeline or watch session.
 */
export function retainedProgramSession(
  session: GeneratorSession | undefined,
  owner: string,
  root: string,
): ts.ProgramSession | undefined {
  return session?.retain(`${owner}:${canonicalFilename(root)}`, () => new ts.ProgramSession({ cwd: root }));
}

/** The tsconfig a job's programs open with: the referenced project that holds the sources of a solution tsconfig, else the tsconfig itself. */
export function effectiveConfigPath(info: Pick<ProgramInfo, 'configPath' | 'referencedConfigPath'>): string | undefined {
  return info.referencedConfigPath ?? info.configPath;
}

function openParsedProgram(
  session: ts.ProgramSession,
  root: string,
  parsed: ReturnType<typeof parsedProject>,
  rootNames: readonly string[],
  onInput?: InputObserver,
  overlays?: ReadonlyMap<string, string>,
): ProgramInfo {
  const programConfig = effectiveConfigPath(parsed);
  const program = session.openProgram({
    root,
    sources: rootNames,
    ...(programConfig ? { configFile: programConfig } : {}),
    ...(overlays ? { overlays } : {}),
    onInput,
  });
  const host = ts.createCompilerHost(parsed.options, true);
  return { ...parsed, rootNames, program, host };
}

/**
 * Open the project program. Without a retained session, one compiler serves
 * this program and every program opened from it, and closes with the last.
 * A failed configuration parse or open closes the compiler it started.
 */
export function createProgram(
  sources: readonly string[],
  root: string,
  onInput?: InputObserver,
  retained?: ts.ProgramSession,
): ProgramInfo {
  const session = retained ?? new ts.ProgramSession({ cwd: root, closeWhenIdle: true });
  const parsed = parsedProject(root, sources, session, onInput);
  return openParsedProgram(session, root, parsed, uniqueFilenames([...sources, ...parsed.ambientFiles]), onInput);
}

/**
 * Open a program on every file of the given tsconfig, so a scan sees each source and the generated files it
 * imports or ignores alike. A tsconfig that does not exist has no files.
 */
export function createProjectProgram(
  root: string,
  onInput?: InputObserver,
  retained?: ts.ProgramSession,
  /** The tsconfig to open, from the golem.yaml; without it the one that `tsc` would find from `root` upward. */
  configFile?: string,
): ProgramInfo {
  const session = retained ?? new ts.ProgramSession({ cwd: root, closeWhenIdle: true });
  const parsed = parsedProject(root, [], session, onInput, configFile);
  return openParsedProgram(session, root, parsed, parsed.projectFiles, onInput);
}

/** Whether a generated companion is left over: its model source no longer exists. */
export function isOrphanCompanion(companion: string, suffixes: readonly string[]): boolean {
  const source = companion.replace(/\.generated(\.[cm]?ts)$/, '$1');
  return source !== companion && suffixPattern(suffixes).test(basename(source)) && !existsSync(source);
}

/**
 * The names of the class models a model file declares: the exported aliases `type Name = IModel<...>`, where `IModel` is
 * the name the file imports it by (`import { IModel as Model }` too) or a member of a namespace import. The text is read
 * with patterns. A file where it finds no name gets no stub: its own companion stays as it is on disk, and a companion in
 * `models.output`, which golem owns, reads as `export {}`.
 */
export function classModelNames(text: string): string[] {
  const local = new Set<string>();
  const namespaces = new Set<string>();
  for (const [, clause = ''] of text.matchAll(/\bimport\s+(?:type\s+)?([^'";]*?)\s*\bfrom\s*['"][^'"]*['"]/g)) {
    for (const [, members = ''] of clause.matchAll(/\{([^}]*)\}/g)) {
      for (const member of members.split(',')) {
        const [imported, alias] = member.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        if (imported === 'IModel') local.add(alias ?? imported);
      }
    }
    const namespace = /\*\s*as\s+([\w$]+)/.exec(clause)?.[1];
    if (namespace !== undefined) namespaces.add(namespace);
  }
  const names: string[] = [];
  for (const [, name = '', owner, member = ''] of text.matchAll(/\bexport\s+type\s+([\w$]+)\s*=\s*(?:([\w$]+)\s*\.\s*)?([\w$]+)\s*</g)) {
    if (owner === undefined ? local.has(member) : namespaces.has(owner) && member === 'IModel') names.push(name);
  }
  return [...new Set(names)];
}

/**
 * A program whose generated base classes are stubs. A generated companion on disk is missing on the first run and stale
 * after a model change, so the program reads each class model's base from an overlay instead: an empty abstract class that
 * has the fields of the model (`IModel<F>` is `F`). The checker then resolves every use of an app class, and every utility
 * type over it, from the model as it is now. A companion that no model declares any more reads as `export {}`.
 * The stubs come from the model files of `modelFiles`, read before the program opens; a model file that only the
 * program reaches (a shared folder) gets its stub from a second program opened from the same session.
 */
export function createModelStubProgram(
  sources: readonly string[],
  root: string,
  boundary: ModelBoundary,
  modelFiles: readonly string[],
  onInput?: InputObserver,
  retained?: ts.ProgramSession,
): ProgramInfo {
  const session = retained ?? new ts.ProgramSession({ cwd: root, closeWhenIdle: true });
  const parsed = parsedProject(root, sources, session, onInput);
  const stubbed = new Set<string>();
  const stubsOf = (files: readonly string[]): Map<string, string> => {
    const stubs = new Map<string, string>();
    for (const file of files) {
      const real = canonicalFilename(file);
      if (stubbed.has(real) || !existsSync(file)) continue;
      stubbed.add(real);
      const names = classModelNames(readFileSync(file, 'utf8'));
      if (names.length === 0) continue;
      const companion = canonicalFilename(companionFilename(boundary, file));
      stubs.set(companion, `import type { ${names.join(', ')} } from ${JSON.stringify(sourceImportPath(real, companion))};\n`
        + names.map((name) => `export declare abstract class ${name}BaseModel {}\nexport interface ${name}BaseModel extends ${name} {}\n`).join(''));
    }
    return stubs;
  };
  const open = (stubs: ReadonlyMap<string, string>): ProgramInfo => {
    const overlays = new Map(stubs);
    for (const filename of parsed.projectFiles) {
      const companion = canonicalFilename(filename);
      const underOutput = boundary.companions !== undefined && isInsideDirectory(boundary.companions.output, companion);
      if (isGeneratedCompanion(companion) && !overlays.has(companion) && (underOutput || isOrphanCompanion(companion, boundary.suffixes))) {
        overlays.set(companion, 'export {}\n');
      }
    }
    return openParsedProgram(session, root, parsed, uniqueFilenames([...sources, ...parsed.ambientFiles]), onInput, overlays);
  };
  const stubs = stubsOf(modelFiles);
  const info = open(stubs);
  const reached = stubsOf(byRealPath(includedModelSources(info.program.getSourceFiles()
    .filter((file) => !info.program.isSourceFileDefaultLibrary(file))
    .map((file) => file.fileName), boundary.suffixes)));
  if (reached.size === 0) return info;
  const next = open(new Map([...stubs, ...reached]));
  info.program[Symbol.dispose]();
  return next;
}

export function createOverlayProgram(
  info: ProgramInfo,
  sources: readonly string[],
  artifacts: readonly { readonly path: string; readonly content: string }[],
  onInput: InputObserver | undefined,
  /** Whether this run owns a companion: one it would write or remove, never another job's. */
  owns: (canonicalCompanion: string) => boolean,
): ts.Program {
  const overlays = new Map(artifacts.map((artifact) => [canonicalFilename(artifact.path), artifact.content]));
  for (const filename of info.projectFiles) {
    const canonical = canonicalFilename(filename);
    if (isGeneratedCompanion(canonical) && !overlays.has(canonical) && owns(canonical)) {
      overlays.set(canonical, 'export {}\n');
    }
  }
  const rootNames = uniqueFilenames([
    ...sources,
    ...info.ambientFiles,
    ...artifacts
      .filter((artifact) => !artifact.path.endsWith('.NOTICES.txt') && !artifact.path.endsWith('.js') && !artifact.path.endsWith('.json'))
      .map((artifact) => artifact.path),
  ]);
  const configFile = effectiveConfigPath(info);
  return info.program.session.openProgram({
    root: dirname(info.configPath ?? sources[0] ?? '.'),
    ...(configFile ? { configFile } : {}),
    sources: rootNames,
    overlays,
    onInput,
  });
}

/** `unwritten` are the texts of program files that are not on disk yet, such as the companions of a run, by path. */
export function formatDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  root: string,
  unwritten: readonly { readonly path: string; readonly content: string }[] = [],
): string {
  const texts = new Map(unwritten.map((file) => [canonicalFilename(file.path), file.content]));
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (filename) => filename,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
    readFile: (filename) => texts.get(canonicalFilename(filename)),
  });
}

/**
 * Every input a watch must react to: the sources, manifests, project configuration and files, and each local file the
 * program read. Generated companions are left out, but the set may still include other files golem itself writes, so a
 * host must filter the outputs it owns before it reacts to a change; golem's watch does so through its OwnedOutputIndex.
 */
export function projectWatchInputs(
  info: ProgramInfo,
  program: ts.Program,
  sources: readonly string[],
  manifestPaths: readonly string[],
): string[] {
  const inputs = new Set<string>([
    // An installed package's model file is no watch input: a new install needs a new `golem generate`.
    ...sources.filter((source) => !canonicalPath(source).split(sep).includes('node_modules')),
    ...manifestPaths,
    ...(info.configPath ? [info.configPath] : []),
    ...info.projectFiles,
  ]);
  for (const sourceFile of program.getSourceFiles()) {
    const filename = canonicalFilename(sourceFile.fileName);
    // Every local program source is consumed, including one imported from
    // outside the root. Packages resolved through node_modules (linked ones
    // resolve to a path without that segment) and TypeScript libraries are not.
    if (filename.split(sep).includes('node_modules')) continue;
    if (program.isSourceFileFromExternalLibrary(sourceFile) || program.isSourceFileDefaultLibrary(sourceFile)) continue;
    inputs.add(filename);
  }
  return [...inputs].filter((filename) => !isGeneratedCompanion(filename)).sort();
}
