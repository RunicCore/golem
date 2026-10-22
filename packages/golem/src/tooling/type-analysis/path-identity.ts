import { normalize, resolve } from 'node:path';

export function canonicalFilename(filename: string): string {
  return normalize(resolve(filename));
}
