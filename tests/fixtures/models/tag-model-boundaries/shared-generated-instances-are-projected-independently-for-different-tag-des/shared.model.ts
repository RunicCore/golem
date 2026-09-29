import type { IModel } from '@exprtlabs/codegen/model';
import type { MinProperties } from '@exprtlabs/codegen/tags';
import type { TChild } from './child.model.js';
import { SharedBase, type SharedFields } from './shared.model.generated.js';
export type TShared = IModel<{ first: Pick<TChild, 'value'> & MinProperties<1>; second: TChild & MinProperties<2> }, { exact: true }>;
export class Shared extends SharedBase {
  constructor(values: Partial<SharedFields> = {}) { super(values); }
}