import { MODEL_DATE_KEYWORD, MODEL_INSTANCE_KEYWORD, VALIDATION_KEYWORD } from '../../schema-keywords.js';
import { isKnownFormat } from '../../validation-runtime.js';
import { GolemDiagnosticSeverity, type GolemDiagnostic } from '../generator-api.js';
import type { CompileInput, CompileOptions } from './index.js';
import type { IrAdditional, IrCheck, IrContains, IrDiscriminator, IrFunction, IrInstance, IrModule, IrSchema, IrTypeName, IrValidationImport } from './ir.js';
import { baseInside, isRecord, pointerSegment, SchemaResolver, type SchemaLocation } from './resolve.js';

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

/** A step that hands the same value to another function, so no part of the value is consumed. */
interface SameValueEdge {
  readonly to: number;
  readonly location: SchemaLocation;
  readonly keyword: string;
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

function isTypeName(value: unknown): value is IrTypeName {
  return TYPE_NAMES.some(name => name === value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The value of `golemModelInstance` as an IR node; undefined when it does not have the shape `schema.ts` writes. */
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

export interface LoweringResult {
  readonly module: IrModule;
  readonly diagnostics: readonly GolemDiagnostic[];
}

/**
 * Lowers every root, and every schema a root reaches through `$ref`, to validation IR. Schemas are
 * assumed valid against the 2020-12 meta-schema; a keyword whose value has the wrong shape is ignored.
 */
export function lower(input: CompileInput, options: Pick<CompileOptions, 'unknownFormats' | 'documentName'>): LoweringResult {
  return new Lowering(input, options).run();
}

class Lowering {
  private readonly resolver: SchemaResolver;
  private readonly diagnostics: GolemDiagnostic[] = [];
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
    private readonly options: Pick<CompileOptions, 'unknownFormats' | 'documentName'>,
  ) {
    this.resolver = new SchemaResolver(input.roots, input.resources ?? new Map());
    this.tracksEvaluation = [...input.roots.values(), ...(input.resources?.values() ?? [])].some(schema => hasKey(schema, EVALUATION_KEYWORDS));
  }

  public run(): LoweringResult {
    const exports = [...this.input.roots.keys()].map(name => ({ name, fn: this.functionFor(this.resolver.rootLocation(name)) }));
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
  private functionFor(location: SchemaLocation): number {
    const { node } = location;
    const shared = typeof node === 'object' && node !== null;
    const known = shared ? this.functionIds.get(node) : undefined;
    if (known !== undefined) return known;
    const id = this.functions.length;
    this.functions.push({ id, body: ALWAYS, collects: false, receives: false });
    if (shared) this.functionIds.set(node, id);
    this.pending.push({ id, location });
    return id;
  }

  private report(code: string, severity: GolemDiagnosticSeverity, location: SchemaLocation, keyword: string, text: string, ...inside: readonly string[]): void {
    const { documentName } = this.options;
    const pointer = [keyword, ...inside].reduce((path, token) => path + pointerSegment(token), location.pointer);
    this.diagnostics.push({
      code,
      severity,
      message: `${documentName === undefined ? '' : `${documentName}: `}schema ${JSON.stringify(location.resource)} at ${pointer}: ${text}`,
      ...(documentName === undefined ? {} : { file: documentName }),
      path: pointer,
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
    if (viaRef !== undefined || !Array.isArray(node.allOf)) return viaRef;
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

  private lowerRecord(node: Readonly<Record<string, unknown>>, location: SchemaLocation, sameValue: SameValueEdge[]): IrSchema {
    const here: SchemaLocation = { ...location, base: baseInside(node, location.base) };
    for (const keyword of Object.keys(node)) {
      if (UNSUPPORTED_KEYWORDS.has(keyword)) this.report(VALIDATE_UNSUPPORTED_KEYWORD, GolemDiagnosticSeverity.Error, here, keyword, `the keyword ${keyword} is not supported`);
    }
    const child = (keyword: string, value: unknown, ...more: readonly (string | number)[]): SchemaLocation => ({
      ...here,
      node: value,
      pointer: more.reduce<string>((path, token) => path + pointerSegment(token), here.pointer + pointerSegment(keyword)),
    });
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
    const checks: IrCheck[] = [];

    const typeList = typeof node.type === 'string' ? [node.type] : Array.isArray(node.type) ? node.type as readonly unknown[] : [];
    const names = typeList.filter(isTypeName);
    if (names.length > 0) checks.push({ kind: 'type', names });

    if (node[MODEL_DATE_KEYWORD] === true) checks.push({ kind: 'date' });
    const instance = modelInstance(node[MODEL_INSTANCE_KEYWORD]);
    if (instance !== undefined) checks.push(instance);

    if (Object.hasOwn(node, 'const')) checks.push({ kind: 'literal', values: [node.const] });
    if (Array.isArray(node.enum)) checks.push({ kind: 'literal', values: node.enum as readonly unknown[] });

    if (typeof node.$ref === 'string') {
      const target = this.resolver.resolve(node.$ref, here.base);
      if (target) {
        const to = this.functionFor(target);
        sameValue.push({ to, location: here, keyword: '$ref' });
        checks.push({ kind: 'call', fn: to });
      }
      else this.report(VALIDATE_UNRESOLVED_REF, GolemDiagnosticSeverity.Error, here, '$ref', `the reference ${JSON.stringify(node.$ref)} does not resolve to a schema`);
    }

    const minLength = finiteNumber(node.minLength);
    const maxLength = finiteNumber(node.maxLength);
    let pattern: string | undefined;
    if (typeof node.pattern === 'string') {
      const problem = patternError(node.pattern);
      if (problem === undefined) pattern = node.pattern;
      else this.report(VALIDATE_INVALID_PATTERN, GolemDiagnosticSeverity.Error, here, 'pattern', `the pattern ${JSON.stringify(node.pattern)} is not a valid regular expression: ${problem}`);
    }
    if (minLength !== undefined || maxLength !== undefined || pattern !== undefined) checks.push({ kind: 'string', minLength, maxLength, pattern });

    const divisor = finiteNumber(node.multipleOf);
    const limits = {
      minimum: finiteNumber(node.minimum),
      exclusiveMinimum: finiteNumber(node.exclusiveMinimum),
      maximum: finiteNumber(node.maximum),
      exclusiveMaximum: finiteNumber(node.exclusiveMaximum),
      multipleOf: divisor !== undefined && divisor > 0 ? divisor : undefined,
    };
    if (Object.values(limits).some(limit => limit !== undefined)) checks.push({ kind: 'number', ...limits });

    if (typeof node.format === 'string') {
      if (isKnownFormat(node.format)) {
        checks.push({ kind: 'format', format: node.format });
      } else {
        const severity = this.options.unknownFormats === 'error' ? GolemDiagnosticSeverity.Error : GolemDiagnosticSeverity.Warning;
        this.report(VALIDATE_UNKNOWN_FORMAT, severity, here, 'format', `the format ${JSON.stringify(node.format)} is not implemented${severity === GolemDiagnosticSeverity.Warning ? ' and is not checked' : ''}`);
      }
    }

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
    if (prefixItems.some(item => item.kind !== 'always') || (items !== undefined && items.kind !== 'always') || closed || contains !== undefined || marksItems || minItems !== undefined || maxItems !== undefined || uniqueItems) {
      checks.push({ kind: 'array', prefixItems, items, closed, contains, minItems, maxItems, uniqueItems });
    }

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

    if (Array.isArray(node.allOf)) {
      const branches = (node.allOf as readonly unknown[])
        .map((branch, position) => {
          // A branch with its own `unevaluated*` keyword is its own function: it must not see what its siblings evaluated.
          if (holdsEvaluationKeyword(branch) || this.isInlining(branch)) return callTo(sameValueFunction('allOf', branch, position));
          return this.lowerSchema(child('allOf', branch, position), sameValue);
        })
        .filter(branch => branch.kind !== 'always');
      if (branches.length > 0) checks.push({ kind: 'allOf', branches });
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const list = node[keyword];
      if (Array.isArray(list) && list.length > 0) {
        const branches = (list as readonly unknown[]).map((branch, position) => sameValueFunction(keyword, branch, position));
        const discriminator = keyword === 'oneOf' ? this.discriminatorOf(node, (list as readonly unknown[]).map((branch, position) => child(keyword, branch, position))) : undefined;
        checks.push({ kind: 'union', exactlyOne: keyword === 'oneOf', branches, discriminator });
      }
    }
    if (node.not !== undefined) checks.push({ kind: 'not', fn: sameValueFunction('not', node.not) });

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

    // `{ schema, bindings }`, or the bindings alone: the functions run once the structural schema has passed, and the schema marks what it evaluates.
    const validation = node[VALIDATION_KEYWORD];
    if (Array.isArray(validation)) {
      const calls = this.bindingCalls(validation, here);
      if (calls.length > 0) checks.push({ kind: 'validation', calls });
    } else if (isRecord(validation) && Array.isArray(validation.bindings)) {
      const calls = this.bindingCalls(validation.bindings, here, 'bindings');
      const fn = validation.schema === undefined || validation.schema === true ? undefined : sameValueFunction(VALIDATION_KEYWORD, validation.schema, 'schema');
      if (calls.length > 0 || fn !== undefined) checks.push({ kind: 'validation', fn, calls });
    }

    // These two read what every check above evaluated, so they come last.
    if (node.unevaluatedProperties !== undefined) checks.push({ kind: 'unevaluatedProperties', schema: lowerChild('unevaluatedProperties', node.unevaluatedProperties) });
    if (node.unevaluatedItems !== undefined) checks.push({ kind: 'unevaluatedItems', schema: lowerChild('unevaluatedItems', node.unevaluatedItems) });

    return checks.length === 0 ? ALWAYS : { kind: 'checks', checks };
  }
}
