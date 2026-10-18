import type { IModel } from '@exprtlabs/golem/model';
import { TSnapshotBaseModel } from './snapshot.model.generated.js';

type OptionalTuple<T> = readonly [value?: T];

export type TSnapshot = IModel<{
  readonly names: readonly string[];
  readonly pair: readonly [head: string, count?: number];
  explicitUndefined?: readonly [head: string, count?: number | undefined];
  generic?: OptionalTuple<number>;
  genericUndefined?: OptionalTuple<number | undefined>;
  readonly trailing: readonly [head: string, ...middle: number[], tail: boolean];
}>;

export class Snapshot extends TSnapshotBaseModel {}
