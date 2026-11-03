import { Type } from 'class-transformer';
import 'reflect-metadata';

export class Point3D {
  x!: number;
  y!: number;
  z!: number;
}

export class ObjectSimple {
  @Type(() => Point3D)
  scale!: Point3D;

  @Type(() => Point3D)
  position!: Point3D;

  @Type(() => Point3D)
  rotate!: Point3D;

  @Type(() => Point3D)
  pivot!: Point3D;
}

export class Timestamp {
  time!: number;
  zone!: number;
}

export class Employee {
  id!: number;
  name!: string;
  age!: number;
  grade!: number;

  @Type(() => Timestamp)
  employed_at!: Timestamp;
}

export class Department {
  id!: number;
  code!: string;
  sales!: number;

  @Type(() => Timestamp)
  created_at!: Timestamp;

  @Type(() => Employee)
  employees!: Employee[];
}

export class Company {
  id!: number;
  serial!: number;
  name!: string;

  @Type(() => Timestamp)
  established_at!: Timestamp;

  @Type(() => Department)
  departments!: Department[];
}

export class Collection {
  @Type(() => Company)
  data!: Company[];
}

// Timestamp is declared with the Large array classes.
export class Account {
  id!: number;
  code!: string;

  @Type(() => Timestamp)
  created_at!: Timestamp;
}

export class Enterprise {
  id!: number;

  @Type(() => Account)
  account!: Account;

  name!: string;
  grade!: number;

  @Type(() => Timestamp)
  created_at!: Timestamp;
}

export class Member {
  id!: number;

  @Type(() => Account)
  account!: Account;

  @Type(() => Enterprise)
  enterprise!: Enterprise | null;

  emails!: string[];

  @Type(() => Timestamp)
  created_at!: Timestamp;

  authorized!: boolean;
}

export class Channel {
  id!: number;
  code!: string;
  name!: string;
  sequence!: number;
  exclusive!: boolean;
  priority!: number;

  @Type(() => Timestamp)
  created_at!: Timestamp;
}

export class ObjectHierarchical {
  id!: number;

  @Type(() => Channel)
  channel!: Channel;

  @Type(() => Member)
  member!: Member | null;

  @Type(() => Account)
  account!: Account | null;

  href!: string;
  referrer!: string;
  ip!: [number, number, number, number];

  @Type(() => Timestamp)
  created_at!: Timestamp;
}

/**
 * The constrained fixture keeps the same wire shape as ObjectHierarchical.
 * These classes intentionally carry only transformation metadata; the
 * validation comparison uses the parallel class-validator declarations.
 */
export class ConstrainedChannel extends Channel {
  id = undefined as unknown as number;
  code = undefined as unknown as string;
}

export class ConstrainedMember extends Member {
  @Type(() => Account)
  account = undefined as unknown as Account;

  @Type(() => Enterprise)
  enterprise = undefined as unknown as Enterprise | null;

  emails = undefined as unknown as string[];
}

export class ConstrainedObjectHierarchical extends ObjectHierarchical {
  @Type(() => ConstrainedChannel)
  channel = undefined as unknown as ConstrainedChannel;

  @Type(() => ConstrainedMember)
  member = undefined as unknown as ConstrainedMember | null;

  @Type(() => Account)
  account = undefined as unknown as Account | null;
}
