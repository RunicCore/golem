import { IssueCode } from '@exprtlabs/codegen/errors';
import type { IModel } from '@exprtlabs/codegen/model';
import type { MinProperties } from '@exprtlabs/codegen/tags';
import { getValidator, validateInstance } from '@exprtlabs/codegen/validation';
import { encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { ChildBase, RootBase } from './example.model.generated.js';
export type TChild = IModel<{ value: number } & MinProperties<2>>;
export type TRoot = IModel<{ child: TChild }>;
export class Child extends ChildBase {}
export class Root extends RootBase {}
export async function exercise() {
  const child = new Child({ value: 1 });
  const root = new Root({ child });
  const registered = getValidator(child);
  registered.setErrors({ value: "existing display error" });
  registered.messages([{ path: [], code: IssueCode.MinProperties, message: "Child needs two fields." }]);
  getValidator(root).messages([{ path: ['child'], code: IssueCode.MinProperties, message: "Child needs two fields." }]);
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