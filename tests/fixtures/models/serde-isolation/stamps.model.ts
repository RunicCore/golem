import type { IModel } from '@exprtlabs/golem/model';
import { TStampsBaseModel } from './stamps.model.generated.js';

export type TStamps = IModel<{ id: string; at: Date; label?: string; stamps: Record<string, Date> }>;
export class Stamps extends TStampsBaseModel {}
