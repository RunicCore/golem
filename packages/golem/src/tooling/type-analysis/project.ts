
import { dirname, join, normalize, parse, relative, resolve, sep } from 'node:path';
import * as ts from '../typescript-ns.js';
import { discoverSources, type GeneratorSession, type InputObserver } from '../generator-api.js';

export interface ProgramInfo {
  readonly configPath?: string;
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

function isGeneratedCompanion(filename: string): boolean {
  return filename.endsWith('.generated.ts')
    || filename.endsWith('.generated.mts')
    || filename.endsWith('.generated.cts');
}

function uniqueFilenames(filenames: readonly string[]): string[] {
  return [...new Set(filenames.map(canonicalFilename))];
}

function parsedProject(
  root: string,
  session: ts.ProgramSession,
  onInput?: InputObserver,
): {
  readonly configPath?: string;
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
  const parsed = session.parseConfigFile(configPath, onInput);
  const projectFiles = uniqueFilenames(parsed.fileNames);
  const ambientFiles = projectFiles.filter(isAmbientDeclaration).filter((filename) => !isGeneratedCompanion(filename));
  return {
    configPath: canonicalFilename(configPath),
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
  const parsed = parsedProject(root, session, onInput);
  const rootNames = uniqueFilenames([...sources, ...parsed.ambientFiles]);
  const program = session.openProgram({
    root,
    sources: rootNames,
    onInput,
  });
  const host = ts.createCompilerHost(parsed.options, true);
  return { ...parsed, rootNames, program, host };
}

export function createOverlayProgram(
  info: ProgramInfo,
  sources: readonly string[],
  artifacts: readonly { readonly path: string; readonly content: string }[],
  onInput?: InputObserver,
): ts.Program {
  const overlays = new Map(artifacts.map((artifact) => [canonicalFilename(artifact.path), artifact.content]));
  for (const filename of info.projectFiles) {
    const canonical = canonicalFilename(filename);
    if (canonical.endsWith('.generated.ts') && !overlays.has(canonical)) {
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

export function projectWatchInputs(
  info: ProgramInfo,
  program: ts.Program,
  root: string,
  sources: readonly string[],
  manifestPaths: readonly string[],
  ownedOutputs: readonly string[] = [],
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
  // Watching a file the run writes would trigger the run again.
  const owned = new Set(ownedOutputs.map(canonicalFilename));
  return [...inputs].filter((filename) => !isGeneratedCompanion(filename) && !owned.has(canonicalFilename(filename))).sort();
}
