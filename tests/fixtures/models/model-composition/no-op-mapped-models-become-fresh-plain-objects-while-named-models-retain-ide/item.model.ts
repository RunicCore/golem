
import type { IModel } from '@exprtlabs/golem/model';
import { PlaceBaseModel, ContainerBaseModel } from './item.model.generated.js';
export type TPlace = IModel<{ borough: string }>;
type Noop<T> = { [K in keyof T]: T[K] };
export type TContainer = IModel<{
  mapped: Noop<TPlace>;
  intact: TPlace;
  plain: { borough: string };
}>;
export class Place extends PlaceBaseModel {}
export class Container extends ContainerBaseModel {}
