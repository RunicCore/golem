import type { IModel } from '@exprtlabs/golem/model';
import { CatBase, DogBase, OwnerBase } from './pets.model.generated.js';

export type TCat = IModel<{ kind: 'cat'; name: string }>;
export type TDog = IModel<{ kind: 'dog'; bark: boolean }>;
export type TOwner = IModel<{ pet: TCat | TDog; pets: (TCat | TDog)[] }>;

export class Cat extends CatBase {}
export class Dog extends DogBase {}
export class Owner extends OwnerBase {}
