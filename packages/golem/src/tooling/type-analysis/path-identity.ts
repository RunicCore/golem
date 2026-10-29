import { normalize, resolve } from 'node:path';

import { canonicalPath } from '../generator-core.js';

export function canonicalFilename(filename: string): string {
  return normalize(resolve(filename));
}

/** Whether a path lies in a `node_modules` folder, whichever separator it uses. */
export function inNodeModules(filename: string): boolean {
  return filename.split(/[\\/]/).includes('node_modules');
}

/**
 * Whether `filename` belongs to an installed package: `node_modules` is in its path, and still in its real path. A workspace
 * package linked into `node_modules` keeps that path under `preserveSymlinks`, but its real path lies elsewhere, and it is
 * the project's own code.
 */
export function isInstalledFile(filename: string): boolean {
  return inNodeModules(filename) && inNodeModules(canonicalPath(filename));
}
