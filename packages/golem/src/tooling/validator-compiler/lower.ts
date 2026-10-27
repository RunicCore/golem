import { MODEL_DATE_KEYWORD, MODEL_INSTANCE_KEYWORD, VALIDATION_KEYWORD } from '../../schema-keywords.js';
import { unescapePointerToken } from '../../json-pointer.js';
import { isKnownFormat, jsonEqual } from '../../validation-runtime.js';
import { GolemDiagnosticSeverity, isRecord, type GolemDiagnostic } from '../generator-api.js';
import type { CompileInput, CompileOptions } from './index.js';
import type { IrAdditional, IrCheck, IrContains, IrDiscriminator, IrFunction, IrInstance, IrModule, IrSchema, IrTypeName, IrValidationImport } from './ir.js';
import { JSON_TYPES } from './function-writer.js';
import { baseInside, pointerSegment, SchemaResolver, type SchemaLocation } from './resolve.js';

export const VALIDATE_UNSUPPORTED_KEYWORD = 'VALIDATE_UNSUPPORTED_KEYWORD';
export const VALIDATE_UNRESOLVED_REF = 'VALIDATE_UNRESOLVED_REF';
export const VALIDATE_INVALID_PATTERN = 'VALIDATE_INVALID_PATTERN';
export const VALIDATE_UNKNOWN_FORMAT = 'VALIDATE_UNKNOWN_FORMAT';
export const VALIDATE_REF_CYCLE = 'VALIDATE_REF_CYCLE';
export const VALIDATE_UNKNOWN_VALIDATION = 'VALIDATE_UNKNOWN_VALIDATION';

/**
 * Validation keywords of JSON Schema 2020-12 that the compiler reports instead of ignoring, because
 * ignoring one would accept data the schema rejects. Dynamic references need a run-time scope that
 * golem's generated validators do not keep.
 */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set(['$dynamicRef', '$dynamicAnchor']);

const EVALUATION_KEYWORDS: readonly string[] = ['unevaluatedProperties', 'unevaluatedItems'];

const TYPE_NAMES: readonly IrTypeName[] = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'];

const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');

/** The shapes of standard keyword values that would loosen or crash validation if lowering dropped them. A wrong shape is an error. This is not the whole 2020-12 meta-schema: it does not check uniqueness, or a list's minimum length. */
const KEYWORD_SHAPES: readonly { readonly keywords: readonly string[]; readonly accepts: (value: unknown) => boolean; readonly expected: string }[] = [
  { keywords: ['type'], accepts: value => isTypeName(value) || (Array.isArray(value) && value.length > 0 && value.every(isTypeName)), expected: `a type name or a non-empty list of type names (${TYPE_NAMES.join(', ')})` },
  { keywords: ['enum'], accepts: Array.isArray, expected: 'a list' },
  { keywords: ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minContains', 'maxContains'], accepts: value => typeof value === 'number' && Number.isInteger(value) && value >= 0, expected: 'a non-negative integer' },
  { keywords: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'], accepts: value => finiteNumber(value) !== undefined, expected: 'a finite number' },
  { keywords: ['multipleOf'], accepts: value => typeof value === 'number' && Number.isFinite(value) && value > 0, expected: 'a finite number above 0' },
  { keywords: ['pattern', 'format'], accepts: value => typeof value === 'string', expected: 'a string' },
  { keywords: ['required'], accepts: isStringList, expected: 'a list of strings' },
  { keywords: ['uniqueItems'], accepts: value => typeof value === 'boolean', expected: 'true or false' },
  { keywords: ['properties', 'patternProperties', 'dependentSchemas'], accepts: isRecord, expected: 'an object' },
  { keywords: ['dependentRequired'], accepts: value => isRecord(value) && Object.values(value).every(isStringList), expected: 'an object whose values are lists of strings' },
  { keywords: ['allOf', 'anyOf', 'oneOf', 'prefixItems'], accepts: Array.isArray, expected: 'a list' },
];

/** A step that hands the same value to another function, so no part of the value is consumed. */
interface SameValueEdge {
  readonly to: number;
  readonly location: SchemaLocation;
  readonly keyword: string;
}

/** What the keyword steps of one schema object share: its location, the checks so far, and the ways to lower its children. */
interface RecordContext {
  readonly node: Readonly<Record<string, unknown>>;
  readonly here: SchemaLocation;
  readonly sameValue: SameValueEdge[];
  readonly checks: IrCheck[];
  readonly child: (keyword: string, value: unknown, ...more: readonly (string | number)[]) => SchemaLocation;
  readonly lowerChild: (keyword: string, value: unknown, ...more: readonly (string | number)[]) => IrSchema;
  readonly otherValueFunction: (keyword: string, value: unknown, ...more: readonly (string | number)[]) => number;
  readonly sameValueFunction: (keyword: string, value: unknown, ...more: readonly (string | number)[]) => number;
  readonly inPlaceBranch: (keyword: string, branch: unknown, position: number) => IrSchema;
  readonly malformed: (keyword: string, expected: string, ...inside: readonly string[]) => void;
}

/** `not` passes the value on, but what its schema evaluates does not count for the schema that holds it. */
function carriesEvaluation(edge: SameValueEdge): boolean {
  return edge.keyword !== 'not';
}

const ALWAYS: IrSchema = { kind: 'always' };
const NEVER: IrSchema = { kind: 'never' };

type MutableFunction = { -readonly [Key in keyof IrFunction]: IrFunction[Key] };

function callTo(fn: number): IrSchema {
  return { kind: 'checks', checks: [{ kind: 'call', fn }] };
}

// Keywords whose value is data, not schema.
const DATA_KEYWORDS: ReadonlySet<string> = new Set(['enum', 'const', 'default', 'examples']);
// Keywords whose value maps names to schemas: the names are not keywords, so `default` there is a property.
const NAME_MAP_KEYWORDS: ReadonlySet<string> = new Set(['properties', 'patternProperties', 'dependentSchemas', 'dependentRequired', '$defs', 'definitions']);

/**
 * True when the schema `value`, or a schema inside it, has one of `keys` as a keyword. Each object is read once,
 * so a schema that contains itself (a YAML alias can do that) ends the scan.
 */
function hasKey(value: unknown, keys: readonly string[], seen = new Set<object>(), namesOnly = false): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => hasKey(item, keys, seen));
  return Object.entries(value).some(([key, item]) => {
    if (!namesOnly && keys.includes(key)) return true;
    if (!namesOnly && DATA_KEYWORDS.has(key)) return false;
    return hasKey(item, keys, seen, !namesOnly && NAME_MAP_KEYWORDS.has(key));
  });
}

