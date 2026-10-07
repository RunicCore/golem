
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import * as ts from '../typescript-ns.js';
import { canonicalFilename, sharedFolderOf } from '../shared-folder.js';
import { DEFAULT_MODEL_SUFFIXES, discoverSources, suffixPattern, type GeneratorSession, type InputObserver } from '../generator-api.js';

export { canonicalFilename, sharedFolderOf };

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

/**
 * The nearest package.json at or above `folder` that has a `name`, as `packageSpecifier` finds the owner of a file. A
 * nameless one (such as `{"type":"module"}`) only scopes the module format.
 */
function namedPackageAbove(folder: string): { readonly root: string; readonly name: string } | undefined {
  for (let directory = folder; ; directory = dirname(directory)) {
    const file = join(directory, 'package.json');
    if (existsSync(file)) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        // A package.json that is not JSON is the project's to fix; the name of a shared folder cannot be read without it.
        if (error instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${error.message}`);
        throw error;
      }
      const name = typeof manifest === 'object' && manifest !== null && 'name' in manifest ? manifest.name : undefined;
      if (typeof name === 'string' && name !== '') return { root: directory, name };
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/**
 * The stable name of a project function's file. A file of the project is named from the project root. A file outside it
 * belongs to a shared folder. It is named from the nearest package that has a `name`, with the name in front, or from
 * its shared folder when no package above it has one. The name is the same in every app that includes the folder, and
 * two named packages do not share a name. A function that a named package exports is identified by its package import
 * instead (see `packageSpecifier`).
 */
export function identityPathOf(filename: string, root: string): string {
  if (!isOutside(root, filename)) return portableRelativeFilename(filename, root);
  const folder = sharedFolderOf(filename);
  const named = namedPackageAbove(folder);
  return named === undefined ? portableRelativeFilename(filename, folder) : `${named.name}/${portableRelativeFilename(filename, named.root)}`;
}

/** Find a stable project root when a direct generator root is unavailable. */
export function commonDirectory(filenames: readonly string[]): string {
  if (filenames.length === 0) return canonicalFilename('.');
  let current = dirname(canonicalFilename(filenames[0]));
  for (const filename of filenames.slice(1)) {
    const directory = dirname(canonicalFilename(filename));
    while (relative(current, directory).startsWith(`..${sep}`) || relative(current, directory) === '..') {
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

/** A TypeScript file that is not a generated companion: what an explicit model source may name. */
export function isModelSource(filename: string): boolean {
  return /\.[cm]?ts$/.test(filename) && !/\.d\.[cm]?ts$/.test(filename) && !isGeneratedCompanion(filename);
}

export function discoverModelSources(
  root = process.cwd(),
  onInput?: InputObserver,
  suffixes: readonly string[] = DEFAULT_MODEL_SUFFIXES,
): string[] {
  return discoverSources(join(root, 'src'), { source: suffixPattern(suffixes), normalize: canonicalFilename, onInput });
}

/**
 * The model files among `files`: those that end in a model suffix, are not in `node_modules` and are not generated
 * companions. A models job generates each of them, wherever it lies. Pass the files of the project's program, which are the
 * files the tsconfig includes and the files they import.
 */
export function includedModelSources(files: readonly string[], suffixes: readonly string[]): string[] {
  const pattern = suffixPattern(suffixes);
  return uniqueFilenames(files)
    .filter((filename) => pattern.test(filename) && !isGeneratedCompanion(filename) && !filename.split(sep).includes('node_modules'))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/**
 * The error for a shared model source (outside the folder of the tsconfig) that imports a file outside its own shared
 * folder, or undefined when it imports none. Its companion would then depend on files that another app does not include.
 * `projectFiles` are the canonical names of the program's own files. Only relative imports count: a package, a linked
 * one too, is not a place outside the shared folder.
 */
export function sharedImportOutsideItsFolder(
  source: ts.SourceFile,
  tsconfigDirectory: string,
  projectFiles: ReadonlySet<string>,
  compilerOptions: ts.CompilerOptions,
): string | undefined {
  const filename = canonicalFilename(source.fileName);
  if (!isOutside(tsconfigDirectory, filename)) return undefined;
  const sharedFolder = sharedFolderOf(filename);
  const target = projectFilesImportedBy(source, compilerOptions, true)
    .find((imported) => projectFiles.has(imported) && isOutside(sharedFolder, imported));
  return target === undefined
    ? undefined
    : `${filename} is outside ${tsconfigDirectory} and imports ${target}, which is outside its shared folder ${sharedFolder}. `
      + 'A shared model may import only files in its shared folder.';
}

/**
 * A check that answers whether a golem.yaml other than the one in `ownDirectory` has a models job that covers a source.
 * The source is covered when such a yaml lies in the source's directory or in a directory above it, up to the source's
 * shared folder. That job generates the source with ids of its own folder, so this job must leave the source alone.
 * The answer for a directory is read once.
 */
export function anotherModelsJobCheck(ownDirectory: string, onInput?: InputObserver): (source: string) => boolean {
  const own = canonicalFilename(ownDirectory);
  const hasModelsJob = new Map<string, boolean>();
  const directoryHasModelsJob = (directory: string): boolean => {
    const known = hasModelsJob.get(directory);
    if (known !== undefined) return known;
    const file = join(directory, 'golem.yaml');
    onInput?.(file);
    let found = false;
    if (existsSync(file)) {
      let configuration: unknown;
      try {
        configuration = YAML.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        // A golem.yaml that is not YAML is the project's to fix; whether it covers a source cannot be read without it.
        if (error instanceof YAML.YAMLParseError) throw new Error(`${file} is not valid YAML: ${error.message}`);
        throw error;
      }
      found = typeof configuration === 'object' && configuration !== null && 'models' in configuration && configuration.models !== null && configuration.models !== undefined;
    }
    hasModelsJob.set(directory, found);
    return found;
  };
  return (source) => {
    const sharedFolder = sharedFolderOf(source);
    for (let directory = dirname(canonicalFilename(source)); ; directory = dirname(directory)) {
      if (directory !== own && directoryHasModelsJob(directory)) return true;
      if (directory === sharedFolder || dirname(directory) === directory) return false;
    }
  };
}

/**
 * The project files that `file` imports or re-exports, by canonical filename. A declaration file and a file in `node_modules`
 * are left out, and so are the packages when `relativeOnly`: a bare specifier names a package, not a place beside the file.
 */
export function projectFilesImportedBy(file: ts.SourceFile, compilerOptions: ts.CompilerOptions, relativeOnly = false): string[] {
  const found = new Set<string>();
  for (const statement of file.statements) {
    const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) continue;
    if (relativeOnly && !specifier.text.startsWith('.') && !isAbsolute(specifier.text)) continue;
    const resolved = ts.resolveModuleName(specifier.text, file.fileName, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    if (resolved === undefined || isAmbientDeclaration(resolved) || /(?:^|[\\/])node_modules[\\/]/.test(resolved)) continue;
    found.add(canonicalFilename(resolved));
  }
  return [...found];
}

function isOutside(directory: string, filename: string): boolean {
  const path = relative(canonicalFilename(directory), canonicalFilename(filename));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
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
): ProgramInfo {
  const programConfig = effectiveConfigPath(parsed);
  const program = session.openProgram({
    root,
    sources: rootNames,
    ...(programConfig ? { configFile: programConfig } : {}),
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
  root: string,
  sources: readonly string[],
  manifestPaths: readonly string[],
): string[] {
  const inputs = new Set<string>([
    ...sources,
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
