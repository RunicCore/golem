
import type { IModel } from '@exprtlabs/golem/model';
import { AlphaBaseModel, BetaBaseModel, ContainerBaseModel } from './item.model.generated.js';
export type TAlpha = IModel<{ value: string }>;
export type TBeta = IModel<{ value: string }>;
export type TContainer = IModel<{
  alpha: TAlpha;
  beta: TBeta;
  plain: { value: string };
}>;
export class Alpha extends AlphaBaseModel {}
export class Beta extends BetaBaseModel {}
export class Container extends ContainerBaseModel {}
