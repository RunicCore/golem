import type { IModel, IObject } from '@exprtlabs/golem/model';
import { PayloadBaseModel, type PayloadFields } from './payload.model.generated.js';
export type TAlias = IObject<{ id: string }>;
export type TPayload = IModel<{ title: string }>;
export class Payload extends PayloadBaseModel { extra = 1; constructor(values: Partial<PayloadFields> = {}) { super(values); } }