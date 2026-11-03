
import type { IModel } from '@exprtlabs/golem/model';
import { TLeafBaseModel, TContainerBaseModel } from './item.model.generated.js';
export type TLeaf = IModel<{ id: string; raw: any }, { allowAny: true }>;
export type TContainer = IModel<{ child: Omit<TLeaf, 'id'> }, { allowAny: false }>;
export class Leaf extends TLeafBaseModel {}
export class Container extends TContainerBaseModel {}
