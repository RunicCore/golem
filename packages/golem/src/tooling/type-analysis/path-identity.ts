import { normalize, resolve } from 'node:path';

import { canonicalPath } from '../generator-api.js';

export function canonicalFilename(filename: string): string {
  return normalize(resolve(filename));
}

/**
 * Whether `filename` belongs to an installed package: `node_modules` is in its path, and still in its real path. A workspace
 * package linked into `node_modules` keeps that path under `preserveSymlinks`, but its real path lies elsewhere, and it is
 * the project's own code.
 */
export function isInstalledFile(filename: string): boolean {
  const inNodeModules = (candidate: string): boolean => candidate.split(/[\\/]/).includes('node_modules');
  return inNodeModules(filename) && inNodeModules(canonicalPath(filename));
}
