import type { IModel } from '@exprtlabs/golem/model';
import { TTupleBaseModel, type TTupleFields } from './tuple.model.generated.js';
export type TTuple = IModel<{
  required: [string, number];
  maybe: [string, number?];
  nested?: [string, number?];
  rest: [string, ...number[], boolean];
  dated?: [string, ...Date[], Date];
  when?: string | Date[];
  pair?: string | [Date];
// A JSON Schema cannot validate `rest` and `dated` in order (RUNM1021), so this model keeps its shape with validation off.
}, { validation: false }>;
export class Tuple extends TTupleBaseModel {
  constructor(values: Partial<TTupleFields> = {}) { super(values); }
}
