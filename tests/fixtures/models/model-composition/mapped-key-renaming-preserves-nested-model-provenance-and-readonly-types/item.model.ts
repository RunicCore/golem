
import type { IModel } from '@exprtlabs/golem/model';
import { TResidenceBaseModel, TContactBaseModel, TItemBaseModel } from './item.model.generated.js';
export type TResidence = IModel<{ city: string }>;
export type TContact = IModel<{ home: TResidence }>;
type Renamed<T> = { readonly [K in keyof T as `copy_${string & K}`]: T[K] };
type Writable<T> = { -readonly [K in keyof T]: T[K] };
export type TItem = IModel<{ contact: Renamed<TContact>; writable?: Writable<{ readonly code: string }> }>;
export class Residence extends TResidenceBaseModel {}
export class Contact extends TContactBaseModel {}
export class Item extends TItemBaseModel {}
