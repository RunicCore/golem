import type { IModel } from '@exprtlabs/golem/model';
import type { Contains, MaxContains, MaxProperties, MinContains, MinProperties, Not, OneOf, Pattern, PropertyNames } from '@exprtlabs/golem/tags';
import { TConstrainedBaseModel } from './constrained.model.generated.js';

export type TConstrained = IModel<{
  counts: { one?: string; two?: string; three?: string } & MinProperties<1> & MaxProperties<2>;
  contains: string[] & Contains<'hit'> & MinContains<1> & MaxContains<2>;
  names: Record<string, string> & PropertyNames<string & Pattern<'^[a-z]+$'>>;
  oneOf: { a?: string; b?: number } & OneOf<[{ a: string }, { b: number }]>;
  not: { forbidden?: string; allowed?: string } & Not<{ forbidden: string }>;
}>;

export class Constrained extends TConstrainedBaseModel {}
