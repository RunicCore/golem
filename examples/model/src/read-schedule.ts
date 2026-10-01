// #region read-schedule
import 'temporal-polyfill/global';
import { parse, stringify } from '@exprtlabs/golem/serde';
import { Schedule, type TSchedule } from './schedule.model.js';

export function readSchedule(text: string): Schedule {
  const schedule = parse<Schedule>(text);
  console.log(schedule.startsAt instanceof Temporal.Instant); // true
  console.log(schedule.endsAt.toString()); // 2025-01-02T04:34:05Z
  return schedule;
}

export function writeSchedule(schedule: Schedule): string {
  return stringify<TSchedule>(schedule);
  // '{"startsAt":"2025-01-02T03:04:05Z","day":"2025-01-02","length":"PT1H30M"}'
}
// #endregion read-schedule
