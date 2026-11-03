import { literal, tsSource, type SourceFragment } from '../../source-template.js';

export function builtinTagsModelSource({ mobx }: { readonly mobx: boolean }): SourceFragment {
  const mobxImport = mobx ? tsSource`import { asGenObservable } from '@exprtlabs/golem-openapi-ts/mobx';` : tsSource``;
  const mobxInitialization = mobx ? tsSource`asGenObservable(this);` : tsSource``;
  const emailPattern = literal('^\\p{Letter}+$');
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { ExclusiveMax, ExclusiveMin, ExclusiveMaximum, ExclusiveMinimum, Format, Integer, Max, MaxItems, MaxLength, Maximum, Min, MinItems, MinLength, Minimum, MultipleOf, Pattern, UniqueItems } from '@exprtlabs/golem/tags';
import { TABaseModel, type TAFields } from './a.model.generated.js';
${mobxImport}
export type TA = IModel<{
  integer: number & Integer;
  minimum: number & Minimum<3>;
  maximum: number & Maximum<7>;
  exclusiveMinimum: number & ExclusiveMinimum<3>;
  exclusiveMaximum: number & ExclusiveMaximum<7>;
  multipleOf: number & MultipleOf<2>;
  minLength: string & MinLength<3>;
  maxLength: string & MaxLength<5>;
  pattern: string & Pattern<${emailPattern}>;
  format: string & Format<'email'>;
  minItems: string[] & MinItems<2>;
  maxItems: string[] & MaxItems<3>;
  uniqueItems: string[] & UniqueItems;
  aliasMin: number & Min<3>;
  aliasMax: number & Max<7>;
  aliasExclusiveMin: number & ExclusiveMin<3>;
  aliasExclusiveMax: number & ExclusiveMax<7>;
}>;

export class A extends TABaseModel {
  constructor(values: Partial<TAFields> = {}) {
    super(values);
    ${mobxInitialization}
  }
}`;
}
