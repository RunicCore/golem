/**
 * The registry of object codecs by id, and of the codec id of each model class. It imports no conversion code, so
 * `conversion.ts` can find the codec of a model without an import cycle through `object-codec.ts`, which re-exports it.
 */

import { LibError, LibErrorKind } from './errors.js';
import type { ObjectCodec } from './object-codec.js';

const codecs = new Map<string, ObjectCodec>();
const codecIdByConstructor = new WeakMap<Function, string>();

export function registerObjectCodec<T>(codec: ObjectCodec<T>): void {
  codecs.set(codec.id, codec);
}

export function getObjectCodec<T = unknown>(id: string): ObjectCodec<T> | undefined {
  return codecs.get(id) as ObjectCodec<T> | undefined;
}

export function requireObjectCodec<T = unknown>(id: string): ObjectCodec<T> {
  const codec = getObjectCodec<T>(id);
  if (!codec) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `golem fault: the IObject codec ${JSON.stringify(id)} is not registered. `
      + `The rewrite loads the generated module that registers a codec wherever it names one, and that module did not load. Run golem generate and rewrite the file again.`,
    );
  }
  return codec;
}

export function linkConstructorToCodec(constructor: Function, codecId: string): void {
  codecIdByConstructor.set(constructor, codecId);
}

export function findCodecIdForConstructor(constructor: Function): string | undefined {
  return codecIdByConstructor.get(constructor);
}
