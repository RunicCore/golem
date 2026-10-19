import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import {
  TMobxAddressBaseModel, TMobxArrayBaseModel, TMobxCircleBaseModel, TMobxFlatBaseModel, TMobxItemBaseModel,
  TMobxLabelBaseModel, TMobxNestedBaseModel, TMobxOptionalBaseModel, TMobxOwnerBaseModel, TMobxRectBaseModel,
  TMobxTupleBaseModel, TMobxUnionBaseModel,
  type TMobxArrayInit, type TMobxFlatInit, type TMobxNestedInit, type TMobxOptionalInit, type TMobxTupleInit, type TMobxUnionInit,
} from './typia-mobx.model.generated.js';

// The MobX twins of the typia comparison models: the IModel twins (typia-imodel.model.ts) with `mobx: true`, each class
// observable. MobX defines a declared field as an own accessor and a missing one as an own `undefined`.
export type TMobxFlat = IModel<{
  id: number;
  name: string;
  email: string;
  age: number;
  score: number;
  active: boolean;
  createdAt: Date;
}>;
export class MobxFlat extends TMobxFlatBaseModel {
  public constructor(values: TMobxFlatInit) { super(values); asGenObservable(this); }
}

export type TMobxAddress = IModel<{
  street: string;
  city: string;
  zip: string;
  lat: number;
  lng: number;
}>;
export class MobxAddress extends TMobxAddressBaseModel {
  public constructor(values: ConstructorParameters<typeof TMobxAddressBaseModel>[0]) { super(values); asGenObservable(this); }
}

export type TMobxOwner = IModel<{
  name: string;
  email: string;
  address: MobxAddress;
}>;
export class MobxOwner extends TMobxOwnerBaseModel {
  public constructor(values: ConstructorParameters<typeof TMobxOwnerBaseModel>[0]) { super(values); asGenObservable(this); }
}

export type TMobxNested = IModel<{
  id: number;
  owner: MobxOwner;
  billing: MobxAddress;
  shipping: MobxAddress;
  createdAt: Date;
}>;
export class MobxNested extends TMobxNestedBaseModel {
  public constructor(values: TMobxNestedInit) { super(values); asGenObservable(this); }
}

export type TMobxCircle = IModel<{ kind: 'circle'; radius: number; at: Date }>;
export class MobxCircle extends TMobxCircleBaseModel {
  public constructor(values: ConstructorParameters<typeof TMobxCircleBaseModel>[0]) { super(values); asGenObservable(this); }
}
export type TMobxRect = IModel<{ kind: 'rect'; width: number; height: number; at: Date }>;
export class MobxRect extends TMobxRectBaseModel {
  public constructor(values: ConstructorParameters<typeof TMobxRectBaseModel>[0]) { super(values); asGenObservable(this); }
}
export type TMobxLabel = IModel<{ kind: 'label'; text: string; at: Date }>;
export class MobxLabel extends TMobxLabelBaseModel {
  public constructor(values: ConstructorParameters<typeof TMobxLabelBaseModel>[0]) { super(values); asGenObservable(this); }
}

export type TMobxUnion = IModel<{
  id: number;
  shape: MobxCircle | MobxRect | MobxLabel;
}>;
export class MobxUnion extends TMobxUnionBaseModel {
  public constructor(values: TMobxUnionInit) { super(values); asGenObservable(this); }
}

export type TMobxItem = IModel<{
  id: number;
  sku: string;
  name: string;
  price: number;
  quantity: number;
  createdAt: Date;
}>;
export class MobxItem extends TMobxItemBaseModel {
  public constructor(values: ConstructorParameters<typeof TMobxItemBaseModel>[0]) { super(values); asGenObservable(this); }
}

export type TMobxArray = IModel<{
  id: number;
  items: MobxItem[];
}>;
export class MobxArray extends TMobxArrayBaseModel {
  public constructor(values: TMobxArrayInit) { super(values); asGenObservable(this); }
}

export type TMobxTuple = IModel<{
  id: number;
  row: [number, string, boolean, Date];
  range: [number, number];
}>;
export class MobxTuple extends TMobxTupleBaseModel {
  public constructor(values: TMobxTupleInit) { super(values); asGenObservable(this); }
}

export type TMobxOptional = IModel<{
  id: number;
  name: string;
  nickname?: string;
  note?: string;
  createdAt: Date;
}>;
export class MobxOptional extends TMobxOptionalBaseModel {
  public constructor(values: TMobxOptionalInit) { super(values); asGenObservable(this); }
}

/**
 * The twin factories of this file; the typia comparison builds each MobX value from plain initial data. This is the
 * `TwinFactories` shape of typia/compare-case.ts, written out: the MobX project is generated and compiled from this folder alone.
 */
export const mobxTwins: Readonly<Record<string, { readonly codecId: string; make(init: unknown): object }>> = {
  flat: { codecId: 'TMobxFlat', make(init: TMobxFlatInit) { return new MobxFlat(init); } },
  nested: { codecId: 'TMobxNested', make(init: TMobxNestedInit) { return new MobxNested(init); } },
  union: { codecId: 'TMobxUnion', make(init: TMobxUnionInit) { return new MobxUnion(init); } },
  array: { codecId: 'TMobxArray', make(init: TMobxArrayInit) { return new MobxArray(init); } },
  tuple: { codecId: 'TMobxTuple', make(init: TMobxTupleInit) { return new MobxTuple(init); } },
  optional: { codecId: 'TMobxOptional', make(init: TMobxOptionalInit) { return new MobxOptional(init); } },
};
