// The helpers that a package's `plan` entry may use. Core loads a plan entry at config time, so this module imports no yaml and no TypeScript.
import fs from 'node:fs';
import path from 'node:path';

/** The names of the two contracts that core owns, so a plan entry declares them without importing the rest of golem. */
export { CODECS_HOST, MODEL_BOUNDARY } from './job-facts.js';

import { isRecord } from '../record.js';

export { isRecord };

/** `value` as a string with text in it; any other value throws a `TypeError` that names `label`. */
export function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

/** `filename` as a message prints it: an absolute path relative to the working directory (`.` for the directory itself), any other name (a URL, a relative path) as written. */
export function displayPath(filename: string): string {
  return path.isAbsolute(filename) ? path.relative(process.cwd(), filename) || '.' : filename;
}

/** Whether `error` is a system error with the code `code`. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** What the symbolic link `link` points at, as written; undefined when `link` is no link or does not exist. */
function linkTarget(link: string): string | undefined {
  try { return fs.readlinkSync(link); }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR') || hasErrorCode(error, 'EINVAL')) return undefined;
    throw error;
  }
}

/** `filename` resolved through every link on the way, also a link that leads nowhere yet; `followed` holds the links met so far, so a loop of links ends. */
function followLinks(filename: string, followed: Set<string>): string | undefined {
  try { return fs.realpathSync.native(filename); }
  catch (error) {
    if (hasErrorCode(error, 'ELOOP')) return undefined;
    if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR')) throw error;
  }
  const real = followLinks(path.dirname(filename), followed);
  if (real === undefined) return undefined;
  const link = path.join(real, path.basename(filename));
  const target = linkTarget(link);
  if (target === undefined) return link;
  if (followed.has(link)) return undefined;
  followed.add(link);
  return followLinks(path.resolve(real, target), followed);
}

/**
 * The real path of `filename`: each link on the way is followed, also a link that leads nowhere yet, and the part that does not exist
 * stays as written. A file reached through a folder link has the same real path as the file itself. undefined when links loop.
 */
export function realPathThroughLinks(filename: string): string | undefined {
  return followLinks(path.resolve(filename), new Set());
}

/** The real path of `filename` (see `realPathThroughLinks`); links that loop stop with a plain error, since no real path exists. */
export function canonicalPath(filename: string): string {
  const real = realPathThroughLinks(filename);
  if (real === undefined) throw new Error(`The links on the way to ${displayPath(filename)} lead back to themselves, so it has no real path.`);
  return real;
}

/** Whether `filename` is `directory` or lies inside it, by path alone: the path from `directory` is not `..`, does not start with `..` and the separator, and is not absolute. */
export function isInsideDirectory(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** The file the host of the codecs writes for the SDK in `sdkOutput`: below `modelsOutput`, at the SDK's folder relative to the golem.yaml folder, ending `.sdk.generated.ts`. */
export function sdkCodecsFile(where: { readonly modelsOutput: string; readonly configDirectory: string; readonly sdkOutput: string }): string {
  const relative = path.relative(where.configDirectory, where.sdkOutput);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`An SDK of mode golem lies in a folder below the golem.yaml folder; ${where.sdkOutput} does not (golem.yaml folder ${where.configDirectory}).`);
  }
  return path.join(where.modelsOutput, `${relative}.sdk.generated.ts`);
}

/** The `suffixes` of a block, `label` naming it in an error: file-name endings that start with `.`, end in `.ts`, `.mts` or `.cts`, never repeat, never name a declaration file and never name a generated file. */
export function checkedSuffixes(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a nonempty array.`);
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !entry.startsWith('.') || !/\.[cm]?ts$/.test(entry)) {
      throw new Error(`${label}[${index}] must be a string that starts with "." and ends in .ts, .mts or .cts.`);
    }
    if (/\.d\.[cm]?ts$/.test(entry)) throw new Error(`${label}[${index}] must not end in .d.ts, .d.mts or .d.cts: a declaration file cannot be a source.`);
    if (/\.generated\.[cm]?ts$/.test(entry)) throw new Error(`${label}[${index}] must not end in .generated.ts, .generated.mts or .generated.cts: golem writes those files.`);
    if (seen.has(entry)) throw new Error(`${label} lists ${entry} twice.`);
    seen.add(entry);
  }
  return value;
}
