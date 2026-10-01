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

type Email = string & Format<'email'>;
type Watchers = string[] & Contains<Email> & MinContains<1>;

type Reminders = {
  dueOn?: string;
  remindOn?: string;
} & DependentRequired<{ remindOn: ['dueOn'] }>;

export type TSubscription = IModel<{
  watchers: Watchers;
  reminders: Reminders;
}>;
export class Subscription extends TSubscriptionBaseModel {}

export async function checkSubscription(): Promise<[boolean, boolean]> {
  const accepted = {
    watchers: ['mina@example.com'],
    reminders: { dueOn: '2025-01-02', remindOn: '2025-01-01' },
  };
  const rejected = {
    watchers: ['mina@example.com'],
    reminders: { remindOn: '2025-01-01' },
  };
  return [
    (await validateInstance(new Subscription(accepted))).length === 0, // true
    (await validateInstance(new Subscription(rejected))).length === 0, // false: dueOn is missing
  ];
}
// #endregion collection-tags
