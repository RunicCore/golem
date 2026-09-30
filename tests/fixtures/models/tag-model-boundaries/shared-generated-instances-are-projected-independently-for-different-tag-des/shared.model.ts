import type { IModel } from '@exprtlabs/golem/model';
import type { MinProperties } from '@exprtlabs/golem/tags';
import type { TSharedChild } from './child.model.js';
import { SharedBase, type SharedFields } from './shared.model.generated.js';
export type TShared = IModel<{ first: Pick<TSharedChild, 'value'> & MinProperties<1>; second: TSharedChild & MinProperties<2> }, { exact: true }>;
export class Shared extends SharedBase {
  constructor(values: Partial<SharedFields> = {}) { super(values); }
}