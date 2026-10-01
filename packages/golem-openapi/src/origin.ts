import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NameScope } from '@exprtlabs/golem/generator-api';
import { escapeJsonPointerToken } from './json.js';

/**
 * Maps a JSON Pointer into the bundled document to the location it came from,
 * such as `pets.json#/Pet`. Without one, generator errors name bundled
 * component keys only.
 */
export type OriginLocator = (pointer: string) => string;

export function displayUri(uri: string, rootDirectory: string): string {
  const url = new URL(uri);
  return url.protocol === 'file:'
    ? path.relative(rootDirectory, fileURLToPath(url)).split(path.sep).join('/')
    : uri;
}

export function displayLocation(uri: string, pointer: string, rootDirectory: string): string {
  return `${displayUri(uri, rootDirectory)}#${pointer}`;
}

/** A piece of an error message and the bundled-document pointer it names. */
export interface MessageOrigin {
  readonly text: string;
  readonly pointer: string;
}

/** An error that names bundled components; `annotateWithOrigins` adds where each came from. */
export class LocatedError extends Error {
  constructor(message: string, readonly origins: readonly MessageOrigin[], options?: ErrorOptions) {
    super(message, options);
  }
}

export function componentOrigin(kind: 'schemas' | 'securitySchemes', key: string, text: string): MessageOrigin {
  return { text, pointer: `/components/${kind}/${escapeJsonPointerToken(key)}` };
}

/** Run `run`; with a locator, append ` (<origin>)` after the first occurrence of each named text in a `LocatedError`. */
export function withOrigins<T>(locate: OriginLocator | undefined, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!locate || !(error instanceof LocatedError)) throw error;
    let message = error.message;
    for (const origin of error.origins) {
      const at = message.indexOf(origin.text);
      if (at < 0) continue;
      const end = at + origin.text.length;
      message = `${message.slice(0, end)} (${locate(origin.pointer)})${message.slice(end)}`;
    }
    throw new Error(message, { cause: error.cause });
  }
}

/** A `NameScope` whose collisions name the components that claimed the name. */
export class ComponentNameScope extends NameScope {
  private readonly claimedBy = new Map<string, MessageOrigin & { readonly claim: string }>();

  override claim(name: string, origin: string, schemaKey?: string): void {
    const earlier = this.claimedBy.get(name);
    try {
      super.claim(name, origin);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const origins = [earlier, schemaKey === undefined ? undefined : { ...componentOrigin('schemas', schemaKey, origin), claim: origin }]
        .flatMap((entry) => (entry ? [{ text: entry.claim, pointer: entry.pointer }] : []));
      throw new LocatedError(error.message, origins);
    }
    if (schemaKey !== undefined) this.claimedBy.set(name, { ...componentOrigin('schemas', schemaKey, origin), claim: origin });
  }
}
