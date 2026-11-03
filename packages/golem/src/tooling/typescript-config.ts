import { basename, dirname, isAbsolute, join, normalize, relative, resolve as resolvePath } from 'node:path';
import { displayPath } from './generator-core.js';
import type { OpenProgramOptions } from './typescript-types.js';

/** The diagnostic code of a configuration that matches no file. */
const NO_INPUTS_FOUND = 18003;

/** A configuration with errors fails with them. Golem names its own roots, so a configuration that lists no files is not an error here. */
export function assertConfigParsed(configPath: string, errors: readonly { readonly code: number; readonly text: string }[]): void {
  const reported = errors.filter((diagnostic) => diagnostic.code !== NO_INPUTS_FOUND);
  if (reported.length > 0) {
    throw new Error([`The TypeScript configuration ${displayPath(configPath)} has errors:`, ...reported.map((diagnostic) => `  TS${diagnostic.code}: ${diagnostic.text}`)].join('\n'));
  }
}

/** A project reference as a tsconfig writes it: `path` names a folder or a tsconfig file, relative to the tsconfig that holds it. */
export interface ConfigReference {
  readonly path: string;
  readonly circular?: boolean;
}

/**
 * The `references` of a tsconfig as written. A tsconfig that extends another does not inherit them, so a derived configuration copies
 * them from the original. An entry that is not a path is the compiler's to report, and its parse of the original does.
 */
export function configReferences(config: unknown): ConfigReference[] {
  const references = (config as { readonly references?: unknown } | null | undefined)?.references;
  if (!Array.isArray(references)) return [];
  return references.flatMap((entry: unknown): ConfigReference[] => {
    const { path, circular } = (entry ?? {}) as { readonly path?: unknown; readonly circular?: unknown };
    return typeof path === 'string' ? [{ path, ...(circular === true ? { circular } : {}) }] : [];
  });
}

/** The tsconfig file a project reference names: the reference itself when it names a `.json` file, else `tsconfig.json` in the folder. */
export function referencedConfigFile(reference: string): string {
  return reference.endsWith('.json') ? reference : join(reference, 'tsconfig.json');
}

/**
 * Every project that the references reach, the references of the referenced projects too, each once. `tsc` loads the whole closure, and an
 * import may reach a source of any project in it, such as a `paths` alias that points into a project only a referenced project references.
 */
export function referenceClosure<P extends { readonly projectReferences?: readonly { readonly path: string }[] }>(references: readonly { readonly path: string }[], parse: (configFile: string) => P): { readonly configFile: string; readonly parsed: P }[] {
  const found = new Map<string, P>();
  const visit = (reference: { readonly path: string }): void => {
    const configFile = referencedConfigFile(reference.path);
    if (found.has(configFile)) return;
    const parsed = parse(configFile);
    found.set(configFile, parsed);
    for (const next of parsed.projectReferences ?? []) visit(next);
  };
  references.forEach(visit);
  return [...found].map(([configFile, parsed]) => ({ configFile, parsed }));
}

/** The command that builds a referenced project: its own golem.yaml names it. */
export function referencedCommand(project: string): string {
  return `golem build --config ${displayPath(join(dirname(project), 'golem.yaml'))}`;
}

/**
 * The refusal of a tsconfig that would follow project references. `tsc -b` would also build projects that have no golem.yaml, whose calls
 * would not be rewritten, so the message names each referenced project with the command that builds it. `reason` says why and what to do.
 */
export function referencesRefusal(configFile: string, references: readonly { readonly path: string }[], reason: string): Error {
  const commands = references.map((reference) => `  ${displayPath(reference.path)}: ${referencedCommand(reference.path)}`);
  return new Error([`${reason}${commands.length === 0 ? '' : ` Build each project of ${displayPath(configFile)} with its own golem.yaml, in dependency order:`}`, ...commands].join('\n'));
}

/**
 * Refuse a solution tsconfig, one with no files and only references. Every consumer of a tsconfig that a golem.yaml or `golem build -p`
 * names (the jobs, the check scan, the build and the build tools) calls this once it has parsed the file. `named` is where the file was
 * named: the `tsconfig` key of the golem.yaml, or `-p`.
 */
export function assertNotSolutionTsconfig(configFile: string, parsed: { readonly fileNames: readonly string[]; readonly projectReferences: readonly { readonly path: string }[] }, named: 'yaml' | 'project'): void {
  if (parsed.fileNames.length > 0 || parsed.projectReferences.length === 0) return;
  const lead = `${displayPath(configFile)} only lists project references, so it has no files.`;
  throw referencesRefusal(configFile, parsed.projectReferences, named === 'yaml' ? `${lead} Name one referenced project in the tsconfig key of golem.yaml.` : `${lead} A golem.yaml names one project.`);
}

