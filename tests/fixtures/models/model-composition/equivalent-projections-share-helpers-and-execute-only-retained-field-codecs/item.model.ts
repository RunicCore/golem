
import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { encode, decode, removedEncode, removedDecode } from './codecs.js';
import { TItemBaseModel, TContainerBaseModel } from './item.model.generated.js';
export type TItem = IModel<{ id: string & TSerde<typeof removedEncode, typeof removedDecode>; value: string & TSerde<typeof encode, typeof decode> }>;
export type TContainer = IModel<{ first: Omit<TItem, 'id'>; second?: Pick<TItem, 'value'> }>;
export class Item extends TItemBaseModel {}
export class Container extends TContainerBaseModel {}
