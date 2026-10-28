import { basename, dirname, isAbsolute, join, normalize, resolve as resolvePath } from 'node:path';
import type { ConfigReference } from './typescript-config.js';
import type { OpenProgramOptions } from './typescript-types.js';

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
    // A virtual configuration that extends the original replaces the options for this program only (the TypeScript 7 API has no override).
    // It sits beside the original, so the references, which an extending configuration does not inherit, keep their meaning when copied.
    configPath = join(dirname(baseConfigPath), `${basename(baseConfigPath, '.json')}.options.json`);
    const references = referencesOf(baseConfigPath, overlays);
    overlays.set(configPath, JSON.stringify({ extends: `./${basename(baseConfigPath)}`, compilerOptions: options.compilerOptionOverrides, ...(references.length === 0 ? {} : { references }) }));
    hidden.add(configPath);
  }
  return { configPath, overlays, hidden };
}
