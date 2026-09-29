import type { IModel } from '@exprtlabs/codegen/model';
import { ABase, type AFields } from './a.model.generated.js';
import type { Contains, TValidation } from '@exprtlabs/codegen/tags';
import type { TChild } from './child.model.js';
import { childPredicate } from './predicates.js';

export type TA = IModel<{
  children?: unknown[] & Contains<TChild & TValidation<typeof childPredicate>>;
}>;

export class A extends ABase {
  constructor(values: Partial<AFields> = {}) { super(values); }
}
