import type { IModel } from '@exprtlabs/golem/model';
import {
  TAccountBaseModel,
  TChannelBaseModel,
  TCollectionBaseModel,
  TCompanyBaseModel,
  TDepartmentBaseModel,
  TEmployeeBaseModel,
  TEnterpriseBaseModel,
  TMemberBaseModel,
  TObjectSimpleBaseModel,
  TPoint3DBaseModel,
  TTimestampBaseModel,
} from './golem.model.generated.js';

// #region simple
export type TPoint3D = IModel<{
  x: number;
  y: number;
  z: number;
}>;
export class Point3D extends TPoint3DBaseModel {}

export type TObjectSimple = IModel<{
  scale: Point3D;
  position: Point3D;
  rotate: Point3D;
  pivot: Point3D;
}>;
export class ObjectSimple extends TObjectSimpleBaseModel {}
// #endregion simple

export type TAccount = IModel<{
  id: number;
  code: string;
  created_at: Timestamp;
}>;
export class Account extends TAccountBaseModel {}

export type TEnterprise = IModel<{
  id: number;
  account: Account;
  name: string;
  grade: number;
  created_at: Timestamp;
}>;
export class Enterprise extends TEnterpriseBaseModel {}

export type TChannel = IModel<{
  id: number;
  code: string;
  name: string;
  sequence: number;
  exclusive: boolean;
  priority: number;
  created_at: Timestamp;
}>;
export class Channel extends TChannelBaseModel {}

export type TMember = IModel<{
  id: number;
  account: Account;
  enterprise: Enterprise | null;
  emails: string[];
  created_at: Timestamp;
  authorized: boolean;
}>;
export class Member extends TMemberBaseModel {}

// #region array
export type TTimestamp = IModel<{
  time: number;
  zone: number;
}>;
export class Timestamp extends TTimestampBaseModel {}

export type TEmployee = IModel<{
  id: number;
  name: string;
  age: number;
  grade: number;
  employed_at: Timestamp;
}>;
export class Employee extends TEmployeeBaseModel {}

export type TDepartment = IModel<{
  id: number;
  code: string;
  sales: number;
  created_at: Timestamp;
  employees: Employee[];
}>;
export class Department extends TDepartmentBaseModel {}

export type TCompany = IModel<{
  id: number;
  serial: number;
  name: string;
  established_at: Timestamp;
  departments: Department[];
}>;
export class Company extends TCompanyBaseModel {}

export type TCollection = IModel<{
  data: Company[];
}>;
export class Collection extends TCollectionBaseModel {}
// #endregion array
