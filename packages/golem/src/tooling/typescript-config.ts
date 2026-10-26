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

/** What a compiler lane gives for command-line arguments: the parsed options, the loose arguments and the errors. */
interface ParsedArguments {
  readonly options: object;
  readonly fileNames: readonly string[];
  readonly errors: readonly { readonly code: number; readonly text: string }[];
}

/** A command-line option as a tsconfig value. The parse holds enums as numbers and `lib` as file names, which a configuration does not take back, so the argument's own text decides. */
function configValue(parsed: unknown, argument: string | undefined): string | number | boolean | readonly string[] {
  if (argument === undefined) return parsed as boolean;
  if (Array.isArray(parsed)) return argument.split(',');
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
    const together = next !== undefined && !next.startsWith('-') && (() => {
      const pair = parse([flag, next]);
      return pair.errors.length === 0 && pair.fileNames.length === 0;
    })();
    const parsed = parse(together ? [flag, next] : [flag]);
    if (parsed.errors.length > 0) throw new Error([`The compiler arguments ${flags.join(' ')} have errors:`, ...parsed.errors.map((diagnostic) => `  TS${diagnostic.code}: ${diagnostic.text}`)].join('\n'));
    for (const [name, value] of Object.entries(parsed.options as Record<string, unknown>)) options[name] = configValue(value, together ? next : undefined);
    if (together) index += 1;
  }
  return options;
}
