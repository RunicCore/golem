import { isKnownFormat } from '../../validation-runtime.js';
import { GolemDiagnosticSeverity, type GolemDiagnostic } from '../generator-api.js';
import type { CompileInput, CompileOptions } from './index.js';
import type { IrAdditional, IrCheck, IrFunction, IrModule, IrSchema, IrTypeName } from './ir.js';
import { baseInside, isRecord, pointerSegment, SchemaResolver, type SchemaLocation } from './resolve.js';

export const VALIDATE_UNSUPPORTED_KEYWORD = 'VALIDATE_UNSUPPORTED_KEYWORD';
export const VALIDATE_UNRESOLVED_REF = 'VALIDATE_UNRESOLVED_REF';
export const VALIDATE_INVALID_PATTERN = 'VALIDATE_INVALID_PATTERN';
export const VALIDATE_UNKNOWN_FORMAT = 'VALIDATE_UNKNOWN_FORMAT';
export const VALIDATE_REF_CYCLE = 'VALIDATE_REF_CYCLE';

/**
 * Validation keywords of JSON Schema 2020-12 that the compiler reports instead of ignoring, because
 * ignoring one would accept data the schema rejects. `$dynamicRef` and `$dynamicAnchor` stay here; the
 * rest are removed as `lowerSchema` learns them.
 */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$dynamicRef',
  '$dynamicAnchor',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  'propertyNames',
  'contains',
  'minContains',
  'maxContains',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

const TYPE_NAMES: readonly IrTypeName[] = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'];

/** A step that hands the same value to another function, so no part of the value is consumed. */
interface SameValueEdge {
  readonly to: number;
  readonly location: SchemaLocation;
  readonly keyword: string;
}

const ALWAYS: IrSchema = { kind: 'always' };
const NEVER: IrSchema = { kind: 'never' };

type MutableFunction = { -readonly [Key in keyof IrFunction]: IrFunction[Key] };

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

  public constructor(
    private readonly input: CompileInput,
    private readonly options: Pick<CompileOptions, 'unknownFormats' | 'documentName'>,
  ) {
    this.resolver = new SchemaResolver(input.roots, input.resources ?? new Map());
  }

  public run(): LoweringResult {
    const exports = [...this.input.roots.keys()].map(name => ({ name, fn: this.functionFor(this.resolver.rootLocation(name)) }));
    // Lowering a function can add more; the list grows while it is walked.
    for (let next = 0; next < this.pending.length; next++) {
      const { id, location } = this.pending[next];
      const edges: SameValueEdge[] = [];
      this.functions[id].body = this.lowerSchema(location, edges);
      this.sameValueEdges[id] = edges;
    }
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
    this.functions.push({ id, body: ALWAYS });
    if (shared) this.functionIds.set(node, id);
    this.pending.push({ id, location });
    return id;
  }

  private report(code: string, severity: GolemDiagnosticSeverity, location: SchemaLocation, keyword: string, text: string): void {
    const { documentName } = this.options;
    const pointer = location.pointer + pointerSegment(keyword);
    this.diagnostics.push({
      code,
      severity,
      message: `${documentName === undefined ? '' : `${documentName}: `}schema ${JSON.stringify(location.resource)} at ${pointer}: ${text}`,
      ...(documentName === undefined ? {} : { file: documentName }),
      path: pointer,
    });
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
    // A child that reads part of the value (a property, an item) starts a new chain of same-value steps.
    const lowerChild = (keyword: string, value: unknown, ...more: readonly (string | number)[]): IrSchema => this.lowerSchema(child(keyword, value, ...more), []);
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
    if (prefixItems.some(item => item.kind !== 'always') || (items !== undefined && items.kind !== 'always') || closed || minItems !== undefined || maxItems !== undefined || uniqueItems) {
      checks.push({ kind: 'array', prefixItems, items, closed, minItems, maxItems, uniqueItems });
    }

    const required = Array.isArray(node.required) ? (node.required as readonly unknown[]).filter((key): key is string => typeof key === 'string') : [];
    const properties = isRecord(node.properties)
      ? Object.entries(node.properties).map(([key, schema]) => ({ key, schema: lowerChild('properties', schema, key) }))
      : [];
    let additional: IrAdditional | undefined;
    if (node.additionalProperties === false) {
      additional = { kind: 'forbid' };
    } else if (node.additionalProperties !== undefined) {
      const schema = lowerChild('additionalProperties', node.additionalProperties);
      if (schema.kind !== 'always') additional = { kind: 'schema', schema };
    }
    const minProperties = finiteNumber(node.minProperties);
    const maxProperties = finiteNumber(node.maxProperties);
    if (required.length > 0 || properties.some(property => property.schema.kind !== 'always') || additional !== undefined || minProperties !== undefined || maxProperties !== undefined) {
      checks.push({ kind: 'object', required, properties, additional, minProperties, maxProperties });
    }

    if (Array.isArray(node.allOf)) {
      const branches = (node.allOf as readonly unknown[])
        .map((branch, position) => this.lowerSchema(child('allOf', branch, position), sameValue))
        .filter(branch => branch.kind !== 'always');
      if (branches.length > 0) checks.push({ kind: 'allOf', branches });
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const list = node[keyword];
      if (Array.isArray(list) && list.length > 0) {
        const branches = (list as readonly unknown[]).map((branch, position) => sameValueFunction(keyword, branch, position));
        checks.push({ kind: 'union', exactlyOne: keyword === 'oneOf', branches });
      }
    }
    if (node.not !== undefined) checks.push({ kind: 'not', fn: sameValueFunction('not', node.not) });

    return checks.length === 0 ? ALWAYS : { kind: 'checks', checks };
  }
}
