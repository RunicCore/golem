import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TBoardBaseModel, TTaskBaseModel, type TBoardFields, type TTaskFields } from './state.model.generated.js';
export type TSmall = IObject<{ title: string }>;
export type TTask = IModel<{ title: string; done?: boolean }>;
export type TBoard = IModel<{ lead: TTask }>;
export class Task extends TTaskBaseModel {
  cache = new Map<string, string>();
  hits: number;
  constructor(values: Partial<TTaskFields> = {}) { super(values); this.hits = 3; }
  get label(): string { return `task:${this.title}`; }
}
export class Board extends TBoardBaseModel {
  constructor(values: Partial<TBoardFields> = {}) { super(values); }
}
