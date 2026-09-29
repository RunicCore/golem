
import type { IModel } from '@exprtlabs/codegen/model';
import type { MinLength } from '@exprtlabs/codegen/tags';
import { asGenObservable } from '@exprtlabs/codegen/mobx';
import { ChildBase, ParentBase } from './item.model.generated.js';
export type TChild = IModel<{ name: string & MinLength<2> }>;
export type TParent = IModel<{ projected: Readonly<{ child: TChild; note?: string }> }>;
export class Child extends ChildBase {}
export class Parent extends ParentBase {
  constructor(values: ConstructorParameters<typeof ParentBase>[0] = {}) { super(values); asGenObservable(this); }
}
