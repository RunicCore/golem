// #region collection-tags
import type { IModel } from '@exprtlabs/golem/model';
import type {
  Contains,
  Format,
  MinContains,
  DependentRequired,
} from '@exprtlabs/golem/tags';
import { validateInstance } from '@exprtlabs/golem/validation';
import { TSubscriptionBaseModel } from './collection-tags.model.generated.js';

type WatcherEmail = string & Format<'email'>;
type Watchers = string[] & Contains<WatcherEmail> & MinContains<1>;

type DueDates = {
  dueOn?: string;
  remindOn?: string;
} & DependentRequired<{ remindOn: ['dueOn'] }>;

export type TSubscription = IModel<{
  watchers: Watchers;
  dates: DueDates;
}>;
export class Subscription extends TSubscriptionBaseModel {}

export async function checkSubscription(): Promise<[boolean, boolean]> {
  const accepted = {
    watchers: ['mina@example.com'],
    dates: { dueOn: '2025-01-02', remindOn: '2025-01-01' },
  };
  const rejected = {
    watchers: ['mina@example.com'],
    dates: { remindOn: '2025-01-01' },
  };
  // -> [true, false]: the rejected dates have remindOn but no dueOn
  return [
    (await validateInstance(new Subscription(accepted))).length === 0,
    (await validateInstance(new Subscription(rejected))).length === 0,
  ];
}
// #endregion collection-tags
