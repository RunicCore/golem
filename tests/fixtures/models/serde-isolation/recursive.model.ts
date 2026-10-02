import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TNodeBaseModel } from './recursive.model.generated.js';

export type TNode = IModel<{ label: string; children: TNode[] }>;
export class Node extends TNodeBaseModel {}
export type TTree = IObject<{ next?: TTree; meta?: unknown }>;
export type TRecord = IObject<{ payload: unknown }>;
export type TShelf = IObject<{ owner: TMerchant; extras: Record<string, unknown> }>;
export type TMerchant = IObject<{ id: string }>;
