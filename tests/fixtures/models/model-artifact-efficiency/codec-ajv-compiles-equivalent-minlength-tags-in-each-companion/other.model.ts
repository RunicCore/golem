import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { OtherBase } from './other.model.generated.js';
export type TOther = IModel<{ value: string & MinLength<2> }>;
export class Other extends OtherBase {}