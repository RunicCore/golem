import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { ShortBase, LongBase, ContainerBase } from './item.model.generated.js';
export type TShort = IModel<{ value: string & MinLength<1> }>;
export type TLong = IModel<{ value: string & MinLength<3> }>;
export type TContainer = IModel<{ first: Pick<TShort, 'value'>; second: Pick<TLong, 'value'> }>;
export class Short extends ShortBase {}
export class Long extends LongBase {}
export class Container extends ContainerBase {}