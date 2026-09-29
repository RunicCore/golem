import type { IModel } from '@exprtlabs/codegen/model';
import type { Contains, DependentSchemas } from '@exprtlabs/codegen/tags';
import { CalendarBase, type CalendarFields } from './calendar.model.generated.js';
export type TCalendar = IModel<{ dates: Array<Date> & Contains<Date>; metadata: { dates: Array<Date>; mode?: 'dated' } & DependentSchemas<{ mode: { dates: Array<Date> } }> }>;
export class Calendar extends CalendarBase {
  constructor(values: Partial<CalendarFields> = {}) { super(values); }
}