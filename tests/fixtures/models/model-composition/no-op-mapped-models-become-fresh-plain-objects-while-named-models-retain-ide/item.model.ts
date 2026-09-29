
import type { IModel } from '@exprtlabs/codegen/model';
import { AddressBase, ContainerBase } from './item.model.generated.js';
export type TAddress = IModel<{ city: string }>;
type Noop<T> = { [K in keyof T]: T[K] };
export type TContainer = IModel<{
  mapped: Noop<TAddress>;
  intact: TAddress;
  plain: { city: string };
}>;
export class Address extends AddressBase {}
export class Container extends ContainerBase {}
