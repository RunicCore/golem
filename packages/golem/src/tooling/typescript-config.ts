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
