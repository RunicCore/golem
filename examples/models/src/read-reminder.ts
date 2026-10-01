// #region read-reminder
import { parse } from '@exprtlabs/golem/serde';
import { Reminder } from './reminder.model.js';

export function readReminder(text: string): Reminder {
  const reminder = parse<Reminder>(text);
  console.log(reminder.remindAt instanceof Date); // true
  return reminder;
}
// #endregion read-reminder
