import type { IModel } from '@exprtlabs/golem/model';
import type { Contains, DependentSchemas } from '@exprtlabs/golem/tags';
import type { TChild } from './child.model.js';
import { ParentBase, type ParentFields } from './parent.model.generated.js';
export type TParent = IModel<{ children: Array<TChild> & Contains<TChild>; metadata: { children: Array<TChild>; mode?: 'loaded' } & DependentSchemas<{ mode: { children: Array<TChild> } }> }>;
export class Parent extends ParentBase {
  constructor(values: Partial<ParentFields> = {}) { super(values); }
}