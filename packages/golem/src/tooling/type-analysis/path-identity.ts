import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export function canonicalFilename(filename: string): string {
  return normalize(resolve(filename));
}

/** Whether `filename` lies outside `directory`, by path alone. */
export function isOutside(directory: string, filename: string): boolean {
  const path = relative(canonicalFilename(directory), canonicalFilename(filename));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}
