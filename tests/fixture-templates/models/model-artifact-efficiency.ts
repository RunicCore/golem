import { identifier, tsSource, type SourceFragment } from '../../source-template.js';

export function duplicateLocalNameReferenceModelSource(options: {
  readonly valueType: 'string' | 'number';
}): SourceFragment {
  return tsSource`
import type { IModel } from '@exprtlabs/codegen/model';
import type { Contains } from '@exprtlabs/codegen/tags';
import { ChildBase, ParentBase, type ChildFields, type ParentFields } from './things.model.generated.js';
export type TChild = IModel<{ value: ${identifier(options.valueType)} }>;
export type TParent = IModel<{ children: unknown[] & Contains<TChild> }>;
export class Child extends ChildBase { constructor(values: Partial<ChildFields> = {}) { super(values); } }
export class Parent extends ParentBase { constructor(values: Partial<ParentFields> = {}) { super(values); } }
`;
}
