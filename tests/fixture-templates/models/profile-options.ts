import { literal, tsSource, type SourceFragment } from '../../source-template.js';

export function modelAliasSource(options: {
  readonly declaration: SourceFragment;
}): SourceFragment {
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TPayload = ${options.declaration};
`;
}

export function referencedPolicyModelSource(options: {
  readonly childAllowsAny: boolean;
}): SourceFragment {
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TChild = IModel<{ payload: any }, { allowAny: ${literal(options.childAllowsAny)} }>;
export type TParent = IModel<{ child: TChild }>;
`;
}

export function taggedProfilePayloadSource(options: {
  readonly modelOptions: SourceFragment;
}): SourceFragment {
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { Format, MinLength, TValidation } from '@exprtlabs/golem/tags';
import { validText } from './validators.js';
export type TPayload = IModel<{ nested: { text: string & TValidation<typeof validText>; payload: any & MinLength<3>; opaque: unknown & Format<'uuid'> } }, ${options.modelOptions}>;
import { TPayloadBaseModel, type TPayloadFields } from './payload.model.generated.js';
export class Payload extends TPayloadBaseModel {
  constructor(values: Partial<TPayloadFields> = {}) { super(values); }
}
`;
}
