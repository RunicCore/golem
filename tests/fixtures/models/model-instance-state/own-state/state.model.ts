import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TBagBaseModel, TBoardBaseModel, TEmptyBaseModel, TFreeBaseModel, TNoteBaseModel, TStampsBaseModel, TTallyBaseModel, TTaskBaseModel, type TBagFields, type TBoardFields, type TEmptyFields, type TFreeFields, type TNoteFields, type TStampsFields, type TTallyFields, type TTaskFields } from './state.model.generated.js';
export type TSmall = IObject<{ title: string }>;
export type TTask = IModel<{ title: string; done?: boolean }>;
export type TBoard = IModel<{ lead: TTask }>;
export type TBag = IModel<{ id: string; [key: string]: unknown }, { allowAny: true }>;
// A dynamic map whose values convert to Dates.
export type TStamps = IModel<{ first: Date; [key: string]: Date }>;
export type TTally = IModel<{ id: string; [key: string]: string }>;
// Models with no declared field: open only by default, and a dynamic map.
export type TEmpty = IModel<{}>;
export type TNote = IModel<{ title: string; data: unknown }, { allowAny: true }>;
export type TFree = IModel<{ [key: string]: unknown }, { allowAny: true }>;
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
export class Tally extends TTallyBaseModel {
  constructor(values: Partial<TTallyFields> = {}) { super(values); }
}
export class Empty extends TEmptyBaseModel {
  constructor(values: Partial<TEmptyFields> = {}) { super(values); }
}
export class Free extends TFreeBaseModel {
  constructor(values: Partial<TFreeFields> = {}) { super(values); }
}
export class Note extends TNoteBaseModel {
  constructor(values: Partial<TNoteFields> = {}) { super(values); }
}
export class Stamps extends TStampsBaseModel {
  constructor(values: Partial<TStampsFields> = {}) { super(values); }
}
