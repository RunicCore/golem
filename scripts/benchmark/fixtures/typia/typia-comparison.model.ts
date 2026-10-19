import type { IObject } from '@exprtlabs/golem/model';

// Validation against typia on one set of models: golem generates its validator from each IObject, typia from the same
// type. Plain types only: no constraint tags, so both sides check types and structure. `Date` fields give decode and
// encode a conversion to do.
export type TCompareFlat = IObject<{
  id: number;
  name: string;
  email: string;
  age: number;
  score: number;
  active: boolean;
  createdAt: Date;
}>;

export type TCompareAddress = IObject<{
  street: string;
  city: string;
  zip: string;
  lat: number;
  lng: number;
}>;

export type TCompareOwner = IObject<{
  name: string;
  email: string;
  address: TCompareAddress;
}>;

export type TCompareNested = IObject<{
  id: number;
  owner: TCompareOwner;
  billing: TCompareAddress;
  shipping: TCompareAddress;
  createdAt: Date;
}>;

export type TCompareUnion = IObject<{
  id: number;
  shape:
    | { kind: 'circle'; radius: number; at: Date }
    | { kind: 'rect'; width: number; height: number; at: Date }
    | { kind: 'label'; text: string; at: Date };
}>;

export type TCompareItem = IObject<{
  id: number;
  sku: string;
  name: string;
  price: number;
  quantity: number;
  createdAt: Date;
}>;

export type TCompareArray = IObject<{
  id: number;
  items: TCompareItem[];
}>;

export type TCompareTuple = IObject<{
  id: number;
  row: [number, string, boolean, Date];
  range: [number, number];
}>;

// One optional field absent and one present: MobX defines the absent one as an own `undefined` key.
export type TCompareOptional = IObject<{
  id: number;
  name: string;
  nickname?: string;
  note?: string;
  createdAt: Date;
}>;
