import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TCardBaseModel, TTallyBaseModel, type TCardFields, type TTallyFields } from './getters.model.generated.js';
export type TPlain = IObject<{ title: string; count?: number }>;
export type TOuter = IObject<{ inner: TPlain }>;
export type TCard = IModel<{ title: string; count?: number }>;
export type TTally = IModel<{ id: string; [key: string]: string }>;
export class Card extends TCardBaseModel {
  constructor(values: Partial<TCardFields> = {}) { super(values); }
}
export class Tally extends TTallyBaseModel {
  constructor(values: Partial<TTallyFields> = {}) { super(values); }
}
