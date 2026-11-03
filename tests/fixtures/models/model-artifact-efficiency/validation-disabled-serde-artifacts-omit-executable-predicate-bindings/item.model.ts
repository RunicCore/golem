import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation, TSerde } from '@exprtlabs/golem/tags';
import type { accepts, encode, decode } from './codecs.js';
import { TItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<{ value: number & TValidation<typeof accepts> & TSerde<typeof encode, typeof decode> }>;
export class Item extends TItemBaseModel {}
