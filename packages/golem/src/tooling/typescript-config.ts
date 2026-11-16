import { basename, dirname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from 'node:path';
import { displayPath } from './generator-core.js';
import { inNodeModules } from './type-analysis/path-identity.js';
import type { CompilerOptions, Diagnostic, OpenProgramOptions, VirtualFiles } from './typescript-types.js';

/** The diagnostic code of a configuration that matches no file. */
const NO_INPUTS_FOUND = 18003;

/** The refusal of a configuration that has errors. A build recovers from it by printing them as the compiler does; any other reader of the values fails with it. */
export class ConfigParseError extends Error {}

/** The refusal of command-line arguments that the compiler's parse rejects. A build prints its `diagnostics` as `tsc` prints them. `options` are the options that the lane's `tsc` uses to format these errors: its `pretty` picks the form, and a lane whose `tsc` reads none gives none. */
export class CommandLineError extends Error {
  constructor(readonly options: CompilerOptions, readonly diagnostics: readonly Diagnostic[]) {
    super(['The compiler arguments have errors:', ...diagnostics.map((diagnostic) => `  TS${diagnostic.code}: ${diagnostic.text}`)].join('\n'));
  }
}

/** Fail with the compiler's own diagnostics for command-line arguments it rejects. Both lanes read the arguments with their compiler's parse and give it here. */
export function assertCommandLineParsed(commandLine: { readonly options: object; readonly errors: readonly Diagnostic[] }): void {
  if (commandLine.errors.length > 0) throw new CommandLineError({ ...commandLine.options }, commandLine.errors);
}

/** A configuration that is read for its values (not to open a program) fails with its errors. Golem names its own roots there, so a configuration that lists no files is not an error. A program reports it, as `tsc` does. */
export function assertConfigParsed(configPath: string, errors: readonly { readonly code: number; readonly text: string }[]): void {
  const reported = errors.filter((diagnostic) => diagnostic.code !== NO_INPUTS_FOUND);
  if (reported.length > 0) {
    throw new ConfigParseError([`The TypeScript configuration ${displayPath(configPath)} has errors:`, ...reported.map((diagnostic) => `  TS${diagnostic.code}: ${diagnostic.text}`)].join('\n'));
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
 * `parse` gives `undefined` for a tsconfig that does not exist: `tsc` reports it (TS6053) and goes on without it.
 */
export function referenceClosure<P extends { readonly projectReferences?: readonly { readonly path: string }[] }>(references: readonly { readonly path: string }[], parse: (configFile: string) => P | undefined): { readonly configFile: string; readonly parsed: P | undefined }[] {
  const found = new Map<string, P | undefined>();
  const visit = (reference: { readonly path: string }): void => {
    const configFile = referencedConfigFile(reference.path);
    if (found.has(configFile)) return;
    const parsed = parse(configFile);
    found.set(configFile, parsed);
    for (const next of parsed?.projectReferences ?? []) visit(next);
  };
  references.forEach(visit);
  return [...found].map(([configFile, parsed]) => ({ configFile, parsed }));
}

/*
 * The two below restate one rule of `tsc` (`verifyProjectReferences` of its program), which the TypeScript 7 program cannot apply because it is made without
 * references: for each referenced project, a tsconfig that does not exist is TS6053, one that is not composite is TS6306, and one that disables emit is
 * TS6310, the last two only for a project that has files. Change both together.
 */

/** The codes of the errors that `tsc` reports for a project reference. */
export const REFERENCE_ERROR_CODES: ReadonlySet<number> = new Set([6053, 6306, 6310]);

/** Whether `tsc` reports an error for this referenced project: `parsed` is `undefined` when its tsconfig does not exist. It may answer yes where `tsc` stays silent (a project with no files), never no where `tsc` reports. */
export function isBrokenReference(parsed: { readonly options: { readonly composite?: unknown; readonly noEmit?: unknown } } | undefined): boolean {
  return parsed === undefined || parsed.options.composite !== true || parsed.options.noEmit === true;
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

const DECLARATION_FILE = /\.d\.(?:[^./\\]+\.)?[cm]?ts(?:\.map)?$/;

/** Whether a name is a declaration file or its map, such as `a.d.ts`, `a.d.mts.map` or `a.d.css.ts`: what an emit of declarations writes. */
export function isDeclarationFile(filename: string): boolean {
  return DECLARATION_FILE.test(filename);
}

/** A source `tsc` replaces with a declaration output when another project reads it through a reference: not a declaration file, not JSON. */
export function hasDeclarationOutput(source: string): boolean {
  return !isDeclarationFile(source) && !/\.json$/.test(source);
}

/** A change to a package manifest or an installed package invalidates cached module resolution. */
export function affectsResolution(filename: string): boolean {
  return basename(filename) === 'package.json' || inNodeModules(filename);
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
  readonly errors: readonly Diagnostic[];
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

/** The diagnostic of an option that takes a value and finds none (TS6044). The compiler's parse gives it for a flag alone exactly when the flag takes the next argument. */
const EXPECTS_AN_ARGUMENT = 6044;

function parsedFlagOptions(flags: readonly string[], parse: (flags: readonly string[]) => ParsedArguments): Record<string, string | number | boolean | readonly string[]> {
  const options: Record<string, string | number | boolean | readonly string[]> = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const next = flags[index + 1];
    const alone = parse([flag]);
    // The compiler's parse tells which flag takes the next argument. A value option takes it whatever it looks like (`--rootDir -x`, `--depth -1`).
    // A boolean option takes only `true` or `false`, so a following option or file is not its value.
    const takesValue = alone.errors.some((error) => error.code === EXPECTS_AN_ARGUMENT);
    const pair = next !== undefined && (takesValue || !next.startsWith('-')) ? parse([flag, next]) : undefined;
    const together = pair !== undefined && (takesValue || (pair.errors.length === 0 && pair.fileNames.length === 0)) ? pair : undefined;
    const parsed = together ?? alone;
    assertNoSourceFiles(parsed.fileNames);
    assertCommandLineParsed(parsed);
    for (const [name, value] of Object.entries(parsed.options as Record<string, unknown>)) options[name] = configValue(value, together === undefined ? undefined : next);
    if (together !== undefined) index += 1;
  }
  return options;
}

/** A path in the one spelling that both backends key their overlays, caches and observed inputs by. */
export function canonical(filename: string): string {
  return normalize(resolvePath(filename));
}

/** What a module lookup counts as present among `VirtualFiles`, for the files and folders the compiler probes; both backends ask it. */
export interface VirtualLookup {
  file(filename: string): boolean;
  directory(directory: string): boolean;
}

/** Whether a lookup can find anything among `virtual`; a second lookup over none cannot succeed where the first failed. */
export function hasVirtualFiles(virtual: VirtualFiles | undefined): virtual is VirtualFiles {
  return virtual !== undefined && (virtual.files.size > 0 || virtual.folders.length > 0);
}

/** The lookup of `virtual`; the paths it is asked about are canonical. */
export function virtualLookup(virtual: VirtualFiles): VirtualLookup {
  const files = new Set([...virtual.files].map(canonical));
  const folders = virtual.folders.map(canonical);
  const inside = (outer: string, inner: string): boolean => outer === inner || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
  const paths = [...files, ...folders];
  return {
    file: (filename) => files.has(filename) || (/\.(?:[cm]?ts|tsx)$/.test(filename) && folders.some((folder) => inside(folder, filename))),
    directory: (directory) => paths.some((path) => inside(directory, path)) || folders.some((folder) => inside(folder, directory)),
  };
}

/** The suffixes, before `.json`, of a configuration that golem derives beside the user's: one with the option overrides, one with the added roots, or one with both. */
export const OPTIONS_CONFIG_SUFFIX = '.options';
export const ROOTS_CONFIG_SUFFIX = '.roots';

/** The base names of the configurations that golem derives beside the user's tsconfig `user` (a base name): with the option overrides, with the roots, or with both. */
export function derivedConfigNames(user: string): ReadonlySet<string> {
  const stem = basename(user, '.json');
  return new Set([OPTIONS_CONFIG_SUFFIX, ROOTS_CONFIG_SUFFIX, `${OPTIONS_CONFIG_SUFFIX}${ROOTS_CONFIG_SUFFIX}`].map((suffix) => `${stem}${suffix}.json`));
}

/** The configuration a program opens: the file the compiler reads first and the overlays that serve the files that exist only in memory. */
export interface ProgramConfig {
  readonly configPath: string;
  readonly overlays: ReadonlyMap<string, string>;
  /** Configuration paths the observer is not told about: virtual configurations are derived input. */
  readonly hidden: ReadonlySet<string>;
  /** The tsconfig of the user that `configPath` is or extends: a file on disk that no overlay replaces, so its text is the user's to name in an error. */
  readonly userConfigPath: string | undefined;
}

/** A program to open: its configuration and the root files that the caller asked for, as canonical paths without repeats. */
export interface ProgramRequest extends ProgramConfig {
  readonly rootNames: readonly string[];
}

/** The request of a program from its options: both compiler backends open it the same way. `host` tells which configuration files exist. */
export function programRequest(options: OpenProgramOptions, host: { fileExists(filename: string): boolean }, referencesOf: (configPath: string, overlays: ReadonlyMap<string, string>) => readonly ConfigReference[]): ProgramRequest {
  return { ...programConfig(options, (filename) => host.fileExists(filename), referencesOf), rootNames: [...new Set(options.sources.map(canonical))] };
}

/** The configuration a program opens, from the request: a default tsconfig for a folder without one, and a virtual configuration for option overrides. */
function programConfig(options: OpenProgramOptions, fileExists: (filename: string) => boolean, referencesOf: (configPath: string, overlays: ReadonlyMap<string, string>) => readonly ConfigReference[]): ProgramConfig {
  const overlays = new Map([...options.overlays ?? []].map(([filename, content]) => [canonical(filename), content]));
  const baseConfigPath = canonical(options.configFile === undefined
    ? join(options.root, 'tsconfig.json')
    : isAbsolute(options.configFile) ? options.configFile : join(options.root, options.configFile));
  const hidden = new Set<string>();
  if (options.configFile !== undefined && overlays.has(baseConfigPath)) hidden.add(baseConfigPath);
  const onDisk = !overlays.has(baseConfigPath) && fileExists(baseConfigPath);
  if (!overlays.has(baseConfigPath) && !onDisk) {
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
    configPath = join(dirname(baseConfigPath), `${basename(baseConfigPath, '.json')}${OPTIONS_CONFIG_SUFFIX}.json`);
    const references = referencesOf(baseConfigPath, overlays);
    overlays.set(configPath, JSON.stringify({ extends: `./${basename(baseConfigPath)}`, compilerOptions: options.compilerOptionOverrides, ...(references.length === 0 ? {} : { references }) }));
    hidden.add(configPath);
  }
  return { configPath, overlays, hidden, userConfigPath: onDisk ? baseConfigPath : undefined };
}
