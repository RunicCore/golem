import type { IModel } from '@exprtlabs/golem/model';
import type { Contains, DependentSchemas } from '@exprtlabs/golem/tags';
import { TCalendarBaseModel, type TCalendarFields } from './calendar.model.generated.js';
export type TCalendar = IModel<{ dates: Array<Date> & Contains<Date>; metadata: { dates: Array<Date>; mode?: 'dated' } & DependentSchemas<{ mode: { dates: Array<Date> } }> }>;
export class Calendar extends TCalendarBaseModel {
  constructor(values: Partial<TCalendarFields> = {}) { super(values); }
}