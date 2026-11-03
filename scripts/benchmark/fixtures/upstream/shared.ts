import assert from 'node:assert/strict';

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface ObjectSimpleWire {
  scale: Point3D;
  position: Point3D;
  rotate: Point3D;
  pivot: Point3D;
}

export interface Timestamp {
  time: number;
  zone: number;
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

export interface ObjectHierarchicalWire {
  id: number;
  channel: Channel;
  member: Member | null;
  account: Account | null;
  href: string;
  referrer: string;
  ip: [number, number, number, number];
  created_at: Timestamp;
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

/** The collection wrapper keeps the top-level root object uniform. */
export interface CollectionWire {
  data: Company[];
}

export interface ObjectSimpleInput {
  readonly name: 'ObjectSimple';
  readonly payload: ObjectSimpleWire;
  readonly text: string;
}

export interface ConstrainedObjectHierarchicalInput {
  readonly name: 'ObjectHierarchical-Constrained';
  readonly payload: ObjectHierarchicalWire;
  readonly text: string;
}

export interface ArrayHierarchicalInput {
  readonly name: 'ArrayHierarchical-1000';
  readonly payload: CollectionWire;
  readonly text: string;
}

export type FixtureInput = ObjectSimpleInput | ConstrainedObjectHierarchicalInput | ArrayHierarchicalInput;

const FIXED_TIME = 1_704_067_200_000;
const FIXED_ZONE = 0;

function timestamp(offset = 0): Timestamp {
  return { time: FIXED_TIME + offset, zone: FIXED_ZONE };
}

function point(x: number, y: number, z: number): Point3D {
  return { x, y, z };
}

function objectSimplePayload(): ObjectSimpleWire {
  return {
    scale: point(1, 2, 3),
    position: point(10, 20, 30),
    rotate: point(0, 90, 180),
    pivot: point(4, 5, 6),
  };
}

function objectHierarchicalPayload(): ObjectHierarchicalWire {
  const memberAccount: Account = {
    id: 401,
    code: 'account-401',
    created_at: timestamp(1),
  };
  const enterprise: Enterprise = {
    id: 501,
    account: {
      id: 502,
      code: 'enterprise-account-502',
      created_at: timestamp(5),
    },
    name: 'Example Enterprise',
    grade: 3,
    created_at: timestamp(6),
  };
  return {
    id: 101,
    channel: {
      id: 201,
      code: 'web',
      name: 'Web',
      sequence: 1,
      exclusive: false,
      priority: 5,
      created_at: timestamp(2),
    },
    member: {
      id: 301,
      account: memberAccount,
      enterprise,
      emails: ['member@example.com', 'member+alerts@example.com'],
      created_at: timestamp(3),
      authorized: true,
    },
    account: {
      id: 601,
      code: 'customer-account-601',
      created_at: timestamp(7),
    },
    href: 'https://example.test/customers/101',
    referrer: 'https://example.test',
    ip: [127, 0, 0, 1],
    created_at: timestamp(4),
  };
}

function companyPayload(departmentCount: number, employeesPerDepartment: number): Company {
  const departments: Department[] = [];
  for (let departmentIndex = 0; departmentIndex < departmentCount; departmentIndex++) {
    const employees: Employee[] = [];
    for (let employeeIndex = 0; employeeIndex < employeesPerDepartment; employeeIndex++) {
      employees.push({
        id: 30_000 + departmentIndex * employeesPerDepartment + employeeIndex,
        name: `Employee ${departmentIndex + 1}-${employeeIndex + 1}`,
        age: 20 + (employeeIndex % 30),
        grade: 1 + (employeeIndex % 5),
        employed_at: timestamp(100 + departmentIndex * employeesPerDepartment + employeeIndex),
      });
    }
    departments.push({
      id: 20_000 + departmentIndex,
      code: `department-${departmentIndex + 1}`,
      sales: 10_000 + departmentIndex,
      created_at: timestamp(50 + departmentIndex),
      employees,
    });
  }
  return {
    id: 10_001,
    serial: 42,
    name: 'Example Company',
    established_at: timestamp(10),
    departments,
  };
}

function arrayHierarchicalPayload(departmentCount: number, employeesPerDepartment: number): CollectionWire {
  return { data: [companyPayload(departmentCount, employeesPerDepartment)] };
}

export function createFixtureInputs(): readonly FixtureInput[] {
  const inputs: FixtureInput[] = [
    { name: 'ObjectSimple', payload: objectSimplePayload(), text: '' },
    { name: 'ObjectHierarchical-Constrained', payload: objectHierarchicalPayload(), text: '' },
    { name: 'ArrayHierarchical-1000', payload: arrayHierarchicalPayload(10, 100), text: '' },
  ];
  return inputs.map((input) => ({ ...input, text: JSON.stringify(input.payload) }));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertDetached(source: unknown, result: unknown): void {
  if (source === null || result === null || typeof source !== 'object' || typeof result !== 'object') return;
  assert.notStrictEqual(source, result, 'conversion must detach object and array containers');
  if (Array.isArray(source)) {
    assert.ok(Array.isArray(result), 'conversion must preserve array containers');
    for (let index = 0; index < source.length; index++) assertDetached(source[index], result[index]);
    return;
  }
  if (Array.isArray(result)) throw new assert.AssertionError({ message: 'conversion changed an object into an array' });
  const original = source as Record<string, unknown>;
  const target = result as Record<string, unknown>;
  for (const key of Object.keys(original)) assertDetached(original[key], target[key]);
}

export function consumeValue(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return consumeValue(first) + value.length;
  }
  if (!isRecord(value)) return 1;
  if (Array.isArray(value.data)) return value.data.length + consumeValue(value.data[0]);
  if (isRecord(value.scale)
    && typeof value.scale.x === 'number'
    && typeof value.scale.y === 'number'
    && typeof value.scale.z === 'number') {
    return value.scale.x + value.scale.y + value.scale.z;
  }
  if (isRecord(value.channel)) {
    const member = value.member;
    const id = typeof value.id === 'number' ? value.id : 0;
    const channelId = typeof value.channel.id === 'number' ? value.channel.id : 0;
    const memberId = isRecord(member) && typeof member.id === 'number' ? member.id : 0;
    return id + channelId + memberId;
  }
  if (Array.isArray(value.departments)) return value.departments.length;
  if (typeof value.id === 'number' && Number.isFinite(value.id)) return value.id;
  return Object.keys(value).length;
}

export function clonePayload(value: unknown): unknown {
  return structuredClone(value);
}

function containerProperty(container: unknown, key: string | number): unknown {
  if (Array.isArray(container) && typeof key === 'number') return container[key];
  if (isRecord(container) && typeof key === 'string') return container[key];
  throw new TypeError('Fixture mutation path does not address an object or array');
}

function setContainerProperty(container: unknown, key: string | number, value: unknown): void {
  if (Array.isArray(container) && typeof key === 'number') {
    container[key] = value;
    return;
  }
  if (isRecord(container) && typeof key === 'string') {
    container[key] = value;
    return;
  }
  throw new TypeError('Fixture mutation path does not address an object or array');
}

export function mutateAt(value: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  const copy = clonePayload(value);
  if (path.length === 0) throw new TypeError('Fixture mutation path cannot be empty');
  let current: unknown = copy;
  for (const key of path.slice(0, -1)) current = containerProperty(current, key);
  setContainerProperty(current, path[path.length - 1], replacement);
  return copy;
}

export function omitAt(value: unknown, path: readonly (string | number)[]): unknown {
  const copy = clonePayload(value);
  if (path.length === 0) throw new TypeError('Fixture omission path cannot be empty');
  let current: unknown = copy;
  for (const key of path.slice(0, -1)) current = containerProperty(current, key);
  const key = path[path.length - 1];
  if (!isRecord(current) || typeof key !== 'string') throw new TypeError('Fixture omission path must end at an object field');
  delete current[key];
  return copy;
}

function invalidModelPath(input: FixtureInput): readonly (string | number)[] {
  switch (input.name) {
    case 'ObjectSimple': return ['scale', 'x'];
    case 'ObjectHierarchical-Constrained': return ['channel', 'code'];
    case 'ArrayHierarchical-1000':
      return ['data', 0, 'departments', 0, 'employees', 0, 'grade'];
  }
}

export function mutateInPlaceAt(value: unknown, input: FixtureInput, replacement: unknown): void {
  const path = invalidModelPath(input);
  if (path.length === 0) throw new TypeError('Fixture mutation path cannot be empty');
  let current: unknown = value;
  for (const key of path.slice(0, -1)) current = containerProperty(current, key);
  setContainerProperty(current, path[path.length - 1], replacement);
}

/** The payload with an unknown property at the top level and one inside a nested object. */
export function unknownPropertyVariants(input: FixtureInput): readonly [unknown, unknown] {
  const nested: readonly (string | number)[] = input.name === 'ObjectSimple' ? ['scale', 'extra']
    : input.name === 'ObjectHierarchical-Constrained' ? ['channel', 'extra']
      : ['data', 0, 'departments', 0, 'extra'];
  return [mutateAt(input.payload, ['extra'], 1), mutateAt(input.payload, nested, 1)];
}

export function invalidVariants(input: FixtureInput): readonly [unknown, unknown, unknown] {
  switch (input.name) {
    case 'ObjectSimple':
      return [
        mutateAt(input.payload, ['scale', 'x'], 'invalid-number'),
        omitAt(input.payload, ['scale']),
        mutateAt(input.payload, ['pivot', 'z'], 'invalid-number'),
      ];
    case 'ObjectHierarchical-Constrained':
      return [
        mutateAt(input.payload, ['id'], 0),
        mutateAt(input.payload, ['channel', 'code'], 'x'),
        mutateAt(input.payload, ['member', 'emails'], []),
      ];
    case 'ArrayHierarchical-1000':
      return [
        mutateAt(input.payload, ['data', 0, 'serial'], 'invalid-number'),
        omitAt(input.payload, ['data', 0, 'departments']),
        mutateAt(input.payload, ['data', 0, 'departments', 0, 'employees', 0, 'grade'], 'invalid-number'),
      ];
  }
}

export function missingNullable(input: FixtureInput): unknown | undefined {
  if (input.name !== 'ObjectHierarchical-Constrained') return undefined;
  return omitAt(input.payload, ['account']);
}

export function invalidIpLength(input: FixtureInput): unknown | undefined {
  if (input.name !== 'ObjectHierarchical-Constrained') return undefined;
  return mutateAt(input.payload, ['ip'], [127, 0, 0]);
}

export function nullableVariant(input: FixtureInput): unknown | undefined {
  if (input.name !== 'ObjectHierarchical-Constrained') return undefined;
  const copy = clonePayload(input.payload);
  const root = copy;
  const member = containerProperty(root, 'member');
  setContainerProperty(root, 'account', null);
  setContainerProperty(member, 'enterprise', null);
  return copy;
}

export function assertValidWire(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, 'adapter output must retain the complete upstream wire value');
}

export function assertValidText(actual: unknown, expected: string): asserts actual is string {
  assert.equal(actual, expected, 'adapter output must retain the compact JSON representation');
}

export function assertNoMutation(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, 'adapter must not modify its input payload');
}
