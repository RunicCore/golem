// The helpers that a package's `plan` entry may use. Core loads a plan entry at config time, so this module imports no yaml and no TypeScript.
import fs from 'node:fs';
import path from 'node:path';

/** The names of the two contracts that core owns, so a plan entry declares them without importing the rest of golem. */
export { CODECS_HOST, MODEL_BOUNDARY } from './job-facts.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `filename` as a message prints it: an absolute path relative to the working directory (`.` for the directory itself), any other name (a URL, a relative path) as written. */
export function displayPath(filename: string): string {
  return path.isAbsolute(filename) ? path.relative(process.cwd(), filename) || '.' : filename;
}

/**
 * The real path of `filename`: each link of its existing prefix is followed, and the part that does not exist yet stays
 * as written. A file reached through a folder link has the same real path as the file itself.
 */
export function canonicalPath(filename: string): string {
  let ancestor = path.resolve(filename);
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

/** Whether `filename` is `directory` or lies inside it, by path alone: the path from `directory` is not `..`, does not start with `..` and the separator, and is not absolute. */
export function isInsideDirectory(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
