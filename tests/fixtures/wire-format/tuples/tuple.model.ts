import type { IModel } from '@exprtlabs/golem/model';
import { TTupleBaseModel } from './tuple.model.generated.js';

export type TTuple = IModel<{
  required: [string, number];
  maybe: [string, number?];
  rest: [string, ...number[], boolean];
  dated?: [string, ...Date[], Date];
  labeled: readonly [head: string, ...middle: number[], tail: boolean];
}, { validation: false }>;

export class Tuple extends TTupleBaseModel {}
