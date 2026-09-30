import type { IModel } from '@exprtlabs/golem/model';
import { SharedChildBase, type SharedChildFields } from './child.model.generated.js';
export type TSharedChild = IModel<{ value: string; extra: number }>;
export class SharedChild extends SharedChildBase {
  constructor(values: Partial<SharedChildFields> = {}) { super(values); }
}