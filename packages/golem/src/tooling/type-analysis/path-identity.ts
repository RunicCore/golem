import { normalize, relative, resolve } from 'node:path';

import { canonicalPath } from '../generator-core.js';

export function canonicalFilename(filename: string): string {
  return normalize(resolve(filename));
}

/**
 * Stable source identity used in generated metadata.  Absolute paths are
 * useful while resolving a program but would make generated output depend on
 * the checkout directory.  Keep the first portable workspace boundary and
 * discard the machine-specific prefix.
 */
export function portableRelativeFilename(filename: string, root: string): string {
  return relative(canonicalFilename(root), canonicalFilename(filename)).replace(/\\/g, '/');
}

/**
 * Whether a module specifier is a relative path: `.`, `..`, or one that starts with `./` or `../`. A name that merely starts
 * with a dot, such as `.shared/m.js`, is a bare package specifier.
 */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** The specifier for a path that `relative` made from a folder: `./` in front unless it is already relative, as a path into a `.shared` folder is not. */
export function relativeSpecifierOf(relativePath: string): string {
  return isRelativeSpecifier(relativePath) ? relativePath : `./${relativePath}`;
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
