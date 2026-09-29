
import type { IModel } from '@exprtlabs/codegen/model';
import type { TSerde } from '@exprtlabs/codegen/tags';
import { encode, decode, removedEncode, removedDecode } from './codecs.js';
import { ItemBase, ContainerBase } from './item.model.generated.js';
export type TItem = IModel<{ id: string & TSerde<typeof removedEncode, typeof removedDecode>; value: string & TSerde<typeof encode, typeof decode> }>;
export type TContainer = IModel<{ first: Omit<TItem, 'id'>; second?: Pick<TItem, 'value'> }>;
export class Item extends ItemBase {}
export class Container extends ContainerBase {}
