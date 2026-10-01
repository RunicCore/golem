import type { IModel } from '@exprtlabs/golem/model';
import type { AdditionalProperties, PatternProperties, TValidation } from '@exprtlabs/golem/tags';
import { positive } from './predicates.js';
import { PatternBoxBaseModel, type PatternBoxFields } from './box.model.generated.js';
type Payload = { known?: string } & PatternProperties<{ '^x_': number & TValidation<typeof positive> }> & AdditionalProperties<never>;
export type TPatternBox = IModel<{ payload?: Payload }, { exact: true }>;
export class PatternBox extends PatternBoxBaseModel {
  constructor(values: Partial<PatternBoxFields> = {}) { super(values); }
}