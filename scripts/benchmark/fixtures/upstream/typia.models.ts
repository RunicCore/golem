import type { tags } from 'typia';

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface ObjectSimple {
  scale: Point3D;
  position: Point3D;
  rotate: Point3D;
  pivot: Point3D;
}

export interface Account {
  id: number;
  code: string;
  created_at: Timestamp;
}

export interface Enterprise {
  id: number;
  account: Account;
  name: string;
  grade: number;
  created_at: Timestamp;
}

export interface Channel {
  id: number;
  code: string;
  name: string;
  sequence: number;
  exclusive: boolean;
  priority: number;
  created_at: Timestamp;
}

export interface Member {
  id: number;
  account: Account;
  enterprise: Enterprise | null;
  emails: string[];
  created_at: Timestamp;
  authorized: boolean;
}

export interface Timestamp {
  time: number;
  zone: number;
}

export interface Employee {
  id: number;
  name: string;
  age: number;
  grade: number;
  employed_at: Timestamp;
}

export interface Department {
  id: number;
  code: string;
  sales: number;
  created_at: Timestamp;
  employees: Employee[];
}

export interface Company {
  id: number;
  serial: number;
  name: string;
  established_at: Timestamp;
  departments: Department[];
}

export interface Collection {
  data: Company[];
}

/** The same nested fixture with Typia's native constraint tags. */
export interface ConstrainedTimestamp {
  time: number;
  zone: number;
}

export interface ConstrainedAccount {
  id: number & tags.Type<'int32'> & tags.Minimum<1>;
  code: string & tags.MinLength<3>;
  created_at: ConstrainedTimestamp;
}

export interface ConstrainedEnterprise {
  id: number & tags.Type<'int32'> & tags.Minimum<1>;
  account: ConstrainedAccount;
  name: string & tags.MinLength<2>;
  grade: number & tags.Type<'int32'> & tags.Minimum<1>;
  created_at: ConstrainedTimestamp;
}

export interface ConstrainedChannel {
  id: number & tags.Type<'int32'> & tags.Minimum<1>;
  code: string & tags.MinLength<2> & tags.MaxLength<16> & tags.Pattern<'^[a-z]+$'>;
  name: string & tags.MinLength<2>;
  sequence: number & tags.Type<'int32'> & tags.Minimum<1>;
  exclusive: boolean;
  priority: number & tags.Type<'int32'> & tags.Minimum<0>;
  created_at: ConstrainedTimestamp;
}

export interface ConstrainedMember {
  id: number & tags.Type<'int32'> & tags.Minimum<1>;
  account: ConstrainedAccount;
  enterprise: ConstrainedEnterprise | null;
  emails: (string & tags.MinLength<3>)[] & tags.MinItems<1> & tags.MaxItems<3>;
  created_at: ConstrainedTimestamp;
  authorized: boolean;
}

export interface ConstrainedObjectHierarchical {
  id: number & tags.Type<'int32'> & tags.Minimum<1>;
  channel: ConstrainedChannel;
  member: ConstrainedMember | null;
  account: ConstrainedAccount | null;
  href: string & tags.MinLength<8> & tags.Pattern<'^https://'>;
  referrer: string & tags.MinLength<8> & tags.Pattern<'^https://'>;
  ip: [number, number, number, number];
  created_at: ConstrainedTimestamp;
}

export interface CheckoutPlain {
  money: { amount: number & tags.Minimum<0>; currency: string & tags.Pattern<'^[A-Z]{3}$'> };
  note: string & tags.MinLength<1>;
  code: string & tags.Pattern<'^[0-9a-f]+$'>;
  when: string & tags.Format<'date-time'>;
  items: Array<{ sku: string & tags.MinLength<3> }>;
  primary: { sku: string & tags.MinLength<3>; quantity: number & tags.Type<'int32'> & tags.Minimum<0>; price: number & tags.Minimum<0> };
  flags: Record<string, string>;
  channel: { kind: 'open' } | { kind: 'hold'; until: string & tags.Format<'date-time'> };
  span: [string & tags.Format<'date-time'>, string & tags.Format<'date-time'>];
  hold: (string & tags.Format<'date-time'>) | null;
  bag?: { lane: string };
  memo?: string;
}
