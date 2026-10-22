import type { IObject } from '@exprtlabs/golem/model';
import type { Integer, MinLength, Minimum, TSerde, TValidation } from '@exprtlabs/golem/tags';
import type { PermissionBits, ProjectName } from './access-rules.js';
import type { Email, HexCode, Money, Phone, PlainHexCode, PlainMoney, PlainPermissions, PlainYesNo, Stamp, YesNo } from './feature-tags.js';
import { decodeHex, encodeHex, extraMoney, notBlank, positive } from './feature-tags.js';
import type { Money as PaymentMoney } from './sdk/index.js';

export type TJsonReuseContact = IObject<{
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

export type TJsonAddress = IObject<{
  id: string;
  city: string;
  country: string;
}>;

export type TJsonCustomer = IObject<{
  id: string;
  name: string & MinLength<2>;
  home: TJsonAddress;
}>;

export type TJsonNestedOrder = IObject<{
  id: string;
  customer: TJsonCustomer;
  items: TJsonLineItem[];
}>;

export type TJsonContactEmail = IObject<{ kind: 'email'; address: Email }>;
export type TJsonContactPhone = IObject<{ kind: 'phone'; number: Phone }>;
export type TJsonContact = IObject<{ value: TJsonContactEmail | TJsonContactPhone }>;

export type TJsonComposeCustomer = IObject<{
  home: TJsonAddress;
  shipping: Omit<TJsonAddress, 'id'>;
  draft: Partial<Pick<TJsonAddress, 'city' | 'country'>>;
  contact: TJsonContact;
}>;

export type TJsonTaggedMember = IObject<{
  id: string;
  name: string & MinLength<2>;
}>;

export type TJsonTaggedAccess = IObject<{
  projectName: ProjectName;
  member: TJsonTaggedMember;
  permissions: PermissionBits;
  budget: Money;
}>;

export type TJsonTaggedLineItem = IObject<{
  sku: string & MinLength<3>;
  quantity: number & Integer & Minimum<0>;
  amount: Money;
}>;

export type TJsonCombinedOrder = IObject<{
  id: string;
  projectName: ProjectName;
  billing: TJsonAddress;
  shipping: Omit<TJsonAddress, 'id'>;
  permissions: PermissionBits;
  items: TJsonTaggedLineItem[];
}>;

// #region checkout
export type TJsonLineItem = IObject<{
  sku: string & MinLength<3>;
  quantity: number & Integer & Minimum<0>;
  price: number & Minimum<0>;
}>;

export type TJsonCheckout = IObject<{
  money: PaymentMoney & TValidation<typeof extraMoney>;
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
// #endregion checkout

// The serde payloads: one shape of 21 fields. In serde-many every field converts; serde-none has the same rules on plain strings and numbers.
export type TJsonSerdeManyLine = IObject<{
  amount: Money;
  due: Date;
  ok: YesNo;
  hits: HexCode;
}>;

export type TJsonSerdeMany = IObject<{
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
  lines: TJsonSerdeManyLine[];
}>;

export type TJsonSerdeNoneLine = IObject<{
  amount: PlainMoney;
  due: Stamp;
  ok: PlainYesNo;
  hits: PlainHexCode;
}>;

export type TJsonSerdeNone = IObject<{
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
  lines: TJsonSerdeNoneLine[];
}>;
