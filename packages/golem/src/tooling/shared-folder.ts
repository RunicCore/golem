import { existsSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

// This module imports only node:fs and node:path: the watch needs it before any command has chosen a TypeScript.

export function canonicalFilename(filename: string): string {
  return normalize(resolve(filename));
}

/**
 * The folder a shared source belongs to: the nearest directory above it that holds a `package.json`, else its own
 * directory. A file of a shared folder is identified by its path from this folder, so every app that includes the folder
 * gives it the same identity.
 */
export function sharedFolderOf(source: string): string {
  const own = dirname(canonicalFilename(source));
  for (let directory = own; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    if (dirname(directory) === directory) return own;
  }
}
