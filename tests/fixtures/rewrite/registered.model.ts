import { registerIModelClass } from '@exprtlabs/golem/internal/model-runtime';
import { TRegisteredBaseModel } from './registered.model.generated.js';

export type TRegistered = { id: string };
export class Registered extends TRegisteredBaseModel {}
registerIModelClass("TRegistered_44444444", Registered);
