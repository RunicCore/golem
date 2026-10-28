import type { IModel } from '@exprtlabs/golem/model';
import { TTupleRestLastBaseModel, type TTupleRestLastFields } from './tuple-rest-last.model.generated.js';
export type TTupleRestLast = IModel<{
  required: [string, number];
  maybe: [string, number?];
  nested?: [string, number?];
  rest: [string, boolean, ...number[]];
  dated?: [string, Date, ...Date[]];
  when?: string | Date[];
  pair?: string | [Date];
}>;
export class TupleRestLast extends TTupleRestLastBaseModel {
  constructor(values: Partial<TTupleRestLastFields> = {}) { super(values); }
}
