import { displayPath } from './generator-api.js';

/** The diagnostic code of a configuration that matches no file. */
const NO_INPUTS_FOUND = 18003;

/** A configuration with errors fails with them. Golem names its own roots, so a configuration that lists no files is not an error here. */
export function assertConfigParsed(configPath: string, errors: readonly { readonly code: number; readonly text: string }[]): void {
  const reported = errors.filter((diagnostic) => diagnostic.code !== NO_INPUTS_FOUND);
  if (reported.length > 0) {
    throw new Error([`The TypeScript configuration ${displayPath(configPath)} has errors:`, ...reported.map((diagnostic) => `  TS${diagnostic.code}: ${diagnostic.text}`)].join('\n'));
  }
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
  return parsed as string | boolean;
}

/**
 * The command-line `flags` as `compilerOptions` of a tsconfig, for a compiler that builds a program from a configuration alone. The
 * lane's own parser tells which argument takes the next one as its value and what option it sets.
 */
export function flagsAsConfigOptions(flags: readonly string[], parse: (flags: readonly string[]) => ParsedArguments): Record<string, string | number | boolean | readonly string[]> {
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
