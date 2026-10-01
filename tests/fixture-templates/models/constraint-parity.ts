import { identifier, tsSource, type SourceFragment } from '../../source-template.js';

export function containsSiblingConstraintSource({ tag }: { readonly tag: 'MinContains' | 'MaxContains' }): SourceFragment {
  const constraint = identifier(tag);
  return tsSource`import type { ${constraint} } from '@exprtlabs/golem/tags';
import type { IModel } from '@exprtlabs/golem/model';
import { ABaseModel, type AFields } from './a.model.generated.js';

export type TA = IModel<{ values: string[] & ${constraint}<1> }>;
export class A extends ABaseModel {
  constructor(values: Partial<AFields> = {}) { super(values); }
}
`;
}
