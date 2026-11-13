import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { AdditionalProperties, Discriminator, PatternProperties } from '@exprtlabs/golem/tags';
import {
  TCardBaseModel, TPetHolderBaseModel, TShelfBaseModel, TTaggedBaseModel, TTallyBaseModel, TTreeBaseModel,
  type TCardFields, type TPetHolderFields, type TShelfFields, type TTaggedFields, type TTallyFields, type TTreeFields,
} from './strip.model.generated.js';

type Cat = { kind: 'cat'; lives: number };
type Dog = { kind: 'dog'; barks: boolean };

export type TPlain = IObject<{ title: string; count?: number }>;
export type TNested = IObject<{ inner: TPlain; list: TPlain[] }>;
export type TNullable = IObject<{ child: TPlain | null }>;
export type TMoney = IObject<{ amount: number }>;
export type TOpen = IObject<{ title: string }, { exact: false }>;
export type TMapHolder = IObject<{ tags: Record<string, TPlain> }>;
export type TPatterned = IObject<{ known?: string } & PatternProperties<{ '^x_': number }> & AdditionalProperties<never>>;
export type TCard = IModel<{ title: string; count?: number }>;
export type TShelf = IModel<{ cards: TCard[]; main: TCard }>;
export type TPetHolder = IModel<{ pet: (Cat | Dog) & Discriminator<'kind'> }>;
export type TTagged = IModel<{ item: (TMoney | { kind: 'other'; value: number }) & Discriminator<'kind', TMoney> }>;
export type TTree = IModel<{ name: string; kids?: TTree[] }>;
export type TTally = IModel<{ id: string; [key: string]: string }>;

export class Card extends TCardBaseModel {
  constructor(values: Partial<TCardFields> = {}) { super(values); }
}
export class Shelf extends TShelfBaseModel {
  constructor(values: Partial<TShelfFields> = {}) { super(values); }
}
export class PetHolder extends TPetHolderBaseModel {
  constructor(values: Partial<TPetHolderFields> = {}) { super(values); }
}
export class Tree extends TTreeBaseModel {
  constructor(values: Partial<TTreeFields> = {}) { super(values); }
}
export class Tally extends TTallyBaseModel {
  constructor(values: Partial<TTallyFields> = {}) { super(values); }
}
export class Tagged extends TTaggedBaseModel {
  constructor(values: Partial<TTaggedFields> = {}) { super(values); }
}
