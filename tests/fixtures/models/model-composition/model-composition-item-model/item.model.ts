
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { asGenObservable } from '@exprtlabs/golem-openapi-ts/mobx';
import { TChildBaseModel, TParentBaseModel } from './item.model.generated.js';
export type TChild = IModel<{ name: string & MinLength<2> }>;
export type TParent = IModel<{ projected: Readonly<{ child: TChild; note?: string }> }>;
export class Child extends TChildBaseModel {}
export class Parent extends TParentBaseModel {
  constructor(values: ConstructorParameters<typeof TParentBaseModel>[0] = {}) { super(values); asGenObservable(this); }
}
