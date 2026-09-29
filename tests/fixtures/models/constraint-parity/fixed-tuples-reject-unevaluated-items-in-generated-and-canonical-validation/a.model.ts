import type { IModel } from '@exprtlabs/codegen/model';
import { ABase, type AFields } from './a.model.generated.js';
export type TA = IModel<{ tuple: [string, number] }>;
export class A extends ABase { constructor(values: Partial<AFields> = {}) { super(values); } }