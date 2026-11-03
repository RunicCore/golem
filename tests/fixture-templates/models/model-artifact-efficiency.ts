import { identifier, tsSource, type SourceFragment } from '../../source-template.js';

export function duplicateLocalNameReferenceModelSource(options: {
  readonly valueType: 'string' | 'number';
}): SourceFragment {
  return tsSource`
import type { IModel } from '@exprtlabs/golem/model';
import type { Contains } from '@exprtlabs/golem/tags';
import { TChildBaseModel, TParentBaseModel, type TChildFields, type TParentFields } from './things.model.generated.js';
export type TChild = IModel<{ value: ${identifier(options.valueType)} }>;
export type TParent = IModel<{ children: unknown[] & Contains<TChild> }, { allowAny: true }>;
export class Child extends TChildBaseModel { constructor(values: Partial<TChildFields> = {}) { super(values); } }
export class Parent extends TParentBaseModel { constructor(values: Partial<TParentFields> = {}) { super(values); } }
`;
}
