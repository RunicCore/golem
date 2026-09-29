import type { IModel } from '@exprtlabs/codegen/model';
import type { AdditionalProperties, PatternProperties, TValidation } from '@exprtlabs/codegen/tags';
import { positive } from './predicates.js';
import { BoxBase, type BoxFields } from './box.model.generated.js';
type Payload = { known?: string } & PatternProperties<{ '^x_': number & TValidation<typeof positive> }> & AdditionalProperties<never>;
export type TBox = IModel<{ payload?: Payload }, { exact: true }>;
export class Box extends BoxBase {
  constructor(values: Partial<BoxFields> = {}) { super(values); }
}