/** True when the schema node itself holds `unevaluatedProperties` or `unevaluatedItems`. */
function holdsEvaluationKeyword(node: unknown): boolean {
  return isRecord(node) && EVALUATION_KEYWORDS.some(keyword => Object.hasOwn(node, keyword));
}

// Keywords that describe a schema and never reject a value.
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set(['title', 'description', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly']);

/**
 * The values a branch allows when its only validation keywords are `const` or `enum`, and a `type` that every value
 * satisfies; undefined for any other branch.
 */
function literalBranchValues(branch: unknown): readonly unknown[] | undefined {
  if (!isRecord(branch) || Object.hasOwn(branch, 'const') === Array.isArray(branch.enum)) return undefined;
  if (!Object.keys(branch).every(key => key === 'const' || key === 'enum' || key === 'type' || ANNOTATION_KEYWORDS.has(key) || key.startsWith('x-'))) return undefined;
  const values = Object.hasOwn(branch, 'const') ? [branch.const] : branch.enum as readonly unknown[];
  // A value with no JSON form is left to the branch's own lowering, which reports it.
  if (holdsNonFiniteNumber(values)) return undefined;
  if (!Object.hasOwn(branch, 'type')) return values;
  const names = typeof branch.type === 'string' ? [branch.type] : Array.isArray(branch.type) ? branch.type as readonly unknown[] : [];
  if (names.length === 0 || !names.every(isTypeName)) return undefined;
  return values.every(value => names.some(name => JSON_TYPES[name].test(value))) ? values : undefined;
}

/**
 * The values of an `anyOf` or `oneOf` whose every branch is a literal, in branch order; undefined when a branch is
 * anything else, when no value is allowed, or when a value repeats (a `oneOf` then has two matching branches).
 */
function literalUnionValues(branches: readonly unknown[]): readonly unknown[] | undefined {
  const lists = branches.map(literalBranchValues);
  if (!lists.every((list): list is readonly unknown[] => list !== undefined)) return undefined;
  const values = lists.flat();
  const distinct = values.every((value, position) => values.findIndex(other => jsonEqual(value, other)) === position);
  return values.length > 0 && distinct ? values : undefined;
}

/** What a `$ref` target is called: the last segment of its pointer; a whole resource has no segment, and its name may be a digest. */
function referenceName(target: SchemaLocation): string | undefined {
  return target.pointer === '' ? undefined : unescapePointerToken(target.pointer.slice(target.pointer.lastIndexOf('/') + 1));
}

function isTypeName(value: unknown): value is IrTypeName {
  return TYPE_NAMES.some(name => name === value);
}

/** True when the value is, or holds at any depth, a number that is not finite. */
function holdsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(holdsNonFiniteNumber);
  return isRecord(value) && Object.values(value).some(holdsNonFiniteNumber);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The value of `golemModelInstance` as an IR node; undefined when it does not have the shape `schema.ts` writes: `{ of?: string, among: string[], required: boolean }`. */
function modelInstance(value: unknown): IrInstance | undefined {
  if (!isRecord(value)) return undefined;
  const { of, among, required } = value;
  if ((of !== undefined && typeof of !== 'string') || !Array.isArray(among) || typeof required !== 'boolean') return undefined;
  if (!among.every((id): id is string => typeof id === 'string')) return undefined;
  return { kind: 'instance', ...(of === undefined ? {} : { of }), among, required };
}

/** The message of the error `new RegExp(source, 'u')` throws, or undefined when it compiles. */
function patternError(source: string): string | undefined {
  try {
    new RegExp(source, 'u');
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return error.message;
    throw error;
  }
}

interface LoweringResult {
  readonly module: IrModule;
  readonly diagnostics: readonly GolemDiagnostic[];
}

/**
 * Lowers every root, and every schema a root reaches through `$ref`, to validation IR. A standard keyword
 * whose value has the wrong shape (see `KEYWORD_SHAPES`), and an `enum` or `const` that holds a number JSON
 * cannot write, is an error: the callers that read a document check it against the 2020-12 meta-schema, which
 * leaves non-finite numbers to this step, and `writeSdk` takes a document unchecked.
 */
export function lower(input: CompileInput, options: Pick<CompileOptions, 'unknownFormats' | 'documentName' | 'locate'>): LoweringResult {
  return new Lowering(input, options).run();
}

class Lowering {
  private readonly resolver: SchemaResolver;
  private readonly diagnostics: GolemDiagnostic[] = [];
  private readonly reported = new Set<string>();
  private readonly functions: MutableFunction[] = [];
  private readonly functionIds = new Map<object, number>();
  private readonly sameValueEdges: (readonly SameValueEdge[])[] = [];
  /** The schema objects whose bodies are being lowered inline; one that contains itself becomes a function instead of recursing. */
  private readonly inlining = new Set<object>();
  /** The user validation functions the module imports, in order of first use. */
  private readonly validationImports: IrValidationImport[] = [];
  private readonly pending: { readonly id: number; readonly location: SchemaLocation }[] = [];
  /** True when any schema of the compilation holds `unevaluatedProperties` or `unevaluatedItems`; only then do checks keep what they evaluate. */
  private readonly tracksEvaluation: boolean;

  public constructor(
    private readonly input: CompileInput,
    private readonly options: Pick<CompileOptions, 'unknownFormats' | 'documentName' | 'locate'>,
  ) {
    this.resolver = new SchemaResolver(input.roots, input.resources ?? new Map());
    this.tracksEvaluation = [...input.roots.values(), ...(input.resources?.values() ?? [])].some(schema => hasKey(schema, EVALUATION_KEYWORDS));
  }

  public run(): LoweringResult {
    const exports = [...this.input.roots.keys()].map(name => ({ name, fn: this.functionFor(this.resolver.rootLocation(name), name) }));
    // Lowering a function can add more; the list grows while it is walked.
    for (let next = 0; next < this.pending.length; next++) {
      const { id, location } = this.pending[next];
      const edges: SameValueEdge[] = [];
      const body = this.lowerSchema(location, edges);
      this.functions[id].body = body;
      this.functions[id].collects = body.kind === 'checks' && body.checks.some(check => check.kind === 'unevaluatedProperties' || check.kind === 'unevaluatedItems');
      this.sameValueEdges[id] = edges;
    }
    this.markEvaluationReceivers();
    this.reportRefCycles();
    return { module: { functions: this.functions, validations: this.validationImports, exports }, diagnostics: this.diagnostics };
  }

  /**
   * The function that validates `location`'s schema, created on first use and shared by every
   * referrer. The id exists before the body is lowered, so a schema that refers to itself terminates.
   */
  private functionFor(location: SchemaLocation, name?: string): number {
    const { node } = location;
    const shared = typeof node === 'object' && node !== null;
    const known = shared ? this.functionIds.get(node) : undefined;
    if (known !== undefined) {
      // The first name a schema is given stays: a root's name wins over the name of a `$ref` to the same schema.
      if (name !== undefined && this.functions[known].name === undefined) this.functions[known].name = name;
      return known;
    }
    const id = this.functions.length;
    this.functions.push({ id, ...(name === undefined ? {} : { name }), body: ALWAYS, collects: false, receives: false });
    if (shared) this.functionIds.set(node, id);
    this.pending.push({ id, location });
    return id;
  }

  private report(code: string, severity: GolemDiagnosticSeverity, location: SchemaLocation, keyword: string, text: string, ...inside: readonly string[]): void {
    const { documentName, locate } = this.options;
    const pointer = [keyword, ...inside].reduce((path, token) => path + pointerSegment(token), location.pointer);
    const place = locate?.(location.resource, pointer);
    const where = place?.where ?? `${documentName === undefined ? '' : `${documentName}: `}schema ${JSON.stringify(location.resource)} at ${pointer}`;
    const message = `${where}: ${text}`;
    // Schemas reached by several routes, such as a component used by many operations, report one diagnostic.
    const key = `${code}\0${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const path = place === undefined ? pointer : place.path;
    this.diagnostics.push({
      code,
      severity,
      message,
      ...(place?.file === undefined ? {} : { file: place.file }),
      ...(path === undefined ? {} : { path }),
    });
  }

  /**
   * The tag values the schema at `location` states for `property`: its `const`, or the values of its `enum`.
   * Reads the schema's own `properties`, follows a `$ref`, and looks into each `allOf` entry, so a branch may be
   * inline, a reference, or `allOf` of references and an inline tag. Undefined when none states them.
   */
  private tagValues(location: SchemaLocation, property: string, active: Set<object> = new Set()): readonly unknown[] | undefined {
    const { node } = location;
    if (!isRecord(node) || active.has(node)) return undefined;
    active.add(node);
    const base = baseInside(node, location.base);
    const tag = isRecord(node.properties) && Object.hasOwn(node.properties, property) ? node.properties[property] : undefined;
    if (isRecord(tag)) {
      if (Object.hasOwn(tag, 'const')) return [tag.const];
      if (Array.isArray(tag.enum) && tag.enum.length > 0) return tag.enum as readonly unknown[];
    }
    const target = typeof node.$ref === 'string' ? this.resolver.resolve(node.$ref, base) : undefined;
    const viaRef = target ? this.tagValues(target, property, active) : undefined;
    if (viaRef !== undefined) return viaRef;
    // A branch that a validation function wraps states its tag in the wrapper's own schema.
    const wrapper = node[VALIDATION_KEYWORD];
    if (isRecord(wrapper) && wrapper.schema !== undefined) {
      const inner = this.tagValues({ node: wrapper.schema, base, resource: location.resource, pointer: `${location.pointer}${pointerSegment(VALIDATION_KEYWORD)}${pointerSegment('schema')}` }, property, active);
      if (inner !== undefined) return inner;
    }
    if (!Array.isArray(node.allOf)) return undefined;
    for (const [position, entry] of (node.allOf as readonly unknown[]).entries()) {
      const found = this.tagValues({ node: entry, base, resource: location.resource, pointer: `${location.pointer}${pointerSegment('allOf')}${pointerSegment(position)}` }, property, active);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The discriminator of a `oneOf` list, when every branch states its tag values and no value repeats; otherwise it is an annotation. */
  private discriminatorOf(node: Readonly<Record<string, unknown>>, branches: readonly SchemaLocation[]): IrDiscriminator | undefined {
    const { discriminator } = node;
    if (!isRecord(discriminator) || typeof discriminator.propertyName !== 'string') return undefined;
    const property = discriminator.propertyName;
    const tags = branches.map(branch => this.tagValues(branch, property));
    if (!tags.every((list): list is readonly unknown[] => list !== undefined)) return undefined;
    const seen = new Set(tags.flat().map(tag => JSON.stringify(tag)));
    return seen.size === tags.flat().length ? { property, tags } : undefined;
  }

  /**
   * A function that a collector reaches through steps that pass the whole value on receives the collector's
   * record, and so does every function such a step reaches in turn.
   */
  private markEvaluationReceivers(): void {
    const queue = this.functions.filter(fn => fn.collects).map(fn => fn.id);
    for (let next = 0; next < queue.length; next++) {
      for (const edge of this.sameValueEdges[queue[next]] ?? []) {
        if (!carriesEvaluation(edge) || this.functions[edge.to].receives) continue;
        this.functions[edge.to].receives = true;
        queue.push(edge.to);
      }
    }
  }

  /**
   * A cycle of functions that each pass the whole value on never reads it: it would recurse until the
   * stack overflows for any input. A cycle that goes through a property or an item is a recursive
   * structure and is fine.
   */
  private reportRefCycles(): void {
    const visited = new Set<number>();
    const active = new Set<number>();
    const trail: { readonly from: number; readonly edge: SameValueEdge }[] = [];
    const visit = (id: number): void => {
      visited.add(id);
      active.add(id);
      for (const edge of this.sameValueEdges[id] ?? []) {
        if (active.has(edge.to)) {
          const start = trail.findIndex(step => step.from === edge.to);
          const cycle = [...(start < 0 ? [] : trail.slice(start).map(step => step.edge)), edge];
          const reference = cycle.find(step => step.keyword === '$ref') ?? edge;
          this.report(VALIDATE_REF_CYCLE, GolemDiagnosticSeverity.Error, reference.location, reference.keyword, 'the $ref chain returns to a schema without reading any part of the value, so it cannot finish');
        } else if (!visited.has(edge.to)) {
          trail.push({ from: id, edge });
          visit(edge.to);
          trail.pop();
        }
      }
      active.delete(id);
    };
    for (let id = 0; id < this.functions.length; id++) if (!visited.has(id)) visit(id);
  }

  /** The index of `entry` in the module's imports; one function is imported once however many bindings name it. */
  private importIndex(entry: IrValidationImport): number {
    const known = this.validationImports.findIndex(item => item.importPath === entry.importPath && item.exportName === entry.exportName);
    if (known >= 0) return known;
    this.validationImports.push({ importPath: entry.importPath, exportName: entry.exportName });
    return this.validationImports.length - 1;
  }

  /**
   * The indexes of the functions the binding ids name, in order, each once. An id that `input.validations` does not
   * hold is an error. `inside` is the path from the keyword to the list.
   */
  private bindingCalls(ids: readonly unknown[], location: SchemaLocation, ...inside: readonly string[]): number[] {
    const calls: number[] = [];
    const seen = new Set<string>();
    ids.forEach((id, position) => {
      if (typeof id !== 'string' || seen.has(id)) return;
      seen.add(id);
      const entry = this.input.validations?.get(id);
      if (entry === undefined) {
        this.report(VALIDATE_UNKNOWN_VALIDATION, GolemDiagnosticSeverity.Error, location, VALIDATION_KEYWORD, `the validation function ${JSON.stringify(id)} is not among the functions to import`, ...inside, String(position));
      } else {
        calls.push(this.importIndex(entry));
      }
    });
    return calls;
  }

  private isInlining(node: unknown): boolean {
    return typeof node === 'object' && node !== null && this.inlining.has(node);
  }

  private lowerSchema(location: SchemaLocation, sameValue: SameValueEdge[]): IrSchema {
    const { node } = location;
    if (node === true) return ALWAYS;
    if (node === false) return NEVER;
    if (!isRecord(node)) return ALWAYS;
    this.inlining.add(node);
    try {
      return this.lowerRecord(node, location, sameValue);
    } finally {
      this.inlining.delete(node);
    }
  }

  /** Lowers one schema object: each group of keywords adds its checks to the context, in the order the validators run them. */
  private lowerRecord(node: Readonly<Record<string, unknown>>, location: SchemaLocation, sameValue: SameValueEdge[]): IrSchema {
    const here: SchemaLocation = { ...location, base: baseInside(node, location.base) };
    for (const keyword of Object.keys(node)) {
      if (UNSUPPORTED_KEYWORDS.has(keyword)) this.report(VALIDATE_UNSUPPORTED_KEYWORD, GolemDiagnosticSeverity.Error, here, keyword, `the keyword ${keyword} is not supported`);
    }
    const cx = this.recordContext(node, here, sameValue);
    this.checkShapes(cx);
    this.lowerTypeAndValues(cx);
    this.lowerReference(cx);
    this.lowerString(cx);
    this.lowerNumber(cx);
    this.lowerFormat(cx);
    this.lowerArray(cx);
    this.lowerObject(cx);
    this.lowerComposition(cx);
    this.lowerConditional(cx);
    this.lowerValidation(cx);
    this.lowerUnevaluated(cx);
    return cx.checks.length === 0 ? ALWAYS : { kind: 'checks', checks: cx.checks };
  }

  /** The context of one schema object: its child locations, and the ways to lower a child that applies to the same value or to another. */
  private recordContext(node: Readonly<Record<string, unknown>>, here: SchemaLocation, sameValue: SameValueEdge[]): RecordContext {
    // Every schema position of a keyword comes through here, so a value that is no schema is one error in one place.
    const child = (keyword: string, value: unknown, ...more: readonly (string | number)[]): SchemaLocation => {
      if (typeof value !== 'boolean' && !isRecord(value)) malformed(keyword, 'expected a boolean or a schema object', ...more.map(String));
      return {
        ...here,
        node: value,
        pointer: more.reduce<string>((path, token) => path + pointerSegment(token), here.pointer + pointerSegment(keyword)),
      };
    };
    // A child that reads part of the value (a property, an item) starts a new chain of same-value steps. A child
    // that holds `unevaluatedProperties` or `unevaluatedItems` is its own function, because its record belongs to the
    // child value, not to this one.
    const lowerChild = (keyword: string, value: unknown, ...more: readonly (string | number)[]): IrSchema => {
      const location = child(keyword, value, ...more);
      return holdsEvaluationKeyword(location.node) || this.isInlining(location.node) ? callTo(this.functionFor(location)) : this.lowerSchema(location, []);
    };
    // A schema that applies to another value than this one (an item tried by `contains`, a key read by `propertyNames`).
    const otherValueFunction = (keyword: string, value: unknown, ...more: readonly (string | number)[]): number => this.functionFor(child(keyword, value, ...more));
    const sameValueFunction = (keyword: string, value: unknown, ...more: readonly (string | number)[]): number => {
      const location = child(keyword, value, ...more);
      const to = this.functionFor(location);
      sameValue.push({ to, location: here, keyword });
      return to;
    };
    // A branch that applies to this value in place. One with its own `unevaluated*` keyword is its own function: it must not see what its siblings evaluated.
    const inPlaceBranch = (keyword: string, branch: unknown, position: number): IrSchema => {
      if (holdsEvaluationKeyword(branch) || this.isInlining(branch)) return callTo(sameValueFunction(keyword, branch, position));
      return this.lowerSchema(child(keyword, branch, position), sameValue);
    };
    // A golem keyword with a malformed value is an error: dropping it would accept data its rule rejects.
    const malformed = (keyword: string, expected: string, ...inside: readonly string[]): void => this.report(VALIDATE_UNSUPPORTED_KEYWORD, GolemDiagnosticSeverity.Error, here, keyword, `the value of ${keyword} is not valid: ${expected}`, ...inside);
    return { node, here, sameValue, checks: [], child, lowerChild, otherValueFunction, sameValueFunction, inPlaceBranch, malformed };
  }

  /** One error for each standard keyword of the schema whose value has the wrong shape. */
  private checkShapes({ node, malformed }: RecordContext): void {
    for (const { keywords, accepts, expected } of KEYWORD_SHAPES) {
      for (const keyword of keywords) {
        if (Object.hasOwn(node, keyword) && !accepts(node[keyword])) malformed(keyword, `expected ${expected}`);
      }
    }
  }

  private lowerTypeAndValues({ node, checks, malformed }: RecordContext): void {
    const typeList = typeof node.type === 'string' ? [node.type] : Array.isArray(node.type) ? node.type as readonly unknown[] : [];
    const names = typeList.filter(isTypeName);
    if (names.length > 0) checks.push({ kind: 'type', names });

    if (Object.hasOwn(node, MODEL_DATE_KEYWORD)) {
      if (typeof node[MODEL_DATE_KEYWORD] !== 'boolean') malformed(MODEL_DATE_KEYWORD, 'expected true or false');
      else if (node[MODEL_DATE_KEYWORD]) checks.push({ kind: 'date' });
    }
    if (Object.hasOwn(node, MODEL_INSTANCE_KEYWORD)) {
      const instance = modelInstance(node[MODEL_INSTANCE_KEYWORD]);
      if (instance === undefined) malformed(MODEL_INSTANCE_KEYWORD, 'expected an object with an optional string "of", a list of strings "among" and a boolean "required"');
      else checks.push(instance);
    }

    // The validators write these values as JSON, which turns Infinity and NaN into null: a null would pass.
    if (Object.hasOwn(node, 'const')) {
      if (holdsNonFiniteNumber(node.const)) malformed('const', 'expected a JSON value; a number that is not finite has no JSON form');
      else checks.push({ kind: 'literal', values: [node.const] });
    }
    if (Array.isArray(node.enum)) {
      if (holdsNonFiniteNumber(node.enum)) malformed('enum', 'expected JSON values; a number that is not finite has no JSON form');
      else checks.push({ kind: 'literal', values: node.enum as readonly unknown[] });
    }
  }

  private lowerReference({ node, here, sameValue, checks, malformed }: RecordContext): void {
    if (typeof node.$ref !== 'string') return;
    const target = this.resolver.resolve(node.$ref, here.base);
    if (target && typeof target.node !== 'boolean' && !isRecord(target.node)) {
      malformed('$ref', `expected a reference to a schema; ${JSON.stringify(node.$ref)} names ${target.pointer === '' ? 'the whole document' : target.pointer}, which is no schema`);
    } else if (target) {
      const to = this.functionFor(target, referenceName(target));
      sameValue.push({ to, location: here, keyword: '$ref' });
      checks.push({ kind: 'call', fn: to });
    }
    else this.report(VALIDATE_UNRESOLVED_REF, GolemDiagnosticSeverity.Error, here, '$ref', `the reference ${JSON.stringify(node.$ref)} does not resolve to a schema`);
  }

  private lowerString({ node, here, checks }: RecordContext): void {
    const minLength = finiteNumber(node.minLength);
    const maxLength = finiteNumber(node.maxLength);
    let pattern: string | undefined;
    if (typeof node.pattern === 'string') {
      const problem = patternError(node.pattern);
      if (problem === undefined) pattern = node.pattern;
      else this.report(VALIDATE_INVALID_PATTERN, GolemDiagnosticSeverity.Error, here, 'pattern', `the pattern ${JSON.stringify(node.pattern)} is not a valid regular expression: ${problem}`);
    }
    if (minLength !== undefined || maxLength !== undefined || pattern !== undefined) checks.push({ kind: 'string', minLength, maxLength, pattern });
  }

  private lowerNumber({ node, checks }: RecordContext): void {
    const divisor = finiteNumber(node.multipleOf);
    const limits = {
      minimum: finiteNumber(node.minimum),
      exclusiveMinimum: finiteNumber(node.exclusiveMinimum),
      maximum: finiteNumber(node.maximum),
      exclusiveMaximum: finiteNumber(node.exclusiveMaximum),
      multipleOf: divisor !== undefined && divisor > 0 ? divisor : undefined,
    };
    if (Object.values(limits).some(limit => limit !== undefined)) checks.push({ kind: 'number', ...limits });
  }

  private lowerFormat({ node, here, checks }: RecordContext): void {
    if (typeof node.format !== 'string') return;
    if (isKnownFormat(node.format)) {
      checks.push({ kind: 'format', format: node.format });
    } else {
      const severity = this.options.unknownFormats === 'error' ? GolemDiagnosticSeverity.Error : GolemDiagnosticSeverity.Warning;
      this.report(VALIDATE_UNKNOWN_FORMAT, severity, here, 'format', `the format ${JSON.stringify(node.format)} is not implemented${severity === GolemDiagnosticSeverity.Warning ? ' and is not checked' : ', so golem cannot check it.'}`);
    }
  }

  private lowerArray({ node, checks, lowerChild, otherValueFunction }: RecordContext): void {
    const prefixItems = Array.isArray(node.prefixItems) ? (node.prefixItems as readonly unknown[]).map((item, position) => lowerChild('prefixItems', item, position)) : [];
    const closed = node.items === false;
    const items = node.items === undefined || closed ? undefined : lowerChild('items', node.items);
    const minItems = finiteNumber(node.minItems);
    const maxItems = finiteNumber(node.maxItems);
    const uniqueItems = node.uniqueItems === true;
    let contains: IrContains | undefined;
    if (node.contains !== undefined) {
      contains = { fn: otherValueFunction('contains', node.contains), min: finiteNumber(node.minContains) ?? 1, max: finiteNumber(node.maxContains) };
    }
    const marksItems = this.tracksEvaluation && (prefixItems.length > 0 || items !== undefined);
    // An array schema always checks its items: a hole in the array is no JSON value.
    const arrayType = node.type === 'array' || (Array.isArray(node.type) && node.type.includes('array'));
    if (arrayType || prefixItems.some(item => item.kind !== 'always') || (items !== undefined && items.kind !== 'always') || closed || contains !== undefined || marksItems || minItems !== undefined || maxItems !== undefined || uniqueItems) {
      checks.push({ kind: 'array', prefixItems, items, closed, contains, minItems, maxItems, uniqueItems });
    }
  }

  private lowerObject({ node, here, checks, lowerChild, otherValueFunction }: RecordContext): void {
    const required = Array.isArray(node.required) ? (node.required as readonly unknown[]).filter((key): key is string => typeof key === 'string') : [];
    const properties = isRecord(node.properties)
      ? Object.entries(node.properties).map(([key, schema]) => ({ key, schema: lowerChild('properties', schema, key) }))
      : [];
    const patternProperties: { readonly pattern: string; readonly schema: IrSchema }[] = [];
    if (isRecord(node.patternProperties)) {
      for (const [source, schema] of Object.entries(node.patternProperties)) {
        const problem = patternError(source);
        if (problem === undefined) patternProperties.push({ pattern: source, schema: lowerChild('patternProperties', schema, source) });
        else this.report(VALIDATE_INVALID_PATTERN, GolemDiagnosticSeverity.Error, here, 'patternProperties', `the pattern ${JSON.stringify(source)} is not a valid regular expression: ${problem}`, source);
      }
    }
    const dependentRequired = isRecord(node.dependentRequired)
      ? Object.entries(node.dependentRequired).flatMap(([trigger, keys]) => Array.isArray(keys) ? [{ trigger, keys: (keys as readonly unknown[]).filter((key): key is string => typeof key === 'string') }] : [])
      : [];
    let additional: IrAdditional | undefined;
    if (node.additionalProperties === false) {
      additional = { kind: 'forbid' };
    } else if (node.additionalProperties !== undefined) {
      const schema = lowerChild('additionalProperties', node.additionalProperties);
      if (schema.kind !== 'always' || this.tracksEvaluation) additional = { kind: 'schema', schema };
    }
    const propertyNames = node.propertyNames === undefined ? undefined : otherValueFunction('propertyNames', node.propertyNames);
    const minProperties = finiteNumber(node.minProperties);
    const maxProperties = finiteNumber(node.maxProperties);
    const marksKeys = this.tracksEvaluation && (properties.length > 0 || patternProperties.length > 0);
    const checksKeys = required.length > 0 || dependentRequired.some(entry => entry.keys.length > 0) || properties.some(property => property.schema.kind !== 'always') || patternProperties.some(entry => entry.schema.kind !== 'always');
    if (checksKeys || marksKeys || additional !== undefined || propertyNames !== undefined || minProperties !== undefined || maxProperties !== undefined) {
      checks.push({ kind: 'object', required, dependentRequired, properties, patternProperties, additional, propertyNames, minProperties, maxProperties });
    }
  }

  /** `allOf`, `anyOf`, `oneOf` and `not`: the branches that apply to this same value. */
  private lowerComposition({ node, checks, child, sameValueFunction, inPlaceBranch }: RecordContext): void {
    if (Array.isArray(node.allOf)) {
      const branches = (node.allOf as readonly unknown[]).map((branch, position) => inPlaceBranch('allOf', branch, position)).filter(branch => branch.kind !== 'always');
      if (branches.length > 0) checks.push({ kind: 'allOf', branches });
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const list = node[keyword];
      if (Array.isArray(list) && list.length > 0) {
        // Constants alone make a union of values: one `literal` issue says which are allowed, and no branch needs a function.
        const values = literalUnionValues(list);
        if (values !== undefined) {
          checks.push({ kind: 'literal', values });
          continue;
        }
        const discriminator = keyword === 'oneOf' ? this.discriminatorOf(node, (list as readonly unknown[]).map((branch, position) => child(keyword, branch, position))) : undefined;
        // One branch is `allOf` of one: the value must pass it, and its own issues are the ones reported.
        if (list.length === 1 && discriminator === undefined) {
          const branch = inPlaceBranch(keyword, list[0], 0);
          if (branch.kind !== 'always') checks.push({ kind: 'allOf', branches: [branch] });
          continue;
        }
        const branches = (list as readonly unknown[]).map((branch, position) => sameValueFunction(keyword, branch, position));
        checks.push({ kind: 'union', exactlyOne: keyword === 'oneOf', branches, discriminator });
      }
    }
    if (node.not !== undefined) checks.push({ kind: 'not', fn: sameValueFunction('not', node.not) });
  }

  /** `if` with `then` and `else`, and `dependentSchemas`. */
  private lowerConditional({ node, checks, child, sameValueFunction }: RecordContext): void {
    // An `if` with no `then` or `else`, and a `then` or `else` with no `if`, are not lowered, but their values are still schemas.
    for (const keyword of ['if', 'then', 'else'] as const) if (node[keyword] !== undefined) child(keyword, node[keyword]);
    // `then` and `else` apply only next to an `if`; an `if` with neither changes nothing unless it marks what it evaluates.
    if (node.if !== undefined && (node.then !== undefined || node.else !== undefined || this.tracksEvaluation)) {
      checks.push({
        kind: 'conditional',
        if: sameValueFunction('if', node.if),
        then: node.then === undefined ? undefined : sameValueFunction('then', node.then),
        else: node.else === undefined ? undefined : sameValueFunction('else', node.else),
      });
    }
    if (isRecord(node.dependentSchemas)) {
      const entries = Object.entries(node.dependentSchemas).map(([trigger, schema]) => ({ trigger, fn: sameValueFunction('dependentSchemas', schema, trigger) }));
      if (entries.length > 0) checks.push({ kind: 'dependentSchemas', entries });
    }
  }

  /** `{ schema, bindings }`, or the bindings alone: the functions run once the structural schema has passed, and the schema marks what it evaluates. */
  private lowerValidation({ node, here, checks, sameValueFunction, malformed }: RecordContext): void {
    if (!Object.hasOwn(node, VALIDATION_KEYWORD)) return;
    const validation = node[VALIDATION_KEYWORD];
    const ids: unknown = isRecord(validation) ? validation.bindings : validation;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
      malformed(VALIDATION_KEYWORD, 'expected a list of validation function identifiers, or an object with such a list as "bindings"');
    } else if (Array.isArray(validation)) {
      const calls = this.bindingCalls(ids, here);
      if (calls.length > 0) checks.push({ kind: 'validation', calls });
    } else if (isRecord(validation) && validation.schema !== undefined && typeof validation.schema !== 'boolean' && !isRecord(validation.schema)) {
      malformed(VALIDATION_KEYWORD, 'expected "schema" to be a boolean or a schema object');
    } else if (isRecord(validation)) {
      const calls = this.bindingCalls(ids, here, 'bindings');
      const fn = validation.schema === undefined || validation.schema === true ? undefined : sameValueFunction(VALIDATION_KEYWORD, validation.schema, 'schema');
      if (calls.length > 0 || fn !== undefined) checks.push({ kind: 'validation', fn, calls });
    }
  }

  /** These two read what every check before them evaluated, so they come last. */
  private lowerUnevaluated({ node, checks, lowerChild }: RecordContext): void {
    if (node.unevaluatedProperties !== undefined) checks.push({ kind: 'unevaluatedProperties', schema: lowerChild('unevaluatedProperties', node.unevaluatedProperties) });
    if (node.unevaluatedItems !== undefined) checks.push({ kind: 'unevaluatedItems', schema: lowerChild('unevaluatedItems', node.unevaluatedItems) });
  }
}
