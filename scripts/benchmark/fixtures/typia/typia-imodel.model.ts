import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { TwinFactories } from './compare-case.js';
import {
  TTwinAddressBaseModel, TTwinArrayBaseModel, TTwinCircleBaseModel, TTwinFlatBaseModel, TTwinItemBaseModel,
  TTwinLabelBaseModel, TTwinNestedBaseModel, TTwinOptionalBaseModel, TTwinOwnerBaseModel, TTwinRectBaseModel,
  TTwinTupleBaseModel, TTwinUnionBaseModel,
  type TTwinArrayInit, type TTwinFlatInit, type TTwinNestedInit, type TTwinOptionalInit, type TTwinTupleInit, type TTwinUnionInit,
} from './typia-imodel.model.generated.js';
import { codecIdOf } from './codec-id.js';

// The IModel twins of the typia comparison models (typia-comparison.model.ts): the same fields, declared as IModel, so
// each validated value is a class instance. Nested models are classes, as the models guide declares them.
export type TTwinFlat = IModel<{
  id: number;
  name: string;
  email: string;
  age: number;
  score: number;
  active: boolean;
  createdAt: Date;
}>;
export class TwinFlat extends TTwinFlatBaseModel {}

export type TTwinAddress = IModel<{
  street: string;
  city: string;
  zip: string;
  lat: number;
  lng: number;
}>;
export class TwinAddress extends TTwinAddressBaseModel {}

export type TTwinOwner = IModel<{
  name: string;
  email: string;
  address: TwinAddress;
}>;
export class TwinOwner extends TTwinOwnerBaseModel {}

export type TTwinNested = IModel<{
  id: number;
  owner: TwinOwner;
  billing: TwinAddress;
  shipping: TwinAddress;
  createdAt: Date;
}>;
export class TwinNested extends TTwinNestedBaseModel {}

export type TTwinCircle = IModel<{ kind: 'circle'; radius: number; at: Date }>;
export class TwinCircle extends TTwinCircleBaseModel {}
export type TTwinRect = IModel<{ kind: 'rect'; width: number; height: number; at: Date }>;
export class TwinRect extends TTwinRectBaseModel {}
export type TTwinLabel = IModel<{ kind: 'label'; text: string; at: Date }>;
export class TwinLabel extends TTwinLabelBaseModel {}

export type TTwinUnion = IModel<{
  id: number;
  shape: (TwinCircle | TwinRect | TwinLabel) & Discriminator<'kind'>;
}>;
export class TwinUnion extends TTwinUnionBaseModel {}

export type TTwinItem = IModel<{
  id: number;
  sku: string;
  name: string;
  price: number;
  quantity: number;
  createdAt: Date;
}>;
export class TwinItem extends TTwinItemBaseModel {}

export type TTwinArray = IModel<{
  id: number;
  items: TwinItem[];
}>;
export class TwinArray extends TTwinArrayBaseModel {}

export type TTwinTuple = IModel<{
  id: number;
  row: [number, string, boolean, Date];
  range: [number, number];
}>;
export class TwinTuple extends TTwinTupleBaseModel {}

export type TTwinOptional = IModel<{
  id: number;
  name: string;
  nickname?: string;
  note?: string;
  createdAt: Date;
}>;
export class TwinOptional extends TTwinOptionalBaseModel {}

// A value is built from plain initial data; the constructor makes each nested model a class instance.
export const imodelTwins: TwinFactories = {
  flat: { codecId: codecIdOf('TTwinFlat'), make(init: TTwinFlatInit) { return new TwinFlat(init); } },
  nested: { codecId: codecIdOf('TTwinNested'), make(init: TTwinNestedInit) { return new TwinNested(init); } },
  union: { codecId: codecIdOf('TTwinUnion'), make(init: TTwinUnionInit) { return new TwinUnion(init); } },
  array: { codecId: codecIdOf('TTwinArray'), make(init: TTwinArrayInit) { return new TwinArray(init); } },
  tuple: { codecId: codecIdOf('TTwinTuple'), make(init: TTwinTupleInit) { return new TwinTuple(init); } },
  optional: { codecId: codecIdOf('TTwinOptional'), make(init: TTwinOptionalInit) { return new TwinOptional(init); } },
};
