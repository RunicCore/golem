import type { IModel } from '@exprtlabs/golem/model';
import { TWhenBaseModel } from './when.model.generated.js';
export type TWhen = IModel<{ at: Date | Date[]; from: Date | string[]; maybe?: Date | Date[] | null }>;
export class When extends TWhenBaseModel {}
