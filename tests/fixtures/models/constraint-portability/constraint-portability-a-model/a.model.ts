
import type { IModel } from '@exprtlabs/golem/model';
import type { Contains, IfThenElse, MaxContains, Not, OneOf, TValidation, UnevaluatedProperties } from '@exprtlabs/golem/tags';
import { positive, negative } from './rules.js';
import { ABaseModel } from './a.model.generated.js';
type Positive = number & TValidation<typeof positive>;
type Negative = number & TValidation<typeof negative>;
export type TA = IModel<{
  neg?: unknown & Not<Positive>;
  choice?: unknown & OneOf<[Positive, Negative]>;
  cond?: unknown & IfThenElse<{ n: Positive }, { label: string }, { code: number }>;
  counts?: unknown[] & Contains<Positive> & MaxContains<1>;
  annotated?: unknown & OneOf<[{ a: Positive }, { b: string }]> & UnevaluatedProperties<never>;
  builtin?: unknown & Not<number>;
}>;
export class A extends ABaseModel {}
