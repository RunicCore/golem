import type { IModel } from '@exprtlabs/golem/model';
import type { Integer, MinLength, Minimum, TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { PermissionBits, ProjectName } from './access-rules.js';
import type { Email, Money, Phone } from './feature-tags.js';
import { decodeHex, encodeHex, extraMoney, notBlank, positive } from './feature-tags.js';
import type { Money as PaymentMoney } from './sdk/index.js';
import {
  TAddressBaseModel,
  TCheckoutBaseModel,
  TCombinedOrderBaseModel,
  TComposeCustomerBaseModel,
  TContactBaseModel,
  TContactEmailBaseModel,
  TContactPhoneBaseModel,
  TCustomerBaseModel,
  TLineItemBaseModel,
  TNestedOrderBaseModel,
  TReuseContactBaseModel,
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
export type TContact = IModel<{ value: ContactEmail | ContactPhone }>;
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
  channel: { kind: 'open' } | { kind: 'hold'; until: Date };
  span: [Date, Date];
  hold: Date | null;
  bag?: { lane: string };
  memo?: string;
}>;
export class Checkout extends TCheckoutBaseModel {}
// #endregion checkout
