import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TBagBaseModel, TBoardBaseModel, TTaskBaseModel, type TBagFields, type TBoardFields, type TTaskFields } from './state.model.generated.js';
export type TSmall = IObject<{ title: string }>;
export type TTask = IModel<{ title: string; done?: boolean }>;
export type TBoard = IModel<{ lead: TTask }>;
export type TBag = IModel<{ id: string; [key: string]: unknown }, { allowAny: true }>;
export class Task extends TTaskBaseModel {
  cache = new Map<string, string>();
  hits: number;
  constructor(values: Partial<TTaskFields> = {}) { super(values); this.hits = 3; }
  get label(): string { return `task:${this.title}`; }
}
export class Board extends TBoardBaseModel {
  constructor(values: Partial<TBoardFields> = {}) { super(values); }
}
export class Bag extends TBagBaseModel {
  constructor(values: Partial<TBagFields> = {}) { super(values); }
}
