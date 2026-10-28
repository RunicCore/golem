import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import { TInventoryBaseModel } from './inventory.model.generated.js';

export type TInventory = IModel<{
  names: string[];
  counts: Record<string, number>;
  payload: unknown;
  extras: Record<string, unknown>;
  until: Date | null;
  channel: ({ kind: 'open' } | { kind: 'hold'; until: Date }) & Discriminator<'kind'>;
  tag?: 'a' | 'b' | ('a' | 'b')[];
  memo?: string;
}, { allowAny: true }>;

export class Inventory extends TInventoryBaseModel {}
