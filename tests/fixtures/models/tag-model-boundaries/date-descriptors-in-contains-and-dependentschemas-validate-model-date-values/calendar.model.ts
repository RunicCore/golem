import type { IModel } from '@exprtlabs/golem/model';
import type { Contains, DependentSchemas } from '@exprtlabs/golem/tags';
import { CalendarBaseModel, type CalendarFields } from './calendar.model.generated.js';
export type TCalendar = IModel<{ dates: Array<Date> & Contains<Date>; metadata: { dates: Array<Date>; mode?: 'dated' } & DependentSchemas<{ mode: { dates: Array<Date> } }> }>;
export class Calendar extends CalendarBaseModel {
  constructor(values: Partial<CalendarFields> = {}) { super(values); }
}