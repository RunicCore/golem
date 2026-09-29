import type { IModel } from '@exprtlabs/codegen/model';
import { TupleBase, type TupleFields } from './tuple.model.generated.js';
export type TTuple = IModel<{
  required: [string, number];
  maybe: [string, number?];
  nested?: [string, number?];
  rest: [string, ...number[], boolean];
}>;
export class Tuple extends TupleBase {
  constructor(values: Partial<TupleFields> = {}) { super(values); }
}
