import type { IModel } from '@exprtlabs/codegen/model';
import type { MinLength } from '@exprtlabs/codegen/tags';
import { OtherBase } from './other.model.generated.js';
export type TOther = IModel<{ value: string & MinLength<2> }>;
export class Other extends OtherBase {}