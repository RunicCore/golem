import type { IModel, IObject } from '@exprtlabs/golem/model';

export type TCat = IObject<{ at: Date; meow: string }>;
export type TDog = IObject<{ at: Date; woof: string }>;
export type TPets = IModel<{ pet: TCat | TDog }>;
