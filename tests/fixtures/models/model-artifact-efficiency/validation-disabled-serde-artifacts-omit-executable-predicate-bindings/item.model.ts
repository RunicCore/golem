import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation, TSerde } from '@exprtlabs/golem/tags';
import { ItemBase } from './item.model.generated.js';
export function accepts(value: number): boolean { return value > 0; }
export function encode(value: number): string { return String(value); }
export function decode(value: string): number { return Number(value); }
export type TItem = IModel<{ value: number & TValidation<typeof accepts> & TSerde<typeof encode, typeof decode> }>;
export class Item extends ItemBase {}