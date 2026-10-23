// #region exact-and-any
import type { IModel } from '@exprtlabs/golem/model';

export type TOpenLabel = IModel<{ name: string }, { exact: false }>;
export type TExactLabel = IModel<{ name: string }>;
export type TIntegrationEvent = IModel<{ payload: any }, { allowAny: true }>;
// #endregion exact-and-any

import { parse } from '@exprtlabs/golem/serde';

export function readLabelName(text: string): string {
  return parse<TOpenLabel>(text).name;
}

export function rejectsExtraProperty(text: string): boolean {
  try {
    parse<TExactLabel>(text);
    return false;
  } catch {
    return true;
  }
}

export function readIntegrationPayload(text: string): unknown {
  return parse<TIntegrationEvent>(text).payload;
}
