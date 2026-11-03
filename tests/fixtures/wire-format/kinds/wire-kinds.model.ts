import type { IModel } from '@exprtlabs/golem/model';
import type { Maximum, MinLength, TValidation } from '@exprtlabs/golem/tags';
import { isKnown } from './rules.js';
import { TWireKindsBaseModel } from './wire-kinds.model.generated.js';

export type TWireKinds = IModel<{
  code: `SKU-${string}`;
  flag: boolean & TValidation<typeof isKnown>;
  status: 'open' | 'closed';
  level: 1 | 2;
  label: string & MinLength<1>;
  count: number & Maximum<10>;
}>;

export class WireKinds extends TWireKindsBaseModel {}
