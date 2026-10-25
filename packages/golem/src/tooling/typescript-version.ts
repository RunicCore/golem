import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export class UnsupportedTypeScriptError extends Error {}
/** No TypeScript resolves at all, as opposed to one golem does not support: only commands that need a compiler treat it as an error. */
export class TypeScriptNotInstalledError extends UnsupportedTypeScriptError {}

export function resolveTypeScript(root: string, golemUrl = import.meta.url): { readonly version: string; readonly major: 6 | 7; readonly packageDir: string } {
  const manifest = resolveManifest(root, golemUrl);
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  const [major, minor] = version.split('.').map(Number);
  const packageDir = path.dirname(manifest);
  if (major !== 6 && !(major === 7 && minor >= 1)) {
    // TypeScript 7.0 serves the compiler API under typescript/unstable/*, which golem 1.1 does not load.
    const older = major === 7 ? ' golem 1.0 supports TypeScript 7.0.' : '';
    throw new UnsupportedTypeScriptError(`golem supports TypeScript 6.0+ and 7.1+; found ${version} at ${packageDir}.${older}`);
  }
  return { version, major, packageDir };
}

function resolveManifest(root: string, golemUrl: string): string {
  try {
    return createRequire(path.join(root, 'package.json')).resolve('typescript/package.json');
  } catch {
    try {
      return createRequire(golemUrl).resolve('typescript/package.json');
    } catch (error) {
      throw new TypeScriptNotInstalledError(`golem needs TypeScript 6.0+ or 7.1+ installed in ${root}.`, { cause: error });
    }
  }
}

/**
 * The TypeScript 7 backend imports the compiler API from golem's own location, so it can only serve the TypeScript 7
 * the project selected when that is the install golem resolves. Anything else would silently analyse with another compiler.
 */
export function assertGolemLoadsTypeScript(
  selected: { readonly version: string; readonly packageDir: string },
  golemUrl = import.meta.url,
): void {
  const golem = path.dirname(createRequire(golemUrl).resolve('typescript/package.json'));
  if (realpathSync(golem) === realpathSync(selected.packageDir)) return;
  const { version } = JSON.parse(readFileSync(path.join(golem, 'package.json'), 'utf8')) as { version: string };
  throw new UnsupportedTypeScriptError(
    `golem loads TypeScript 7 (${version}) from ${golem} but the project uses ${selected.version} at ${selected.packageDir}; install one TypeScript 7 for both.`,
  );
}
