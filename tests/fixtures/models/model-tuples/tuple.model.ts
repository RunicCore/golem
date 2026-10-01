import type { IModel } from '@exprtlabs/golem/model';
import { TTupleBaseModel, type TTupleFields } from './tuple.model.generated.js';
export type TTuple = IModel<{
  required: [string, number];
  maybe: [string, number?];
  nested?: [string, number?];
  rest: [string, ...number[], boolean];
}>;
export class Tuple extends TTupleBaseModel {
  constructor(values: Partial<TTupleFields> = {}) { super(values); }
}
