// #region date-field
import type { IModel } from '@exprtlabs/golem/model';
import { TReminderBaseModel } from './reminder.model.generated.js';

export type TReminder = IModel<{
  title: string;
  remindAt: Date;
}>;

export class Reminder extends TReminderBaseModel {}
// #endregion date-field
