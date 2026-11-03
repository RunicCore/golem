// #region read-schedule
import 'temporal-polyfill/global';
import { parse, stringify } from '@exprtlabs/golem/serde';
import { Schedule, type TSchedule } from './schedule.model.js';

export function readSchedule(text: string): Schedule {
  return parse<Schedule>(text); // -> a Schedule: startsAt is a Temporal.Instant, endsAt is 2025-01-02T04:34:05Z
}

export function writeSchedule(schedule: Schedule): string {
  // -> '{"startsAt":"2025-01-02T03:04:05Z","day":"2025-01-02","length":"PT1H30M"}'
  return stringify<TSchedule>(schedule);
}
// #endregion read-schedule
