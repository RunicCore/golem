import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export class UnsupportedTypeScriptError extends Error {}

export function resolveTypeScript(root: string, golemUrl = import.meta.url): { readonly version: string; readonly major: 6 | 7; readonly packageDir: string } {
  const manifest = resolveManifest(root, golemUrl);
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  const major = Number(version.split('.')[0]);
  const packageDir = path.dirname(manifest);
  if (major !== 6 && major !== 7) {
    throw new UnsupportedTypeScriptError(`golem supports TypeScript 6.0+ and 7.x; found ${version} at ${packageDir}.`);
  }
  return { version, major, packageDir };
}

function resolveManifest(root: string, golemUrl: string): string {
  try {
    return createRequire(path.join(root, 'package.json')).resolve('typescript/package.json');
  } catch {
    try {
      return createRequire(golemUrl).resolve('typescript/package.json');
    } catch {
      throw new UnsupportedTypeScriptError(`golem needs TypeScript 6.0+ or 7.x installed in ${root}.`);
    }
  }
}

/**
 * The TypeScript 7 backend imports `typescript/unstable/*` from golem's own location, so it can only serve the TypeScript 7
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
