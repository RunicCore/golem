import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { TCompanyBaseModel, TNodeBaseModel } from './company.model.generated.js';

export type TEmployee = IModel<{ name: string & MinLength<1>; age: number }>;
export type TDepartment = IModel<{ title: string; employees: TEmployee[] }>;
export type TCompany = IModel<{ departments: TDepartment[] }>;
export type TNode = IModel<{ label: string; children: TNode[] }>;
export class Company extends TCompanyBaseModel {}
export class Node extends TNodeBaseModel {}
