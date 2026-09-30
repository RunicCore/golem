import type { IModel } from '@exprtlabs/golem/model';
import { ParentBase, type ParentFields } from './parent.model.generated.js';
import { Child } from './child.model.js';
import type { TChild } from './child.model.js';
import type { TSerde } from '@exprtlabs/golem/tags';
import { encodeOptional, decodeOptional } from './optional-codec.js';
export type TParent = IModel<{ child: TChild; note?: string; code?: string & TSerde<typeof encodeOptional, typeof decodeOptional>; label: string; __serdeAccessorProbe?: string }>;
export class Parent extends ParentBase {
  public static constructed = 0;
  public static setterCalls = 0;
  public static sawChildInstance = false;
  public static sawExtra = false;
  public static sawExtraValue: unknown;
  public static initializerPrototype: object | null = null;
  constructor(values: Partial<ParentFields> = {}) {
    Parent.sawChildInstance = values.child instanceof Child;
    Parent.sawExtra = Object.hasOwn(values, "extra");
    Parent.sawExtraValue = (values as Record<string, unknown>).extra;
    Parent.initializerPrototype = Object.getPrototypeOf(values);
    super(values);
    Parent.constructed += 1;
  }
}
Object.defineProperty(Parent.prototype, "child", {
  configurable: true,
  get(): unknown { return undefined; },
  set(_value: unknown): void { Parent.setterCalls += 1; },
});