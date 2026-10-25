import type { IModel } from '@exprtlabs/golem/model';
import { TWhenBaseModel, type TWhenFields } from './when.model.generated.js';
export type TWhen = IModel<{
  at: Date | Date[];
  from: Date | string[];
  maybe?: Date | Date[] | null;
}>;
export class When extends TWhenBaseModel {
  constructor(values: TWhenFields) { super(values); }
}
