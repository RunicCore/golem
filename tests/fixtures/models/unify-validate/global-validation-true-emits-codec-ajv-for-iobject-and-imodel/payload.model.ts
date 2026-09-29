import type { IModel, IObject } from '@exprtlabs/codegen/model';
import { PayloadBase, type PayloadFields } from './payload.model.generated.js';
export type TAlias = IObject<{ id: string }>;
export type TPayload = IModel<{ title: string }>;
export class Payload extends PayloadBase { extra = 1; constructor(values: Partial<PayloadFields> = {}) { super(values); } }