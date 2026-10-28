import type { IModel } from '@exprtlabs/golem/model';
import type { Contains, Discriminator } from '@exprtlabs/golem/tags';
import { TZooBaseModel, type TZooFields } from './zoo.model.generated.js';
type Cat = { kind: 'cat'; name: string; lives: number };
type Dog = { kind: 'dog'; name: string; bark: boolean };
export type TZoo = IModel<{ pets: Array<(Cat | Dog) & Discriminator<'kind'>> & Contains<Cat | Dog> }>;
export class Zoo extends TZooBaseModel {
  constructor(values: Partial<TZooFields> = {}) { super(values); }
}