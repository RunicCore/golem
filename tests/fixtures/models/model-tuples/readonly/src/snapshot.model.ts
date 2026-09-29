import type { IModel, ModelInit } from '@exprtlabs/codegen/model';
import { SnapshotBase } from './snapshot.model.generated.js';

type OptionalTuple<T> = readonly [value?: T];

export type TSnapshot = IModel<{
  readonly names: readonly string[];
  readonly pair: readonly [head: string, count?: number];
  explicitUndefined?: readonly [head: string, count?: number | undefined];
  generic?: OptionalTuple<number>;
  genericUndefined?: OptionalTuple<number | undefined>;
  readonly trailing: readonly [head: string, ...middle: number[], tail: boolean];
  required: string | { kind: 'required'; value: number };
  optional?: string | { kind: 'optional'; value: number };
  nested: { choice?: string | { kind: 'nested'; value: number } };
}>;

export class Snapshot extends SnapshotBase {}

type DeepInit = ModelInit<{ readonly values: readonly [head: { code: string }, ...tail: { label: string }[]] }>;
const deepInit: DeepInit = { values: [{}, { label: 'tail' }] };
void deepInit;
