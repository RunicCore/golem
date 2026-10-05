import type { IModel } from '@exprtlabs/golem/model';
import type { MinProperties } from '@exprtlabs/golem/tags';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { TTagChildBaseModel, TTagRootBaseModel } from './tag-message.model.generated.js';
export type TTagChild = IModel<{ value: number } & MinProperties<2>>;
export type TTagRoot = IModel<{ child: TTagChild }>;
export class TagChild extends TTagChildBaseModel {}
export class TagRoot extends TTagRootBaseModel {}
export async function exercise() {
  const child = new TagChild({ value: 1 });
  const root = new TagRoot({ child });
  const registered = getValidator(child);
  registered.setErrors({ value: "existing display error" });
  registered.messages([{ path: [], code: 'tooSmall', message: "Child needs two fields." }]);
  getValidator(root).messages([{ path: ['child'], code: 'tooSmall', message: "Child needs two fields." }]);
  const beforeIssues = registered.issues;
  const beforePending = registered.pending;
  const issues = await validateInstance(root);
  const wire = encodeGeneratedModel(root);
  return {
    issue: issues[0],
    matchingMessages: issues.filter(item => item.message === "Child needs two fields.").length,
    wire,
    stateUnchanged: registered.issues === beforeIssues && registered.pending === beforePending,
  };
}