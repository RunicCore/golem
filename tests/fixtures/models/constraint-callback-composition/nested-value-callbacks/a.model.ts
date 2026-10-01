import type { IModel } from '@exprtlabs/golem/model';
import { ABaseModel, type AFields } from './a.model.generated.js';
import type { Contains, IfThenElse, Not, OneOf, TValidation } from '@exprtlabs/golem/tags';
import { nestedPositive, nonEmpty, positive } from './predicates.js';

export type TA = IModel<{
  values?: unknown[] & Contains<number & TValidation<typeof positive>>;
  plain?: { value: number & TValidation<typeof nestedPositive> };
  one?: unknown & OneOf<[number & TValidation<typeof positive>, string & TValidation<typeof nonEmpty>]>;
  blocked?: unknown & Not<number & TValidation<typeof positive>>;
  conditional?: { kind?: string; value?: number } & IfThenElse<{ kind: 'number' }, { value: number & TValidation<typeof positive> }, { kind: 'text' }>;
}>;

export class A extends ABaseModel {
  constructor(values: Partial<AFields> = {}) { super(values); }
}
