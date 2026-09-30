import type { IModel } from '@exprtlabs/golem/model';
import {
  AccountBase,
  ChannelBase,
  CollectionBase,
  CompanyBase,
  DepartmentBase,
  EmployeeBase,
  EnterpriseBase,
  MemberBase,
  ObjectSimpleBase,
  Point3DBase,
  TimestampBase,
} from './golem.model.generated.js';

// #region simple
export type TPoint3D = IModel<{
  x: number;
  y: number;
  z: number;
}>;
export class Point3D extends Point3DBase {}

export type TObjectSimple = IModel<{
  scale: Point3D;
  position: Point3D;
  rotate: Point3D;
  pivot: Point3D;
}>;
export class ObjectSimple extends ObjectSimpleBase {}
// #endregion simple

export type TAccount = IModel<{
  id: number;
  code: string;
  created_at: Timestamp;
}>;
export class Account extends AccountBase {}

export type TEnterprise = IModel<{
  id: number;
  account: Account;
  name: string;
  grade: number;
  created_at: Timestamp;
}>;
export class Enterprise extends EnterpriseBase {}

export type TChannel = IModel<{
  id: number;
  code: string;
  name: string;
  sequence: number;
  exclusive: boolean;
  priority: number;
  created_at: Timestamp;
}>;
export class Channel extends ChannelBase {}

export type TMember = IModel<{
  id: number;
  account: Account;
  enterprise: Enterprise | null;
  emails: string[];
  created_at: Timestamp;
  authorized: boolean;
}>;
export class Member extends MemberBase {}

// #region array
export type TTimestamp = IModel<{
  time: number;
  zone: number;
}>;
export class Timestamp extends TimestampBase {}

export type TEmployee = IModel<{
  id: number;
  name: string;
  age: number;
  grade: number;
  employed_at: Timestamp;
}>;
export class Employee extends EmployeeBase {}

export type TDepartment = IModel<{
  id: number;
  code: string;
  sales: number;
  created_at: Timestamp;
  employees: Employee[];
}>;
export class Department extends DepartmentBase {}

export type TCompany = IModel<{
  id: number;
  serial: number;
  name: string;
  established_at: Timestamp;
  departments: Department[];
}>;
export class Company extends CompanyBase {}

export type TCollection = IModel<{
  data: Company[];
}>;
export class Collection extends CollectionBase {}
// #endregion array
