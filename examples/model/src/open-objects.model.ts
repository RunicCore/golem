// #region exact-and-any
import type { IModel } from '@exprtlabs/golem/model';

export type TOpen = IModel<{ name: string }, { exact: false }>;
export type TExact = IModel<{ name: string }>;
export type TExternal = IModel<{ payload: any }, { allowAny: true }>;
// #endregion exact-and-any

import { parse } from '@exprtlabs/golem/serde';
// Registers the generated codecs; the types above have no class that imports them.
import './open-objects.model.generated.js';

export function readOpenName(text: string): string {
  return parse<TOpen>(text).name;
}

export function rejectsExtraProperty(text: string): boolean {
  try {
    parse<TExact>(text);
    return false;
  } catch {
    return true;
  }
}

export function readExternalPayload(text: string): unknown {
  return parse<TExternal>(text).payload;
}
