import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { OtherBaseModel } from './other.model.generated.js';
export type TOther = IModel<{ value: string & MinLength<2> }>;
export class Other extends OtherBaseModel {}