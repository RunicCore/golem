import { Type } from 'class-transformer';
import * as cv from 'class-validator';
import 'reflect-metadata';

// #region simple
export class Point3D {
  @cv.IsNumber()
  x!: number;

  @cv.IsNumber()
  y!: number;

  @cv.IsNumber()
  z!: number;
}

export class ObjectSimple {
  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Point3D)
  scale!: Point3D;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Point3D)
  position!: Point3D;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Point3D)
  rotate!: Point3D;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Point3D)
  pivot!: Point3D;
}
// #endregion simple

// #region array
export class Timestamp {
  @cv.IsNumber()
  time!: number;

  @cv.IsNumber()
  zone!: number;
}

export class Employee {
  @cv.IsNumber()
  id!: number;

  @cv.IsString()
  name!: string;

  @cv.IsNumber()
  age!: number;

  @cv.IsNumber()
  grade!: number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  employed_at!: Timestamp;
}

export class Department {
  @cv.IsNumber()
  id!: number;

  @cv.IsString()
  code!: string;

  @cv.IsNumber()
  sales!: number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  created_at!: Timestamp;

  @Type(() => Employee)
  @cv.IsArray()
  @cv.IsObject({ each: true })
  @cv.ValidateNested({ each: true })
  employees!: Employee[];
}

export class Company {
  @cv.IsNumber()
  id!: number;

  @cv.IsNumber()
  serial!: number;

  @cv.IsString()
  name!: string;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  established_at!: Timestamp;

  @Type(() => Department)
  @cv.IsArray()
  @cv.IsObject({ each: true })
  @cv.ValidateNested({ each: true })
  departments!: Department[];
}

export class Collection {
  @Type(() => Company)
  @cv.IsArray()
  @cv.IsObject({ each: true })
  @cv.ValidateNested({ each: true })
  data!: Company[];
}
// #endregion array

// #region nested
// Timestamp is declared with the Large array classes.
export class Account {
  @cv.IsNumber()
  id!: number;

  @cv.IsString()
  code!: string;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  created_at!: Timestamp;
}

export class Enterprise {
  @cv.IsNumber()
  id!: number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Account)
  account!: Account;

  @cv.IsString()
  name!: string;

  @cv.IsNumber()
  grade!: number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  created_at!: Timestamp;
}

export class Member {
  @cv.IsNumber()
  id!: number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Account)
  account!: Account;

  // `null` is part of the wire union, while an omitted property remains
  // invalid. `IsOptional` cannot express that distinction because it also
  // skips undefined values.
  @cv.ValidateIf((_object: object, value: unknown) => value !== null)
  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Enterprise)
  enterprise!: Enterprise | null;

  @cv.IsArray()
  @cv.IsString({ each: true })
  emails!: string[];

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  created_at!: Timestamp;

  @cv.IsBoolean()
  authorized!: boolean;
}

export class Channel {
  @cv.IsNumber()
  id!: number;

  @cv.IsString()
  code!: string;

  @cv.IsString()
  name!: string;

  @cv.IsNumber()
  sequence!: number;

  @cv.IsBoolean()
  exclusive!: boolean;

  @cv.IsNumber()
  priority!: number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  created_at!: Timestamp;
}

export class ObjectHierarchical {
  @cv.IsNumber()
  id!: number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Channel)
  channel!: Channel;

  @cv.ValidateIf((_object: object, value: unknown) => value !== null)
  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Member)
  member!: Member | null;

  @cv.ValidateIf((_object: object, value: unknown) => value !== null)
  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Account)
  account!: Account | null;

  @cv.IsString()
  href!: string;

  @cv.IsString()
  referrer!: string;

  @cv.ArrayMinSize(4)
  @cv.ArrayMaxSize(4)
  @cv.IsArray()
  @cv.IsNumber({}, { each: true })
  ip!: [number, number, number, number];

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => Timestamp)
  created_at!: Timestamp;
}

/** Tagged counterparts to the upstream hierarchical shape. */
export class ConstrainedTimestamp extends Timestamp {}

export class ConstrainedAccount extends Account {
  @cv.IsInt()
  @cv.Min(1)
  id = undefined as unknown as number;

  @cv.IsString()
  @cv.MinLength(3)
  code = undefined as unknown as string;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedTimestamp)
  created_at = undefined as unknown as ConstrainedTimestamp;
}

export class ConstrainedEnterprise extends Enterprise {
  @cv.IsInt()
  @cv.Min(1)
  id = undefined as unknown as number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedAccount)
  account = undefined as unknown as ConstrainedAccount;

  @cv.IsString()
  @cv.MinLength(2)
  name = undefined as unknown as string;

  @cv.IsInt()
  @cv.Min(1)
  grade = undefined as unknown as number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedTimestamp)
  created_at = undefined as unknown as ConstrainedTimestamp;
}

export class ConstrainedChannel extends Channel {
  @cv.IsInt()
  @cv.Min(1)
  id = undefined as unknown as number;

  @cv.IsString()
  @cv.MinLength(2)
  @cv.MaxLength(16)
  @cv.Matches(/^[a-z]+$/)
  code = undefined as unknown as string;

  @cv.IsString()
  @cv.MinLength(2)
  name = undefined as unknown as string;

  @cv.IsInt()
  @cv.Min(1)
  sequence = undefined as unknown as number;

  @cv.IsInt()
  @cv.Min(0)
  priority = undefined as unknown as number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedTimestamp)
  created_at = undefined as unknown as ConstrainedTimestamp;
}

export class ConstrainedMember extends Member {
  @cv.IsInt()
  @cv.Min(1)
  id = undefined as unknown as number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedAccount)
  account = undefined as unknown as ConstrainedAccount;

  @cv.ValidateIf((_object: object, value: unknown) => value !== null)
  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedEnterprise)
  enterprise = undefined as unknown as ConstrainedEnterprise | null;

  @cv.ArrayMinSize(1)
  @cv.ArrayMaxSize(3)
  @cv.IsArray()
  @cv.IsString({ each: true })
  @cv.MinLength(3, { each: true })
  emails = undefined as unknown as string[];

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedTimestamp)
  created_at = undefined as unknown as ConstrainedTimestamp;
}

export class ConstrainedObjectHierarchical extends ObjectHierarchical {
  @cv.IsInt()
  @cv.Min(1)
  id = undefined as unknown as number;

  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedChannel)
  channel = undefined as unknown as ConstrainedChannel;

  @cv.ValidateIf((_object: object, value: unknown) => value !== null)
  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedMember)
  member = undefined as unknown as ConstrainedMember | null;

  @cv.ValidateIf((_object: object, value: unknown) => value !== null)
  @cv.ValidateNested()
  @cv.IsObject()
  @Type(() => ConstrainedAccount)
  account = undefined as unknown as ConstrainedAccount | null;

  @cv.IsString()
  @cv.MinLength(8)
  @cv.Matches(/^https:\/\//)
  href = undefined as unknown as string;

  @cv.IsString()
  @cv.MinLength(8)
  @cv.Matches(/^https:\/\//)
  referrer = undefined as unknown as string;

  @cv.ArrayMinSize(4)
  @cv.ArrayMaxSize(4)
  @cv.IsArray()
  @cv.IsNumber({}, { each: true })
  ip = undefined as unknown as [number, number, number, number];
}
// #endregion nested
