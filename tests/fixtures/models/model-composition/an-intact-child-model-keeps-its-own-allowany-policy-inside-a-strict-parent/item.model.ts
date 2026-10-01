
import type { IModel } from '@exprtlabs/golem/model';
import { ChildBaseModel, ContainerBaseModel } from './item.model.generated.js';
export type TChild = IModel<{ raw: any }, { allowAny: true }>;
export type TContainer = IModel<{ child: TChild }, { allowAny: false }>;
export class Child extends ChildBaseModel {}
export class Container extends ContainerBaseModel {}
