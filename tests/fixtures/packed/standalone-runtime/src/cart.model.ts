import type { IModel } from '@exprtlabs/codegen/model';
import type { Minimum, TSerde, TValidation } from '@exprtlabs/codegen/tags';
import type { Money } from '../sdk/index.js';

export const positive = (value: number): boolean | string => value > 0 || 'Use a positive count';
export const encode = (value: number): string => value.toString(16);
export const decode = (value: string): number => Number.parseInt(value, 16);

export type TCart = IModel<{
  money: Money;
  count: number & Minimum<1> & TValidation<typeof positive>;
  when: Date;
  code: number & TSerde<typeof encode, typeof decode>;
}>;
