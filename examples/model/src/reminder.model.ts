// #region date-field
import type { IModel } from '@exprtlabs/golem/model';
import { ReminderBase } from './reminder.model.generated.js';

export type TReminder = IModel<{
  title: string;
  remindAt: Date;
}>;

export class Reminder extends ReminderBase {}
// #endregion date-field
