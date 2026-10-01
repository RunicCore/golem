
import type { IModel } from '@exprtlabs/golem/model';
import { TChildBaseModel, TContainerBaseModel } from './item.model.generated.js';
export type TChild = IModel<{ raw: any }, { allowAny: true }>;
export type TContainer = IModel<{ child: TChild }, { allowAny: false }>;
export class Child extends TChildBaseModel {}
export class Container extends TContainerBaseModel {}
