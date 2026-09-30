
import type { IModel } from '@exprtlabs/golem/model';
import { LeafBase, ContainerBase } from './item.model.generated.js';
export type TLeaf = IModel<{ id: string; raw: any }, { allowAny: true }>;
export type TContainer = IModel<{ child: Omit<TLeaf, 'id'> }, { allowAny: true }>;
export class Leaf extends LeafBase {}
export class Container extends ContainerBase {}
