import type { IModel } from '@exprtlabs/golem/model';
import { TOfficeBaseModel } from './place.model.generated.js';
export type TPlace = IModel<{ id: string; city: string; country: string }>;
export type TOffice = IModel<{ place: Omit<TPlace, 'id'> }>;
export class Office extends TOfficeBaseModel {}
