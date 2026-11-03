import type { IModel } from '@exprtlabs/golem/model';
import { TChildBaseModel } from './child.model.generated.js';
export type TChild = IModel<{ name: string }>;
export class Child extends TChildBaseModel {}
