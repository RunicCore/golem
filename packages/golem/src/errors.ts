import { VALIDATION_KEYWORD } from './schema-keywords.js';

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

export enum IssueCode {
  Invalid = 'invalid',
  Literal = 'literal',
  Union = 'union',
  Never = 'never',
  Reference = 'reference',
  TupleLength = 'tupleLength',
  Type = 'type',
  Required = 'required',
  AdditionalProperties = 'additionalProperties',
  UnevaluatedProperties = 'unevaluatedProperties',
  UnevaluatedItems = 'unevaluatedItems',
  AllOf = 'allOf',
  AnyOf = 'anyOf',
  OneOf = 'oneOf',
  Const = 'const',
  Enum = 'enum',
  Contains = 'contains',
  DependentRequired = 'dependentRequired',
  DependentSchemas = 'dependentSchemas',
  ExclusiveMaximum = 'exclusiveMaximum',
  ExclusiveMinimum = 'exclusiveMinimum',
  Format = 'format',
  If = 'if',
  Maximum = 'maximum',
  Minimum = 'minimum',
  MaxContains = 'maxContains',
  MinContains = 'minContains',
  MaxItems = 'maxItems',
  MinItems = 'minItems',
  MaxLength = 'maxLength',
  MinLength = 'minLength',
  MaxProperties = 'maxProperties',
  MinProperties = 'minProperties',
  MultipleOf = 'multipleOf',
  Not = 'not',
  Pattern = 'pattern',
  PatternProperties = 'patternProperties',
  PropertyNames = 'propertyNames',
  Items = 'items',
  UniqueItems = 'uniqueItems',
  Custom = 'custom',
  External = 'external',
  InvalidJson = 'invalid_json',
  Serialization = 'serialization',
  Deserialization = 'deserialization',
  ValidationUnavailable = 'validation_unavailable',
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type IssuePath = readonly (string | number)[];
export type Issue = {
  readonly code: IssueCode;
  readonly message: string;
  readonly path: IssuePath;
  readonly source: IssueSource;
  readonly representation?: IssueRepresentation;
  readonly params?: Readonly<Record<string, JsonValue>>;
};

const issueCodes = new Set<string>(Object.values(IssueCode));
export function mapValidationCode(keyword: string): IssueCode {
  if (keyword === VALIDATION_KEYWORD) return IssueCode.Custom;
  return issueCodes.has(keyword) ? keyword as IssueCode : IssueCode.Invalid;
}

function copyJson(value: JsonValue, active: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || active.has(value)) throw new TypeError('Issue parameters must contain finite, acyclic JSON values.');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const copied: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new TypeError('Issue parameter arrays must not contain holes.');
        copied.push(copyJson(value[index], active));
      }
      return Object.freeze(copied);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) throw new TypeError('Issue parameters must be plain JSON objects.');
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item, active)])));
  } finally { active.delete(value); }
}

export function snapshotIssues(issues: readonly Issue[]): readonly Issue[] {
  return Object.freeze(issues.map(issue => {
    const snap: Issue = {
      code: issue.code,
      message: issue.message,
      path: Object.freeze([...issue.path]),
      source: issue.source,
      ...(issue.representation === undefined ? {} : { representation: issue.representation }),
      ...(issue.params === undefined ? {} : {
        params: Object.freeze(Object.fromEntries(Object.entries(issue.params).map(([key, value]) => [key, copyJson(value, new Set())]))),
      }),
    };
    return Object.freeze(snap);
  }));
}

export interface LibErrorOptions extends ErrorOptions {
  /** The input value, not the program, caused the failure (for example an HTTP 400). */
  readonly causedByInput?: boolean;
}

export class LibError extends Error {
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
