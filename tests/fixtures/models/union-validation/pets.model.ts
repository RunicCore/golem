import type { IModel } from '@exprtlabs/golem/model';
import { TCatBaseModel, TDogBaseModel, TOwnerBaseModel } from './pets.model.generated.js';

export type TCat = IModel<{ kind: 'cat'; name: string }>;
export type TDog = IModel<{ kind: 'dog'; bark: boolean }>;
export type TOwner = IModel<{ pet: TCat | TDog; pets: (TCat | TDog)[] }>;

export class Cat extends TCatBaseModel {}
export class Dog extends TDogBaseModel {}
export class Owner extends TOwnerBaseModel {}
