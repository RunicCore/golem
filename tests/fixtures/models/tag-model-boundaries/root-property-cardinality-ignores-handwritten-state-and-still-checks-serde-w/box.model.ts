import type { IModel } from '@exprtlabs/golem/model';
import type { MaxProperties, MinProperties } from '@exprtlabs/golem/tags';
import type { Code } from './codecs.js';
import { TBoxBaseModel, type TBoxFields } from './box.model.generated.js';
export type TBox = IModel<{ code?: Code; label?: string } & MinProperties<1> & MaxProperties<1>, { exact: true }>;
export class Box extends TBoxBaseModel {
  constructor(values: Partial<TBoxFields> = {}) { super(values); }
}
Object.defineProperty(Box.prototype, "savingState", { value: { dirty: true } });