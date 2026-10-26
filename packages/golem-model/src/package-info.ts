import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayPath } from '@exprtlabs/golem/generator-api';

const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

function readPackageVersion(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'version' in value && typeof value.version === 'string') return value.version;
  throw new TypeError(`${displayPath(packageJsonPath)} is missing a string version`);
}

/** The version of this package, which the header of every generated file records. */
export const PACKAGE_VERSION = readPackageVersion(JSON.parse(readFileSync(packageJsonPath, 'utf8')));
