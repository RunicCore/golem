import type { AdditionalProperties, Contains, DependentRequired, DependentSchemas, IfThenElse, MaxContains, MaxProperties, MinContains, MinItems, MinProperties, Not, OneOf, Pattern, PatternProperties, PropertyNames, UnevaluatedProperties } from '@exprtlabs/golem/tags';
import type { IModel } from '@exprtlabs/golem/model';
import { TABaseModel, type TAFields } from './a.model.generated.js';

export type TA = IModel<{
  counts: { one?: string; two?: string; three?: string } & MinProperties<1> & MaxProperties<2>;
  contains: string[] & Contains<'hit'> & MinContains<1> & MaxContains<2>;
  containsPattern: string[] & Contains<string & Pattern<'^ok$'>> & MinItems<1> & MinContains<1> & MaxContains<2>;
  names: Record<string, string> & PropertyNames<string & Pattern<'^[a-z]+$'>>;
  patterns: { known?: string } & PatternProperties<{ '^x_': number; '^z_': boolean }> & AdditionalProperties<never>;
  additional: { known: string } & AdditionalProperties<number>;
  unevaluated: { known?: string; secondary?: number } & AdditionalProperties<never> & UnevaluatedProperties<never>;
  required: { card?: string; cvv?: string } & DependentRequired<{ card: ['cvv'] }>;
  schemas: { kind?: 'full'; detail?: string } & DependentSchemas<{ kind: { detail: string } }>;
  oneOf: { a?: string; b?: number } & OneOf<[{ a: string }, { b: number }]>;
  not: { forbidden?: string; allowed?: string } & Not<{ forbidden: string }>;
  conditional: { kind?: 'yes' | 'no'; value?: string; fallback?: number } & IfThenElse<{ kind: 'yes' }, { value: string }, { fallback: number }>;
  tuple: [string, number];
  booleanContains: boolean[] & Contains<false>;
  booleanNot: boolean & Not<true>;
  literalAdditional: { known?: string } & AdditionalProperties<false>;
}>;

export class A extends TABaseModel {
  constructor(values: Partial<TAFields> = {}) { super(values); }
}
