import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TPayloadBaseModel, type TPayloadFields } from './payload.model.generated.js';
export type TAlias = IObject<{ id: string }>;
export type TPayload = IModel<{ title: string }>;
export class Payload extends TPayloadBaseModel { extra = 1; constructor(values: Partial<TPayloadFields> = {}) { super(values); } }