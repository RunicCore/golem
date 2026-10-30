import { schemaIssueMessage, type SchemaIssue, type SchemaIssueDetail } from './issue-messages.js';

/**
 * Failures owned by model validation, JSON serialization, and the generated
 * HTTP client transport (`Response`: a response the operation does not declare).
 */
export enum LibErrorKind {
  Validation = 'validation',
  Serialization = 'serialization',
  Deserialization = 'deserialization',
  InvalidJson = 'invalid_json',
  ValidationUnavailable = 'validation_unavailable',
  Response = 'response',
}

export enum IssueSource {
  TypeScript = 'typescript',
  OpenAPI = 'openapi',
  Custom = 'custom',
  External = 'external',
  JSON = 'json',
  Serde = 'serde',
}

export enum IssueRepresentation { Model = 'model', Wire = 'wire' }

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type IssuePath = readonly (string | number)[];

/** What failed, with the typed fields of that code. */
export type IssueDetail =
  | SchemaIssueDetail
  | { readonly code: 'invalid_json' }
  | { readonly code: 'serialization' }
  | { readonly code: 'deserialization' }
  | { readonly code: 'external' };

export type Issue = {
  readonly path: IssuePath;
  readonly message: string;
  readonly source: IssueSource;
  readonly representation?: IssueRepresentation;
} & IssueDetail;

export type IssueCode = Issue['code'];

/** A validator's issue with golem's default message, the source that produced it and the value plane it checked. */
export function toIssue(issue: SchemaIssue, source: IssueSource, representation?: IssueRepresentation): Issue {
  return {
    ...issue,
    message: schemaIssueMessage(issue),
    source,
    ...(representation === undefined ? {} : { representation }),
  };
}

function copyJson(value: JsonValue, active: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || active.has(value)) throw new TypeError('Issue values must contain finite, acyclic JSON values.');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const copied: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new TypeError('Issue value arrays must not contain holes.');
        copied.push(copyJson(value[index], active));
      }
      return Object.freeze(copied);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) throw new TypeError('Issue values must be plain JSON objects.');
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item, active)])));
  } finally { active.delete(value); }
}

/** The code and its typed fields, copied so the snapshot shares nothing mutable with the caller. */
function snapshotDetail(issue: Issue): IssueDetail {
  switch (issue.code) {
    case 'type': return { code: issue.code, expected: Object.freeze([...issue.expected]) };
    case 'instance': return { code: issue.code, model: issue.model };
    case 'required':
    case 'unknownKey':
    case 'invalidKey': return { code: issue.code, key: issue.key };
    case 'literal': return { code: issue.code, expected: Object.freeze(issue.expected.map(value => copyJson(value, new Set()))) };
    case 'union': return { code: issue.code, matched: issue.matched };
    case 'tooSmall':
    case 'tooBig': return { code: issue.code, measure: issue.measure, limit: issue.limit, inclusive: issue.inclusive };
    case 'pattern': return { code: issue.code, pattern: issue.pattern };
    case 'format': return { code: issue.code, format: issue.format };
    case 'multipleOf': return { code: issue.code, divisor: issue.divisor };
    case 'unique': return { code: issue.code, indexes: Object.freeze([issue.indexes[0], issue.indexes[1]] as const) };
    case 'custom': return { code: issue.code, ...(issue.reason === undefined ? {} : { reason: issue.reason }) };
    case 'not':
    case 'never':
    case 'invalid_json':
    case 'serialization':
    case 'deserialization':
    case 'external': return { code: issue.code };
    default: {
      // Untyped JavaScript callers can send a code the union does not have.
      const unknown: { readonly code: unknown } = issue;
      throw new TypeError(`Unknown issue code: ${String(unknown.code)}.`);
    }
  }
}

export function snapshotIssues(issues: readonly Issue[]): readonly Issue[] {
  return Object.freeze(issues.map(issue => Object.freeze({
    ...snapshotDetail(issue),
    message: issue.message,
    path: Object.freeze([...issue.path]),
    source: issue.source,
    ...(issue.representation === undefined ? {} : { representation: issue.representation }),
  })));
}

export interface LibErrorOptions extends ErrorOptions {
  /** The input value, not the program, caused the failure (for example an HTTP 400). */
  readonly causedByInput?: boolean;
}

/**
 * The registry symbol every copy of golem shares. An application and a standalone SDK each hold their own copy of this
 * module, so `instanceof` on a class cannot see across them; the brand can. The suffix names the error contract
 * (`kind`, `issues`, `causedByInput`): a change to that shape takes a new suffix.
 */
const LIB_ERROR_BRAND = Symbol.for('@exprtlabs/golem:LibError.v1');

export class LibError extends Error {
  static {
    // On the prototype, so the brand is no own property of an instance and every subclass instance carries it.
    Object.defineProperty(LibError.prototype, LIB_ERROR_BRAND, { value: true });
  }

  /**
   * `instanceof LibError` is true for an error of any golem copy. A subclass keeps the ordinary prototype check, so
   * `instanceof MyError` is not true for every LibError.
   */
  public static override [Symbol.hasInstance](this: Function, value: unknown): value is LibError {
    if (this !== LibError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === 'object' && value !== null && (value as { readonly [LIB_ERROR_BRAND]?: unknown })[LIB_ERROR_BRAND] === true;
  }

  public readonly kind: LibErrorKind;
  public readonly issues: readonly Issue[];
  /**
   * True when the rejected value is at fault: validation, invalid JSON, and
   * wire input that conversion cannot decode. False for program faults such
   * as missing generated metadata or a throwing application converter.
   */
  public readonly causedByInput: boolean;

  public constructor(kind: LibErrorKind, message: string, issues: readonly Issue[] = [], options?: LibErrorOptions) {
    super(message, options);
    this.name = 'LibError';
    this.kind = kind;
    this.issues = snapshotIssues(issues);
    this.causedByInput = options?.causedByInput
      ?? (kind === LibErrorKind.Validation || kind === LibErrorKind.InvalidJson);
  }
}
