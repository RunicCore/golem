import type { IModel } from '@exprtlabs/golem/model';

export type Item0 = IModel<{ at: Date; meow: string }>;
export type Item1 = IModel<{ at: Date; woof: string }>;
export type TPets = IModel<{ pet: Item0 | Item1 }>;
