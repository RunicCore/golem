import type { IModel } from '@exprtlabs/golem/model';
import type { MaxProperties, MinProperties } from '@exprtlabs/golem/tags';
import type { Code } from './codecs.js';
import { BoxBase, type BoxFields } from './box.model.generated.js';
export type TBox = IModel<{ code?: Code; label?: string } & MinProperties<1> & MaxProperties<1>, { exact: true }>;
export class Box extends BoxBase {
  constructor(values: Partial<BoxFields> = {}) { super(values); }
}
Object.defineProperty(Box.prototype, "savingState", { value: { dirty: true } });