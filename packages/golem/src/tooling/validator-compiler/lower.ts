import { isKnownFormat } from '../../validation-runtime.js';
import { GolemDiagnosticSeverity, type GolemDiagnostic } from '../generator-api.js';
import type { CompileInput, CompileOptions } from './index.js';
import type { IrAdditional, IrCheck, IrContains, IrDiscriminator, IrFunction, IrModule, IrSchema, IrTypeName } from './ir.js';
import { baseInside, isRecord, pointerSegment, SchemaResolver, type SchemaLocation } from './resolve.js';

export const VALIDATE_UNSUPPORTED_KEYWORD = 'VALIDATE_UNSUPPORTED_KEYWORD';
export const VALIDATE_UNRESOLVED_REF = 'VALIDATE_UNRESOLVED_REF';
export const VALIDATE_INVALID_PATTERN = 'VALIDATE_INVALID_PATTERN';
export const VALIDATE_UNKNOWN_FORMAT = 'VALIDATE_UNKNOWN_FORMAT';
export const VALIDATE_REF_CYCLE = 'VALIDATE_REF_CYCLE';

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

/** True when `value`, or anything inside it, has one of `keys` as a key. */
function hasKey(value: unknown, keys: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some(item => hasKey(item, keys));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => keys.includes(key) || hasKey(item, keys));
}

/** True when the schema node itself holds `unevaluatedProperties` or `unevaluatedItems`. */
function holdsEvaluationKeyword(node: unknown): boolean {
  return isRecord(node) && EVALUATION_KEYWORDS.some(keyword => Object.hasOwn(node, keyword));
}

/**
 * The tag values of a `oneOf` branch for `property`: its `const`, or the values of its `enum`. Undefined when the
 * branch does not state them.
 */
function branchTags(branch: unknown, property: string): readonly unknown[] | undefined {
  if (!isRecord(branch) || !isRecord(branch.properties) || !Object.hasOwn(branch.properties, property)) return undefined;
  const tag = branch.properties[property];
  if (!isRecord(tag)) return undefined;
  if (Object.hasOwn(tag, 'const')) return [tag.const];
  return Array.isArray(tag.enum) && tag.enum.length > 0 ? tag.enum as readonly unknown[] : undefined;
}

/** The discriminator of a `oneOf` list, when every branch states its tag values and no value repeats; otherwise it is an annotation. */
function discriminatorOf(node: Readonly<Record<string, unknown>>, branches: readonly unknown[]): IrDiscriminator | undefined {
  const { discriminator } = node;
  if (!isRecord(discriminator) || typeof discriminator.propertyName !== 'string') return undefined;
  const property = discriminator.propertyName;
  const tags = branches.map(branch => branchTags(branch, property));
  if (!tags.every((list): list is readonly unknown[] => list !== undefined)) return undefined;
  const seen = new Set(tags.flat().map(tag => JSON.stringify(tag)));
  return seen.size === tags.flat().length ? { property, tags } : undefined;
}

function isTypeName(value: unknown): value is IrTypeName {
  return TYPE_NAMES.some(name => name === value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
    return { module: { functions: this.functions, exports }, diagnostics: this.diagnostics };
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

  private lowerSchema(location: SchemaLocation, sameValue: SameValueEdge[]): IrSchema {
    const { node } = location;
    if (node === true) return ALWAYS;
    if (node === false) return NEVER;
    if (!isRecord(node)) return ALWAYS;
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
      return holdsEvaluationKeyword(location.node) ? callTo(this.functionFor(location)) : this.lowerSchema(location, []);
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
          if (holdsEvaluationKeyword(branch)) return callTo(sameValueFunction('allOf', branch, position));
          return this.lowerSchema(child('allOf', branch, position), sameValue);
        })
        .filter(branch => branch.kind !== 'always');
      if (branches.length > 0) checks.push({ kind: 'allOf', branches });
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const list = node[keyword];
      if (Array.isArray(list) && list.length > 0) {
        const branches = (list as readonly unknown[]).map((branch, position) => sameValueFunction(keyword, branch, position));
        const discriminator = keyword === 'oneOf' ? discriminatorOf(node, list as readonly unknown[]) : undefined;
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

    // These two read what every check above evaluated, so they come last.
    if (node.unevaluatedProperties !== undefined) checks.push({ kind: 'unevaluatedProperties', schema: lowerChild('unevaluatedProperties', node.unevaluatedProperties) });
    if (node.unevaluatedItems !== undefined) checks.push({ kind: 'unevaluatedItems', schema: lowerChild('unevaluatedItems', node.unevaluatedItems) });

    return checks.length === 0 ? ALWAYS : { kind: 'checks', checks };
  }
}
