
import type { IModel } from '@exprtlabs/golem/model';
import { AlphaBase, BetaBase, ContainerBase } from './item.model.generated.js';
export type TAlpha = IModel<{ value: string }>;
export type TBeta = IModel<{ value: string }>;
export type TContainer = IModel<{
  alpha: TAlpha;
  beta: TBeta;
  plain: { value: string };
}>;
export class Alpha extends AlphaBase {}
export class Beta extends BetaBase {}
export class Container extends ContainerBase {}
