// #region read-reminder
import { parse } from '@exprtlabs/golem/serde';
import { Reminder } from './reminder.model.js';

export function readReminder(text: string): Reminder {
  return parse<Reminder>(text); // -> a Reminder whose remindAt is a Date
}
// #endregion read-reminder
