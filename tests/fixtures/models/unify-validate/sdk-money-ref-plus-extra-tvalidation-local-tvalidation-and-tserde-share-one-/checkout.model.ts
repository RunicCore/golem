import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { MinLength, TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { Money } from './sdk/index.js';
import { extraMoney, notBlank, positive, encodeHex, decodeHex } from './rules.js';
import { CheckoutBase, LineItemBase, type CheckoutFields, type LineItemFields } from './checkout.model.generated.js';
export type TJsonLineItem = IObject<{ sku: string & MinLength<3>; quantity: number; price: number }>;
export type TLineItem = IModel<{ sku: string & MinLength<3>; quantity: number; price: number }>;
export class LineItem extends LineItemBase { constructor(values: Partial<LineItemFields> = {}) { super(values); } }
export type TJsonCheckout = IObject<{
  money: Money & TValidation<typeof extraMoney>;
  note: string & TValidation<typeof notBlank>;
  code: number & TValidation<typeof positive> & TSerde<typeof encodeHex, typeof decodeHex>;
  when: Date;
  items: Array<{ sku: string & MinLength<3> }>;
  primary: TJsonLineItem;
  flags: Record<string, string>;
  channel: { kind: 'open' } | { kind: 'hold'; until: Date };
  span: [Date, Date];
  hold: Date | null;
  bag?: { lane: string };
  memo?: string;
}>;
export type TCheckout = IModel<{
  money: Money & TValidation<typeof extraMoney>;
  note: string & TValidation<typeof notBlank>;
  code: number & TValidation<typeof positive> & TSerde<typeof encodeHex, typeof decodeHex>;
  when: Date;
  items: Array<{ sku: string & MinLength<3> }>;
  primary: LineItem;
  flags: Record<string, string>;
  channel: { kind: 'open' } | { kind: 'hold'; until: Date };
  span: [Date, Date];
  hold: Date | null;
  bag?: { lane: string };
  memo?: string;
}>;
export class Checkout extends CheckoutBase { constructor(values: Partial<CheckoutFields> = {}) { super(values); } }