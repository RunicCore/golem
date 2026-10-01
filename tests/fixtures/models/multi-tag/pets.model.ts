import type { IModel } from '@exprtlabs/golem/model';
import { CatBaseModel, DogBaseModel, OwnerBaseModel } from './pets.model.generated.js';

export type TCat = IModel<{ kind: 'cat' | 'kitty'; name: string }>;
export type TDog = IModel<{ kind: 'dog'; bark: boolean }>;
export type TOwner = IModel<{ pet: TCat | TDog; pets: (TCat | TDog)[] }>;

export class Cat extends CatBaseModel {}
export class Dog extends DogBaseModel {}
export class Owner extends OwnerBaseModel {}
