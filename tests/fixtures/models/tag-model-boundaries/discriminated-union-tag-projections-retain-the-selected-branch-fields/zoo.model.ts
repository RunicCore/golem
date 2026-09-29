import type { IModel } from '@exprtlabs/codegen/model';
import type { Contains } from '@exprtlabs/codegen/tags';
import { ZooBase, type ZooFields } from './zoo.model.generated.js';
type Cat = { kind: 'cat'; name: string; lives: number };
type Dog = { kind: 'dog'; name: string; bark: boolean };
export type TZoo = IModel<{ pets: Array<Cat | Dog> & Contains<Cat | Dog> }>;
export class Zoo extends ZooBase {
  constructor(values: Partial<ZooFields> = {}) { super(values); }
}