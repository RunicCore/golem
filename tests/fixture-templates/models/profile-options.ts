import { literal, tsSource, type SourceFragment } from '../../source-template.js';

export function modelAliasSource(options: {
  readonly declaration: SourceFragment;
}): SourceFragment {
  return tsSource`import type { IModel } from '@exprtlabs/codegen/model';
export type TPayload = ${options.declaration};
`;
}

export function referencedPolicyModelSource(options: {
  readonly childAllowsAny: boolean;
}): SourceFragment {
  return tsSource`import type { IModel } from '@exprtlabs/codegen/model';
export type TChild = IModel<{ payload: any }, { allowAny: ${literal(options.childAllowsAny)} }>;
export type TParent = IModel<{ child: TChild }>;
`;
}

export function taggedProfilePayloadSource(options: {
  readonly modelOptions: SourceFragment;
}): SourceFragment {
  return tsSource`import type { IModel } from '@exprtlabs/codegen/model';
import type { Format, MinLength, TValidation } from '@exprtlabs/codegen/tags';
import { validText } from './validators.js';
export type TPayload = IModel<{ nested: { text: string & TValidation<typeof validText>; payload: any & MinLength<3>; opaque: unknown & Format<'domain-specific'> } }, ${options.modelOptions}>;
import { PayloadBase, type PayloadFields } from './payload.model.generated.js';
export class Payload extends PayloadBase {
  constructor(values: Partial<PayloadFields> = {}) { super(values); }
}
`;
}
