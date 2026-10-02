import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { TDepartmentBaseModel, TEmployeeBaseModel } from './department.model.generated.js';

export type TEmployee = IModel<{ name: string & MinLength<1>; age: number }>;
export type TDepartment = IModel<{ title: string; head?: TEmployee; employees: TEmployee[] }>;
export class Employee extends TEmployeeBaseModel {}
export class Department extends TDepartmentBaseModel {}
