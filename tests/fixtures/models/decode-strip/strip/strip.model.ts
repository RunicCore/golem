import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { AdditionalProperties, Discriminator, PatternProperties, TSerde } from '@exprtlabs/golem/tags';
import { decodeUnits, encodeUnits } from './units.js';
import {
  TCardBaseModel, TPetHolderBaseModel, TShelfBaseModel, TTaggedBaseModel, TTaggedOpenBaseModel, TTallyBaseModel, TTreeBaseModel,
  type TCardFields, type TPetHolderFields, type TShelfFields, type TTaggedFields, type TTaggedOpenFields, type TTallyFields, type TTreeFields,
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
export type TItem = IObject<{ name: string }>;
export type TPatternItems = IObject<{ known?: string } & PatternProperties<{ '^x_': TItem }> & AdditionalProperties<never>>;
/** A tag that is the number 1 in one variant and the text '1' in the other. */
export type TTagTypes = IObject<{ item: ({ kind: 1; a: number } | { kind: '1'; b: number }) & Discriminator<'kind'> }>;
/** A tag called `__proto__`, which an object literal cannot hold as a key. */
export type TTagProto = IObject<{ item: ({ kind: '__proto__'; a: number } | { kind: 'plain'; b: number }) & Discriminator<'kind'> }>;
export type TCard = IModel<{ title: string; count?: number }>;
export type TShelf = IModel<{ cards: TCard[]; main: TCard }>;
export type TPetHolder = IModel<{ pet: (Cat | Dog) & Discriminator<'kind'> }>;
export type TTagged = IModel<{ item: (TMoney | { kind: 'other'; value: number }) & Discriminator<'kind', TMoney> }>;
export type TOpenOther = IObject<{ kind: 'open'; value: number }, { exact: false }>;
export type TTaggedOpen = IModel<{ item: (TMoney | TOpenOther) & Discriminator<'kind', TMoney> }>;
/** A value that is `{ units }` in the model and `{ amount }` on the wire. */
type Units = { units: number } & TSerde<typeof encodeUnits, typeof decodeUnits>;
export type TPriced = IObject<{ price: Units; note?: string }>;
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
export class TaggedOpen extends TTaggedOpenBaseModel {
  constructor(values: Partial<TTaggedOpenFields> = {}) { super(values); }
}
