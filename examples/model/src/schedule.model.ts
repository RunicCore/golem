// #region temporal-fields
import type { IModel } from '@exprtlabs/golem/model';
import type { TemporalDuration, TemporalInstant, TemporalPlainDate } from '@exprtlabs/golem/temporal';
import { ScheduleBase } from './schedule.model.generated.js';

export type TSchedule = IModel<{
  startsAt: TemporalInstant;
  day: TemporalPlainDate;
  length: TemporalDuration;
}>;

export class Schedule extends ScheduleBase {
  public get endsAt(): Temporal.Instant {
    return this.startsAt.add(this.length);
  }
}
// #endregion temporal-fields