/** A source `tsc` replaces with a declaration output when another project reads it through a reference: not a declaration file, not JSON. */
export function hasDeclarationOutput(source: string): boolean {
  return !/\.d\.[cm]?ts$/.test(source) && !/\.json$/.test(source);
}

/**
 * The declaration file `tsc` writes for a source of a composite project, which another project that references it reads in place of the source:
 * in the `declarationDir`, else the `outDir`, else beside the source, laid out from the `rootDir`, else from the folder of the tsconfig.
 * The extension follows the source: `.d.ts`, `.d.mts` or `.d.cts`.
 */
export function declarationOutputOf(source: string, configFile: string, options: { readonly rootDir?: unknown; readonly outDir?: unknown; readonly declarationDir?: unknown }): string {
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const root = text(options.rootDir) ?? dirname(configFile);
  const directory = text(options.declarationDir) ?? text(options.outDir) ?? root;
  const extension = /\.[cm]?[jt]sx?$/.exec(source)?.[0] ?? '';
  const declaration = /^\.[cm]/.test(extension) ? `.d.${extension[1]}ts` : '.d.ts';
  const laidOut = relative(root, source);
  return join(directory, `${laidOut.slice(0, laidOut.length - extension.length)}${declaration}`);
}

/** Whether the options ask a program for an emit of this kind: `noEmit` asks for none, declarations need `declaration` or `composite`, JavaScript is skipped by `emitDeclarationOnly`. */
export function emitWanted(compilerOptions: object, declarations: boolean): boolean {
  const options = compilerOptions as Record<string, unknown>;
  return options.noEmit !== true && (declarations ? options.declaration === true || options.composite === true : options.emitDeclarationOnly !== true);
}

/**
 * The diagnostics `tsc` collects for a check, in its steps: the configuration's, then the syntax errors alone when there are any, else the
 * options', the global and the semantic ones, then the declaration ones under `noEmit` (an emit reports its own). Each lane gives the
 * steps from its own program, then sorts and removes repeats in its own way.
 */
export function collectTscDiagnostics<D>(steps: {
  readonly config: () => readonly D[];
  readonly syntactic: () => readonly D[];
  readonly options: () => readonly D[];
  readonly global: () => readonly D[];
  readonly semantic: () => readonly D[];
  readonly declaration: () => readonly D[];
}, compilerOptions: object): D[] {
  const options = compilerOptions as Record<string, unknown>;
  const found = [...steps.config()];
  const configured = found.length;
  found.push(...steps.syntactic());
  if (found.length === configured) {
    found.push(...steps.options(), ...steps.global());
    if (found.length === configured) found.push(...steps.semantic());
    if (options.noEmit === true && (options.declaration === true || options.composite === true) && found.length === configured) found.push(...steps.declaration());
  }
  return found;
}

/** `tsc -p` takes no source files: arguments that name some (`golem build src/a.ts`) are an error, not a narrowing of the project. */
export function assertNoSourceFiles(fileNames: readonly string[]): void {
  if (fileNames.length > 0) throw new Error(`The compiler arguments name source files (${fileNames.join(', ')}), which a build of a tsconfig does not take (TS5042: Option 'project' cannot be mixed with source files on a command line).`);
}

/** What a compiler lane gives for command-line arguments: the parsed options, the loose arguments and the errors. */
interface ParsedArguments {
  readonly options: object;
  readonly fileNames: readonly string[];
  readonly errors: readonly { readonly code: number; readonly text: string }[];
}

/** A command-line option as a tsconfig value. The parse holds enums as numbers and `lib` as file names, which a configuration does not take back, so the argument's own text decides. */
function configValue(parsed: unknown, argument: string | undefined): string | number | boolean | readonly string[] {
  if (argument === undefined) return parsed as boolean;
  if (Array.isArray(parsed)) return argument.trim() === '' ? [] : argument.split(',').map((item) => item.trim());
  if (typeof parsed === 'number') return /^-?\d+$/.test(argument) ? parsed : argument;
  // A string is the argument as written: a lane may have made a path in it absolute from the wrong folder.
  return typeof parsed === 'string' ? argument : parsed as boolean;
}

/**
 * What a compiler lane gives for options read as a tsconfig that sits in the current folder: the compiler's own parse makes each path
 * option an absolute path from that folder, and keeps the other values.
 */
export type ResolveAtCurrentFolder = (options: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;

/** A path option, as the compiler's parse leaves it: an absolute path, or a list of them. */
function isResolvedPath(value: unknown): value is string | readonly string[] {
  return typeof value === 'string' ? isAbsolute(value) : Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && isAbsolute(item));
}

