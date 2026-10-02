import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export class UnsupportedTypeScriptError extends Error {}

export function resolveTypeScript(root: string): { readonly version: string; readonly major: 6 | 7; readonly packageDir: string } {
  const manifest = resolveManifest(root);
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  const major = Number(version.split('.')[0]);
  const packageDir = path.dirname(manifest);
  if (major !== 6 && major !== 7) {
    throw new UnsupportedTypeScriptError(`golem supports TypeScript 6.0+ and 7.x; found ${version} at ${packageDir}.`);
  }
  return { version, major, packageDir };
}

function resolveManifest(root: string): string {
  try {
    return createRequire(path.join(root, 'package.json')).resolve('typescript/package.json');
  } catch {
    return createRequire(import.meta.url).resolve('typescript/package.json');
  }
}
