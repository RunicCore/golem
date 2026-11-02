import type { IModel } from '@exprtlabs/golem/model';
import type { UniqueItems } from '@exprtlabs/golem/tags';
import type { TemporalDuration, TemporalInstant, TemporalPlainDate, TemporalPlainDateTime, TemporalPlainTime, TemporalZonedDateTime } from '@exprtlabs/golem/temporal';
import { TTemporalFieldsBaseModel, TTreeNodeBaseModel, TUniqueObjectsBaseModel, TUniqueStringsBaseModel } from './runtime-paths.model.generated.js';

/** Twenty fields on the six Temporal classes: four instants, three zoned date-times, four dates, three date-times, three times and three durations. */
export type TTemporalFields = IModel<{
  createdAt: TemporalInstant; updatedAt: TemporalInstant; expiresAt: TemporalInstant; shippedAt: TemporalInstant;
  opensAt: TemporalZonedDateTime; closesAt: TemporalZonedDateTime; nextRun: TemporalZonedDateTime;
  birthday: TemporalPlainDate; startDate: TemporalPlainDate; endDate: TemporalPlainDate; dueDate: TemporalPlainDate;
  scheduled: TemporalPlainDateTime; reviewed: TemporalPlainDateTime; archived: TemporalPlainDateTime;
  doorOpens: TemporalPlainTime; doorCloses: TemporalPlainTime; lunch: TemporalPlainTime;
  setup: TemporalDuration; runtime: TemporalDuration; cooldown: TemporalDuration;
}>;
export class TemporalFields extends TTemporalFieldsBaseModel {}

/** A model that holds a list of itself: the recursive model of the golem guide. */
export type TTreeNode = IModel<{ label: string; children: TTreeNode[] }>;
export class TreeNode extends TTreeNodeBaseModel {}

/** A list of 1,000 strings under the `UniqueItems` tag. */
export type TUniqueStrings = IModel<{ names: string[] & UniqueItems }>;
export class UniqueStrings extends TUniqueStringsBaseModel {}

/** A list of 100 small objects under the `UniqueItems` tag. */
export type TUniqueObjects = IModel<{ points: { x: number; y: number; label: string }[] & UniqueItems }>;
export class UniqueObjects extends TUniqueObjectsBaseModel {}
