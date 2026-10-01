import type { IModel } from '@exprtlabs/golem/model';
import { validateInstance, getValidator } from '@exprtlabs/golem/validation';
import { ChildBaseModel, RootBaseModel } from './getter-replay.model.generated.js';
export type TChild = IModel<{ value: number }>;
export type TRoot = IModel<{ child: TChild }>;
export class Child extends ChildBaseModel {}
export class Root extends RootBaseModel {}
export async function exercise() {
  const child = new Child({ value: 1 });
  const root = new Root({ child });
  let childReads = 0;
  let valueReads = 0;
  Object.defineProperty(root, "child", { enumerable: true, get() { childReads++; return child; } });
  Object.defineProperty(child, "value", { enumerable: true, get() { valueReads++; return "invalid"; } });
  const plain = await validateInstance(root);
  const plainReads = [childReads, valueReads];
  childReads = valueReads = 0;
  const registered = getValidator(child);
  registered.setErrors({ value: "existing display error" });
  registered.messages([{ path: ["value"], code: plain[0].code, message: "Enter a number" }]);
  const before = registered.issues;
  const withState = await validateInstance(root);
  return { plain, withState, plainReads, stateReads: [childReads, valueReads], stateUnchanged: registered.issues === before };
}