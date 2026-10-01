
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import { ChildBaseModel, ParentBaseModel } from './item.model.generated.js';
export type TChild = IModel<{ name: string & MinLength<2> }>;
export type TParent = IModel<{ projected: Readonly<{ child: TChild; note?: string }> }>;
export class Child extends ChildBaseModel {}
export class Parent extends ParentBaseModel {
  constructor(values: ConstructorParameters<typeof ParentBaseModel>[0] = {}) { super(values); asGenObservable(this); }
}
