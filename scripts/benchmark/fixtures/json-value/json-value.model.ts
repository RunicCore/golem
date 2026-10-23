import type { IModel } from '@exprtlabs/golem/model';
import { TJsonDocBaseModel } from './json-value.model.generated.js';

// A model with a recursive JSON value field: the cost of its untagged union and of the pre-walk of a validated encode.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TJsonDoc = IModel<{ id: number; payload: JsonValue }>;
export class JsonDoc extends TJsonDocBaseModel {}

/** A JSON value of about 60 nodes: scalars, arrays and records three levels deep. */
export function jsonPayload(): JsonValue {
  const leaf = (n: number): JsonValue => ({ id: n, name: `item ${n}`, tags: ['a', 'b', 'c'], active: n % 2 === 0, score: n / 3, parent: null });
  return { items: [leaf(1), leaf(2), leaf(3), leaf(4)], meta: { page: 1, total: 4, filters: { kind: ['x', 'y'], range: [1, 2, 3] } }, note: 'valid' };
}
