// #region nested-and-derived
import type { IModel } from '@exprtlabs/golem/model';
import { parse } from '@exprtlabs/golem/serde';
import { TAssigneeBaseModel, TPlaceBaseModel } from './assignee.model.generated.js';

export type TPlace = IModel<{
  id: string;
  city: string;
  country: string;
}>;
export class Place extends TPlaceBaseModel {}

export type TAssignee = IModel<{
  office: Place;
  site: Omit<TPlace, 'id'>;
  draft: Partial<Pick<TPlace, 'city' | 'country'>>;
}>;
export class Assignee extends TAssigneeBaseModel {}

export function loadAssignee(): Assignee {
  const assignee = parse<Assignee>(JSON.stringify({
    office: { id: 'place-1', city: 'Hanoi', country: 'VN' },
    site: { city: 'Da Nang', country: 'VN' },
    draft: { city: 'Hue' },
  }));
  console.log(assignee.office instanceof Place); // true
  console.log(Object.getPrototypeOf(assignee.site) === Object.prototype); // true
  return assignee;
}
// #endregion nested-and-derived
