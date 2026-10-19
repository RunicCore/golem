import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import {
  TMobxAddressBaseModel, TMobxArrayBaseModel, TMobxCircleBaseModel, TMobxFlatBaseModel, TMobxItemBaseModel,
  TMobxLabelBaseModel, TMobxNestedBaseModel, TMobxOwnerBaseModel, TMobxRectBaseModel, TMobxTupleBaseModel,
  TMobxUnionBaseModel,
  type TMobxArrayInit, type TMobxFlatInit, type TMobxNestedInit, type TMobxTupleInit, type TMobxUnionInit,
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

/** The twin factories of this file; the typia comparison builds each MobX value from plain initial data. */
export const mobxTwins: Readonly<Record<string, { readonly codecId: string; readonly make: (init: unknown) => object }>> = {
  flat: { codecId: 'TMobxFlat', make: init => new MobxFlat(init as TMobxFlatInit) },
  nested: { codecId: 'TMobxNested', make: init => new MobxNested(init as TMobxNestedInit) },
  union: { codecId: 'TMobxUnion', make: init => new MobxUnion(init as TMobxUnionInit) },
  array: { codecId: 'TMobxArray', make: init => new MobxArray(init as TMobxArrayInit) },
  tuple: { codecId: 'TMobxTuple', make: init => new MobxTuple(init as TMobxTupleInit) },
};
