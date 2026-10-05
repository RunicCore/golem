import {
  IssueRepresentation, IssueSource, snapshotIssues, toIssue,
  type Issue, type IssuePath, type JsonValue,
} from './errors.js';
import { MODEL_DATE_KEYWORD, MODEL_INSTANCE_KEYWORD, VALIDATION_KEYWORD } from './schema-keywords.js';
import type { JsonTypeName, SchemaIssueDetail } from './issue-messages.js';

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

const JSON_TYPE_NAMES: ReadonlySet<string> = new Set<JsonTypeName>(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array', 'Date']);
const SOURCES: readonly unknown[] = Object.values(IssueSource);

/** Ajv reports an `if` keyword failure next to the branch issues it already carries; the issues of the branch are the report. */
export function reportedAjvErrors(errors: readonly unknown[]): readonly unknown[] {
  return errors.filter(raw => record(raw)?.keyword !== 'if');
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function tooSmall(measure: 'length' | 'items' | 'properties' | 'value' | 'matches', limit: unknown, inclusive = true): SchemaIssueDetail {
  return { code: 'tooSmall', measure, limit: count(limit), inclusive };
}

function tooBig(measure: 'length' | 'items' | 'properties' | 'value' | 'matches', limit: unknown, inclusive = true): SchemaIssueDetail {
  return { code: 'tooBig', measure, limit: count(limit), inclusive };
}

/** The type-level issue for one Ajv error. Dies with Ajv: the generated validators report these issues directly. */
function detailFromAjvError(keyword: unknown, parameters: Record<string, unknown> | undefined, message: unknown): SchemaIssueDetail {
  const params = parameters ?? {};
  switch (keyword) {
    case 'type': {
      const names = Array.isArray(params.type) ? params.type : [params.type];
      return { code: 'type', expected: names.filter((name): name is JsonTypeName => typeof name === 'string' && JSON_TYPE_NAMES.has(name)) };
    }
    case MODEL_DATE_KEYWORD: return { code: 'type', expected: ['Date'] };
    // Ajv does not report which model the keyword checks.
    case MODEL_INSTANCE_KEYWORD: return { code: 'instance', model: 'the selected variant' };
    case 'required':
    case 'dependentRequired': return { code: 'required', key: String(params.missingProperty) };
    case 'additionalProperties': return { code: 'unknownKey', key: String(params.additionalProperty) };
    case 'unevaluatedProperties': return { code: 'unknownKey', key: String(params.unevaluatedProperty) };
    case 'propertyNames': return { code: 'invalidKey', key: String(params.propertyName) };
    case 'const': return { code: 'literal', expected: [jsonParameter(params.allowedValue) ?? null] };
    case 'enum': {
      const values = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      return { code: 'literal', expected: values.map(value => jsonParameter(value) ?? null) };
    }
    case 'anyOf':
    // Ajv's own discriminator check reports a tag no branch accepts.
    case 'discriminator': return { code: 'union', matched: 0 };
    case 'oneOf': return { code: 'union', matched: Array.isArray(params.passingSchemas) ? params.passingSchemas.length : 0 };
    case 'minLength': return tooSmall('length', params.limit);
    case 'maxLength': return tooBig('length', params.limit);
    case 'minItems': return tooSmall('items', params.limit);
    case 'maxItems':
    // The schema closes a tuple: `limit` is the number of items it allows.
    case 'items':
    case 'unevaluatedItems': return tooBig('items', params.limit);
    case 'minProperties': return tooSmall('properties', params.limit);
    case 'maxProperties': return tooBig('properties', params.limit);
    case 'minimum': return tooSmall('value', params.limit);
    case 'maximum': return tooBig('value', params.limit);
    case 'exclusiveMinimum': return tooSmall('value', params.limit, false);
    case 'exclusiveMaximum': return tooBig('value', params.limit, false);
    // Ajv reports `minContains` and `maxContains` as one `contains` error and does not say which bound failed.
    case 'contains': return tooSmall('matches', params.minContains ?? 1);
    case 'pattern': return { code: 'pattern', pattern: String(params.pattern) };
    case 'format': return { code: 'format', format: String(params.format) };
    case 'multipleOf': return { code: 'multipleOf', divisor: count(params.multipleOf) };
    case 'uniqueItems': {
      const first = count(params.i);
      const second = count(params.j);
      return { code: 'unique', indexes: [Math.min(first, second), Math.max(first, second)] };
    }
    case 'not': return { code: 'not' };
    case 'false schema': return { code: 'never' };
    case VALIDATION_KEYWORD: {
      const reason = typeof params.message === 'string' && params.message !== 'Invalid value' ? params.message : undefined;
      return reason === undefined ? { code: 'custom' } : { code: 'custom', reason };
    }
    default: return typeof message === 'string' && message !== 'Invalid value' ? { code: 'custom', reason: message } : { code: 'custom' };
  }
}

export function issuesFromErrors(
  errors: readonly unknown[], value: unknown, source: IssueSource,
  representation: IssueRepresentation = IssueRepresentation.Wire,
): readonly Issue[] {
  const reported = reportedAjvErrors(errors);
  return snapshotIssues((reported.length ? reported : [{ keyword: 'invalid' }]).map(raw => {
    const error = record(raw) ?? {};
    const parameters = record(error.params);
    const path = segments(error.instancePath, value);
    const property = parameters?.missingProperty ?? parameters?.additionalProperty ?? parameters?.unevaluatedProperty;
    if (typeof property === 'string') path.push(property);
    const detail = detailFromAjvError(error.keyword, parameters, error.message);
    return toIssue(
      { path, ...detail },
      error.keyword === VALIDATION_KEYWORD ? IssueSource.Custom
        : SOURCES.includes(error.source) ? error.source as IssueSource : source,
      representation,
    );
  }));
}

export function issuePointer(path: IssuePath): string {
  return path.map(segment => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}
