
import type { IModel } from '@exprtlabs/codegen/model';
import { PlaceBase, ContainerBase } from './item.model.generated.js';
export type TPlace = IModel<{ borough: string }>;
type Noop<T> = { [K in keyof T]: T[K] };
export type TContainer = IModel<{
  mapped: Noop<TPlace>;
  intact: TPlace;
  plain: { borough: string };
}>;
export class Place extends PlaceBase {}
export class Container extends ContainerBase {}
