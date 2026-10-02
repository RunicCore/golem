
import { dirname, join, normalize, parse, relative, resolve, sep } from 'node:path';
import * as ts from '../typescript-ns.js';
import { discoverSources, type GeneratorSession, type InputObserver } from '../generator-api.js';

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

export function canonicalFilename(filename: string): string {
  return normalize(resolve(filename));
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

export function isModelSource(filename: string): boolean {
  return (
    (filename.endsWith('.model.ts') || filename.endsWith('.models.ts'))
    && !filename.endsWith('.generated.ts')
  );
}

export function discoverModelSources(
  root = process.cwd(),
  onInput?: InputObserver,
): string[] {
  return discoverSources(join(root, 'src'), { source: /\.models?\.ts$/, normalize: canonicalFilename, onInput });
}

export function generatedFilename(source: string): string {
  const generated = source.replace(/\.models?\.ts$/, (suffix) =>
    suffix === '.models.ts' ? '.models.generated.ts' : '.model.generated.ts',
  );
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
): {
  readonly configPath?: string;
  readonly referencedConfigPath?: string;
  readonly projectFiles: readonly string[];
  readonly ambientFiles: readonly string[];
  readonly options: ts.CompilerOptions;
} {
  const configPath = ts.findConfigFile(root, (filename) => {
    onInput?.(canonicalFilename(filename));
    return ts.sys.fileExists(filename);
  }, 'tsconfig.json');
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

function openParsedProgram(
  session: ts.ProgramSession,
  root: string,
  parsed: ReturnType<typeof parsedProject>,
  rootNames: readonly string[],
  onInput?: InputObserver,
): ProgramInfo {
  const program = session.openProgram({
    root,
    sources: rootNames,
    ...(parsed.referencedConfigPath ? { configFile: parsed.referencedConfigPath } : {}),
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
 * Open a program on every file of the project's tsconfig, so a scan sees each source and the generated files it
 * imports or ignores alike. A project without a tsconfig has no files.
 */
export function createProjectProgram(
  root: string,
  onInput?: InputObserver,
  retained?: ts.ProgramSession,
): ProgramInfo {
  const session = retained ?? new ts.ProgramSession({ cwd: root, closeWhenIdle: true });
  const parsed = parsedProject(root, [], session, onInput);
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
    if (canonical.endsWith('.generated.ts') && !overlays.has(canonical) && owns(canonical)) {
      overlays.set(canonical, 'export {}\n');
    }
  }
  const rootNames = uniqueFilenames([
    ...sources,
    ...info.ambientFiles,
    ...artifacts
      .filter((artifact) => !artifact.path.endsWith('.NOTICES.txt') && !artifact.path.endsWith('.js'))
      .map((artifact) => artifact.path),
  ]);
  return info.program.session.openProgram({
    root: dirname(info.configPath ?? sources[0] ?? '.'),
    ...(info.referencedConfigPath ? { configFile: info.referencedConfigPath } : {}),
    sources: rootNames,
    overlays,
    onInput,
  });
}

export function formatDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  root: string,
): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (filename) => filename,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
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
