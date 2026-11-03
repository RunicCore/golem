
import type { IModel } from '@exprtlabs/golem/model';
import { TAlphaBaseModel, TBetaBaseModel, TContainerBaseModel } from './item.model.generated.js';
export type TAlpha = IModel<{ value: string }>;
export type TBeta = IModel<{ value: string }>;
export type TContainer = IModel<{
  alpha: TAlpha;
  beta: TBeta;
  plain: { value: string };
}>;
export class Alpha extends TAlphaBaseModel {}
export class Beta extends TBetaBaseModel {}
export class Container extends TContainerBaseModel {}
