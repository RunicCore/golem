import type { IModel } from '@exprtlabs/golem/model';
import type { Integer, MinLength, Minimum, Pattern, TSerde, TValidation, Discriminator } from '@exprtlabs/golem/tags';
import type { PermissionBits, ProjectName } from './access-rules.js';
import type { Email, Money, Phone } from './feature-tags.js';
import type { HexCode, PlainHexCode, PlainMoney, PlainPermissions, PlainYesNo, Stamp, YesNo } from './feature-tags.js';
import { decodeHex, encodeHex, extraMoney, notBlank, positive } from './feature-tags.js';
import type { Money as PaymentMoney } from './sdk/index.js';
import {
  TAddressBaseModel,
  TCheckoutBaseModel,
  TCheckoutPlainBaseModel,
  TCombinedOrderBaseModel,
  TComposeCustomerBaseModel,
  TContactBaseModel,
  TContactEmailBaseModel,
  TContactPhoneBaseModel,
  TCustomerBaseModel,
  TLineItemBaseModel,
  TNestedOrderBaseModel,
  TReuseContactBaseModel,
  TSerdeManyBaseModel,
  TSerdeManyLineBaseModel,
  TSerdeNoneBaseModel,
  TSerdeNoneLineBaseModel,
  TTaggedAccessBaseModel,
  TTaggedLineItemBaseModel,
  TTaggedMemberBaseModel,
} from './features.model.generated.js';

export type TReuseContact = IModel<{
  givenName: ProjectName;
  familyName: ProjectName;
  displayName: ProjectName;
  alias: ProjectName;
  workEmail: Email;
  personalEmail: Email;
  billingEmail: Email;
  homePhone: Phone;
  workPhone: Phone;
}>;
export class ReuseContact extends TReuseContactBaseModel {}

export type TAddress = IModel<{
  id: string;
  city: string;
  country: string;
}>;
export class Address extends TAddressBaseModel {}

export type TCustomer = IModel<{
  id: string;
  name: string & MinLength<2>;
  home: Address;
}>;
export class Customer extends TCustomerBaseModel {}

export type TNestedOrder = IModel<{
  id: string;
  customer: Customer;
  items: LineItem[];
}>;
export class NestedOrder extends TNestedOrderBaseModel {}

export type TContactEmail = IModel<{ kind: 'email'; address: Email }>;
export class ContactEmail extends TContactEmailBaseModel {}
export type TContactPhone = IModel<{ kind: 'phone'; number: Phone }>;
export class ContactPhone extends TContactPhoneBaseModel {}
export type TContact = IModel<{ value: (ContactEmail | ContactPhone) & Discriminator<'kind'> }>;
export class Contact extends TContactBaseModel {}

export type TComposeCustomer = IModel<{
  home: Address;
  shipping: Omit<TAddress, 'id'>;
  draft: Partial<Pick<TAddress, 'city' | 'country'>>;
  contact: Contact;
}>;
export class ComposeCustomer extends TComposeCustomerBaseModel {}

export type TTaggedMember = IModel<{
  id: string;
  name: string & MinLength<2>;
}>;
export class TaggedMember extends TTaggedMemberBaseModel {}

export type TTaggedAccess = IModel<{
  projectName: ProjectName;
  member: TaggedMember;
  permissions: PermissionBits;
  budget: Money;
}>;
export class TaggedAccess extends TTaggedAccessBaseModel {}

export type TTaggedLineItem = IModel<{
  sku: string & MinLength<3>;
  quantity: number & Integer & Minimum<0>;
  amount: Money;
}>;
export class TaggedLineItem extends TTaggedLineItemBaseModel {}

export type TCombinedOrder = IModel<{
  id: string;
  projectName: ProjectName;
  billing: Address;
  shipping: Omit<TAddress, 'id'>;
  permissions: PermissionBits;
  items: TaggedLineItem[];
}>;
export class CombinedOrder extends TCombinedOrderBaseModel {}

// #region checkout
export type TLineItem = IModel<{
  sku: string & MinLength<3>;
  quantity: number & Integer & Minimum<0>;
  price: number & Minimum<0>;
}>;
export class LineItem extends TLineItemBaseModel {}

export type TCheckout = IModel<{
  money: PaymentMoney & TValidation<typeof extraMoney>;
  note: string & TValidation<typeof notBlank>;
  code: number & TValidation<typeof positive> & TSerde<typeof encodeHex, typeof decodeHex>;
  when: Date;
  items: Array<{ sku: string & MinLength<3> }>;
  primary: LineItem;
  flags: Record<string, string>;
  channel: ({ kind: 'open' } | { kind: 'hold'; until: Date }) & Discriminator<'kind'>;
  span: [Date, Date];
  hold: Date | null;
  bag?: { lane: string };
  memo?: string;
}>;
export class Checkout extends TCheckoutBaseModel {}
// #endregion checkout

// #region checkout-plain
// LineItem is declared with the Checkout payload. Stamp is `string & Format<'date-time'>`: dates stay strings, and nothing converts.
export type TCheckoutPlain = IModel<{
  money: { amount: number & Minimum<0>; currency: string & Pattern<'^[A-Z]{3}$'> };
  note: string & MinLength<1>;
  code: string & Pattern<'^[0-9a-f]+$'>;
  when: Stamp;
  items: Array<{ sku: string & MinLength<3> }>;
  primary: LineItem;
  flags: Record<string, string>;
  channel: ({ kind: 'open' } | { kind: 'hold'; until: Stamp }) & Discriminator<'kind'>;
  span: [Stamp, Stamp];
  hold: Stamp | null;
  bag?: { lane: string };
  memo?: string;
}>;
export class CheckoutPlain extends TCheckoutPlainBaseModel {}
// #endregion checkout-plain

// The serde payloads: one shape of 21 fields. In serde-many every field converts; serde-none has the same rules on plain strings and numbers.
export type TSerdeManyLine = IModel<{
  amount: Money;
  due: Date;
  ok: YesNo;
  hits: HexCode;
}>;
export class SerdeManyLine extends TSerdeManyLineBaseModel {}

export type TSerdeMany = IModel<{
  price: Money;
  tax: Money;
  fee: Money;
  total: Money;
  code: HexCode;
  retry: HexCode;
  perms: PermissionBits;
  admin: PermissionBits;
  active: YesNo;
  archived: YesNo;
  created: Date;
  updated: Date;
  expires: Date;
  shipped: Date;
  window: [Date, Date];
  review: [Date, Date];
  lines: SerdeManyLine[];
}>;
export class SerdeMany extends TSerdeManyBaseModel {}

export type TSerdeNoneLine = IModel<{
  amount: PlainMoney;
  due: Stamp;
  ok: PlainYesNo;
  hits: PlainHexCode;
}>;
export class SerdeNoneLine extends TSerdeNoneLineBaseModel {}

export type TSerdeNone = IModel<{
  price: PlainMoney;
  tax: PlainMoney;
  fee: PlainMoney;
  total: PlainMoney;
  code: PlainHexCode;
  retry: PlainHexCode;
  perms: PlainPermissions;
  admin: PlainPermissions;
  active: PlainYesNo;
  archived: PlainYesNo;
  created: Stamp;
  updated: Stamp;
  expires: Stamp;
  shipped: Stamp;
  window: [Stamp, Stamp];
  review: [Stamp, Stamp];
  lines: SerdeNoneLine[];
}>;
export class SerdeNone extends TSerdeNoneBaseModel {}
