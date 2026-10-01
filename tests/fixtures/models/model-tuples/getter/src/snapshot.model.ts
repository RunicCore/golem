import type { IModel } from '@exprtlabs/golem/model';
import { TSnapshotBaseModel } from './snapshot.model.generated.js';

export type TSnapshot = IModel<{
  names: string[];
  pair: [head: string, count?: number];
  trailing: [head: string, ...middle: number[], tail: boolean];
  required: string | { kind: 'required'; value: number };
  optional?: string | { kind: 'optional'; value: number };
  nested: { choice?: string | { kind: 'nested'; value: number }; label: string };
  createdAt: Date;
}>;

export class Snapshot extends TSnapshotBaseModel {}
