import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareText } from '@exprtlabs/golem/generator-api';
import { copiedRuntimeSpecifiers, renderModule } from '@exprtlabs/golem/internal/emitter';
import { generatedBannerComment } from './package-info.js';

/** The folder of a standalone SDK that holds the copy of the golem runtime. */
const RUNTIME_FOLDER = 'runtime';
const VALUE_FILE = 'runtime.js';
const TYPES_FILE = 'runtime.types.js';
const shippedFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sdk-runtime');

/** What an SDK file imports its runtime from: the specifiers of the file named, relative to the SDK folder. */
export type RuntimeSpecifiers = (file: string) => ReturnType<typeof copiedRuntimeSpecifiers>;

/** The specifiers of a standalone SDK file: the facade for values and the barrel for types, both relative to the file. */
export const standaloneRuntimeSpecifiers: RuntimeSpecifiers = (file) => {
  const toRuntime = path.posix.relative(path.posix.dirname(`/${file}`), `/${RUNTIME_FOLDER}`);
  const from = (name: string): string => `${toRuntime.startsWith('.') ? toRuntime : `./${toRuntime}`}/${name}`;
  return copiedRuntimeSpecifiers(from(VALUE_FILE), from(TYPES_FILE));
};

function* filesBelow(directory: string, relative = ''): Generator<string> {
  const entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) yield* filesBelow(directory, name);
    else yield name;
  }
}

/**
 * The shipped runtime as the files of a standalone SDK, in code point order, under `RUNTIME_FOLDER`. Each file opens with the
 * ownership header, so the job records and owns it; the shipped text follows unchanged.
 */
export function runtimeCopy(): ReadonlyMap<string, string> {
  const header = `${renderModule(generatedBannerComment()).source}\n`;
  return new Map([...filesBelow(shippedFolder)].map((name) => [
    path.posix.join(RUNTIME_FOLDER, name),
    `${header}${fs.readFileSync(path.join(shippedFolder, name), 'utf8')}`,
  ]));
}
