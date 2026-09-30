
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import { ChildBase, ParentBase } from './item.model.generated.js';
export type TChild = IModel<{ name: string & MinLength<2> }>;
export type TParent = IModel<{ projected: Readonly<{ child: TChild; note?: string }> }>;
export class Child extends ChildBase {}
export class Parent extends ParentBase {
  constructor(values: ConstructorParameters<typeof ParentBase>[0] = {}) { super(values); asGenObservable(this); }
}