/**
 * The path options among the command-line `flags`, as absolute paths from the current folder. `tsc` reads a path in a flag from the
 * folder it runs in, and one in a tsconfig from the tsconfig's folder, while a lane's session works from the tsconfig's folder.
 * The compiler's own option table tells which options are paths: it makes them absolute when it reads them as a tsconfig of the current folder.
 */
export function flagPathOptions(flags: readonly string[], parse: (flags: readonly string[]) => ParsedArguments, resolveAtCurrentFolder: ResolveAtCurrentFolder): Record<string, string | readonly string[]> {
  const options = parsedFlagOptions(flags, parse);
  const resolved = resolveAtCurrentFolder(options);
  return Object.fromEntries(Object.entries(resolved).filter(([name, value]) => name in options && isResolvedPath(value) && value !== options[name])) as Record<string, string | readonly string[]>;
}

/**
 * The command-line `flags` as `compilerOptions` of a tsconfig, for a compiler that builds a program from a configuration alone. The
 * lane's own parser tells which argument takes the next one as its value and what option it sets. A path option is an absolute path
 * from the current folder (`flagPathOptions`), because a tsconfig would read it from its own folder.
 */
export function flagsAsConfigOptions(flags: readonly string[], parse: (flags: readonly string[]) => ParsedArguments, resolveAtCurrentFolder: ResolveAtCurrentFolder): Record<string, string | number | boolean | readonly string[]> {
  return { ...parsedFlagOptions(flags, parse), ...flagPathOptions(flags, parse, resolveAtCurrentFolder) };
}

function parsedFlagOptions(flags: readonly string[], parse: (flags: readonly string[]) => ParsedArguments): Record<string, string | number | boolean | readonly string[]> {
  const options: Record<string, string | number | boolean | readonly string[]> = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    const next = flags[index + 1];
    const together = next !== undefined && (!next.startsWith('-') || /^-\d+$/.test(next)) && (() => {
      const pair = parse([flag, next]);
      return pair.errors.length === 0 && pair.fileNames.length === 0;
    })();
    const parsed = parse(together ? [flag, next] : [flag]);
    assertNoSourceFiles(parsed.fileNames);
    if (parsed.errors.length > 0) throw new Error([`The compiler arguments ${flags.join(' ')} have errors:`, ...parsed.errors.map((diagnostic) => `  TS${diagnostic.code}: ${diagnostic.text}`)].join('\n'));
    for (const [name, value] of Object.entries(parsed.options as Record<string, unknown>)) options[name] = configValue(value, together ? next : undefined);
    if (together) index += 1;
  }
  return options;
}

/** A path in the one spelling that both backends key their overlays, caches and observed inputs by. */
export function canonical(filename: string): string {
  return normalize(resolvePath(filename));
}

/** The configuration a program opens: the file the compiler reads first and the overlays that serve the files that exist only in memory. */
export interface ProgramConfig {
  readonly configPath: string;
  readonly overlays: ReadonlyMap<string, string>;
  /** Configuration paths the observer is not told about: virtual configurations are derived input. */
  readonly hidden: ReadonlySet<string>;
}

/** The configuration a program opens, from the request: a default tsconfig for a folder without one, and a virtual configuration for option overrides. */
export function programConfig(options: OpenProgramOptions, fileExists: (filename: string) => boolean, referencesOf: (configPath: string, overlays: ReadonlyMap<string, string>) => readonly ConfigReference[]): ProgramConfig {
  const overlays = new Map([...options.overlays ?? []].map(([filename, content]) => [canonical(filename), content]));
  const baseConfigPath = canonical(options.configFile === undefined
    ? join(options.root, 'tsconfig.json')
    : isAbsolute(options.configFile) ? options.configFile : join(options.root, options.configFile));
  const hidden = new Set<string>();
  if (options.configFile !== undefined && overlays.has(baseConfigPath)) hidden.add(baseConfigPath);
  if (!overlays.has(baseConfigPath) && !fileExists(baseConfigPath)) {
    overlays.set(baseConfigPath, JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['**/*.ts'],
    }));
  }
  let configPath = baseConfigPath;
  if (options.compilerOptionOverrides !== undefined) {
    // A virtual configuration that extends the original replaces the options for this program only. The TypeScript 7 API takes no option override;
    // the TypeScript 6 parse could take one, but both backends read the same configuration. It sits beside the original, so the references,
    // which an extending configuration does not inherit, keep their meaning when copied.
    configPath = join(dirname(baseConfigPath), `${basename(baseConfigPath, '.json')}.options.json`);
    const references = referencesOf(baseConfigPath, overlays);
    overlays.set(configPath, JSON.stringify({ extends: `./${basename(baseConfigPath)}`, compilerOptions: options.compilerOptionOverrides, ...(references.length === 0 ? {} : { references }) }));
    hidden.add(configPath);
  }
  return { configPath, overlays, hidden };
}
