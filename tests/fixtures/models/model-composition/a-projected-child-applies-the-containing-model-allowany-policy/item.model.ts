
import type { IModel } from '@exprtlabs/codegen/model';
import { ChildBase, ContainerBase } from './item.model.generated.js';
export type TChild = IModel<{ id: string; raw: any }, { allowAny: true }>;
export type TContainer = IModel<{ child: Omit<TChild, 'id'> }, { allowAny: false }>;
export class Child extends ChildBase {}
export class Container extends ContainerBase {}
