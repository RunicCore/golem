import type { IModel } from '@exprtlabs/golem/model';
import type {
  Integer,
  MaxItems,
  MaxLength,
  MinItems,
  MinLength,
  Minimum,
  Pattern,
} from '@exprtlabs/golem/tags';
import {
  TConstrainedAccountBaseModel,
  TConstrainedChannelBaseModel,
  TConstrainedEnterpriseBaseModel,
  TConstrainedMemberBaseModel,
  TConstrainedObjectHierarchicalBaseModel,
  TConstrainedTimestampBaseModel,
} from './golem.constrained.model.generated.js';

// #region nested
export type TConstrainedTimestamp = IModel<{
  time: number;
  zone: number;
}>;
export class ConstrainedTimestamp extends TConstrainedTimestampBaseModel {}

export type TConstrainedAccount = IModel<{
  id: number & Integer & Minimum<1>;
  code: string & MinLength<3>;
  created_at: ConstrainedTimestamp;
}>;
export class ConstrainedAccount extends TConstrainedAccountBaseModel {}

export type TConstrainedEnterprise = IModel<{
  id: number & Integer & Minimum<1>;
  account: ConstrainedAccount;
  name: string & MinLength<2>;
  grade: number & Integer & Minimum<1>;
  created_at: ConstrainedTimestamp;
}>;
export class ConstrainedEnterprise extends TConstrainedEnterpriseBaseModel {}

export type TConstrainedChannel = IModel<{
  id: number & Integer & Minimum<1>;
  code: string & MinLength<2> & MaxLength<16> & Pattern<'^[a-z]+$'>;
  name: string & MinLength<2>;
  sequence: number & Integer & Minimum<1>;
  exclusive: boolean;
  priority: number & Integer & Minimum<0>;
  created_at: ConstrainedTimestamp;
}>;
export class ConstrainedChannel extends TConstrainedChannelBaseModel {}

export type TConstrainedMember = IModel<{
  id: number & Integer & Minimum<1>;
  account: ConstrainedAccount;
  enterprise: ConstrainedEnterprise | null;
  emails: (string & MinLength<3>)[] & MinItems<1> & MaxItems<3>;
  created_at: ConstrainedTimestamp;
  authorized: boolean;
}>;
export class ConstrainedMember extends TConstrainedMemberBaseModel {}

export type TConstrainedObjectHierarchical = IModel<{
  id: number & Integer & Minimum<1>;
  channel: ConstrainedChannel;
  member: ConstrainedMember | null;
  account: ConstrainedAccount | null;
  href: string & MinLength<8> & Pattern<'^https://'>;
  referrer: string & MinLength<8> & Pattern<'^https://'>;
  ip: [number, number, number, number] & MinItems<4> & MaxItems<4>;
  created_at: ConstrainedTimestamp;
}>;
export class ConstrainedObjectHierarchical extends TConstrainedObjectHierarchicalBaseModel {}
// #endregion nested
