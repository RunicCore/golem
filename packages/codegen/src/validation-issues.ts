import {
  IssueCode, IssueRepresentation, IssueSource, mapValidationCode, snapshotIssues,
  type Issue, type IssuePath, type JsonValue,
} from './errors.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Pointer tokens are interpreted against the input to retain numeric object keys. */
function segments(pointer: unknown, value: unknown): (string | number)[] {
  if (typeof pointer !== 'string' || pointer === '') return [];
  const result: (string | number)[] = [];
  let parent = value;
  for (const token of pointer.split('/').slice(1)) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    const segment = Array.isArray(parent) && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key;
    result.push(segment);
    parent = parent !== null && typeof parent === 'object' ? Reflect.get(parent, key) : undefined;
  }
  return result;
}

function jsonParameter(value: unknown, active = new Set<object>()): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || active.has(value)) return undefined;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) return undefined;
        const item = jsonParameter(descriptor.value, active);
        if (item === undefined) return undefined;
        items.push(item);
      }
      return items;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const fields: [string, JsonValue][] = [];
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !('value' in descriptor)) continue;
      const item = jsonParameter(descriptor.value, active);
      if (item !== undefined) fields.push([key, item]);
    }
    return Object.fromEntries(fields);
  } finally { active.delete(value); }
}

/** Copy diagnostic data without invoking accessors or retaining engine-owned objects. */
export function copyValidationErrors(errors: readonly unknown[]): readonly unknown[] {
  return errors.map(error => jsonParameter(error) ?? {});
}

export function issuesFromErrors(
  errors: readonly unknown[], value: unknown, source: IssueSource,
  representation: IssueRepresentation = IssueRepresentation.Wire,
): readonly Issue[] {
  return snapshotIssues((errors.length ? errors : [{ keyword: 'invalid', message: 'Invalid value' }]).map(raw => {
    const error = record(raw) ?? {};
    const parameters = record(error.params);
    const path = segments(error.instancePath, value);
    const property = parameters?.missingProperty ?? parameters?.additionalProperty ?? parameters?.unevaluatedProperty;
    if (typeof property === 'string') path.push(property);
    const keyword = typeof error.keyword === 'string' ? error.keyword : 'invalid';
    const code = mapValidationCode(keyword);
    const params = parameters ? record(jsonParameter(parameters)) as Readonly<Record<string, JsonValue>> | undefined : undefined;
    return {
      code, path,
      message: typeof error.message === 'string' && error.message ? error.message : 'Invalid value',
      source: code === IssueCode.Custom ? IssueSource.Custom
        : Object.values(IssueSource).includes(error.source as IssueSource) ? error.source as IssueSource : source,
      representation,
      ...(params ? { params } : {}),
    } satisfies Issue;
  }));
}

export function issuePointer(path: IssuePath): string {
  return path.map(segment => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}
