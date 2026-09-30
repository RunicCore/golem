import type { IObject } from '@exprtlabs/golem/model';
import type { Integer, MaxItems, MaxLength, MinItems, MinLength, Minimum, Pattern } from '@exprtlabs/golem/tags';

// The upstream payloads as IObject declarations: validated plain objects, no classes.
// #region simple
export type TPlainPoint3D = IObject<{
  x: number;
  y: number;
  z: number;
}>;
export type TPlainObjectSimple = IObject<{
  scale: TPlainPoint3D;
  position: TPlainPoint3D;
  rotate: TPlainPoint3D;
  pivot: TPlainPoint3D;
}>;
// #endregion simple

// #region array
export type TPlainTimestamp = IObject<{
  time: number;
  zone: number;
}>;
export type TPlainEmployee = IObject<{
  id: number;
  name: string;
  age: number;
  grade: number;
  employed_at: TPlainTimestamp;
}>;
export type TPlainDepartment = IObject<{
  id: number;
  code: string;
  sales: number;
  created_at: TPlainTimestamp;
  employees: TPlainEmployee[];
}>;
export type TPlainCompany = IObject<{
  id: number;
  serial: number;
  name: string;
  established_at: TPlainTimestamp;
  departments: TPlainDepartment[];
}>;
export type TPlainCollection = IObject<{
  data: TPlainCompany[];
}>;
// #endregion array

// #region nested
export type TPlainConstrainedTimestamp = IObject<{
  time: number;
  zone: number;
}>;
export type TPlainConstrainedAccount = IObject<{
  id: number & Integer & Minimum<1>;
  code: string & MinLength<3>;
  created_at: TPlainConstrainedTimestamp;
}>;
export type TPlainConstrainedEnterprise = IObject<{
  id: number & Integer & Minimum<1>; account: TPlainConstrainedAccount; name: string & MinLength<2>;
  grade: number & Integer & Minimum<1>; created_at: TPlainConstrainedTimestamp;
}>;
export type TPlainConstrainedChannel = IObject<{
  id: number & Integer & Minimum<1>; code: string & MinLength<2> & MaxLength<16> & Pattern<'^[a-z]+$'>; name: string & MinLength<2>;
  sequence: number & Integer & Minimum<1>; exclusive: boolean; priority: number & Integer & Minimum<0>; created_at: TPlainConstrainedTimestamp;
}>;
export type TPlainConstrainedMember = IObject<{
  id: number & Integer & Minimum<1>; account: TPlainConstrainedAccount; enterprise: TPlainConstrainedEnterprise | null;
  emails: (string & MinLength<3>)[] & MinItems<1> & MaxItems<3>; created_at: TPlainConstrainedTimestamp; authorized: boolean;
}>;
export type TPlainConstrainedObjectHierarchical = IObject<{
  id: number & Integer & Minimum<1>; channel: TPlainConstrainedChannel; member: TPlainConstrainedMember | null;
  account: TPlainConstrainedAccount | null; href: string & MinLength<8> & Pattern<'^https://'>;
  referrer: string & MinLength<8> & Pattern<'^https://'>; ip: [number, number, number, number] & MinItems<4> & MaxItems<4>;
  created_at: TPlainConstrainedTimestamp;
}>;
// #endregion nested
