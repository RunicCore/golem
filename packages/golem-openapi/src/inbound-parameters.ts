import { GolemDiagnosticSeverity, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { parameterStyleRule, type ParameterLocation, type ParameterStyleRule } from '@exprtlabs/golem/internal/generator-support';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { isRecord } from '@exprtlabs/golem/internal/generator-support';
import type { QueryFieldShape } from '@exprtlabs/golem/serde';
import { modelConversionDescriptor, modelEnv, type OpenApiModelAnalysis } from './model-resolution.js';
import { parameterSchema, type NormalizedOperation, type NormalizedParameter } from './normalize.js';

/** The text parameters of an operation, by place in the request. */
const LOCATIONS = ['path', 'query', 'header', 'cookie'] as const;

/** What the inbound reader reads of a parameter, from its descriptor: the shape that a decode uses, and the characters that a value can hold. */
interface Reading {
  readonly types: ReadonlySet<QueryScalar>;
  readonly literals: readonly (string | number | boolean)[];
  /** The characters a value can hold; undefined when it can hold any. */
  readonly characters: ReadonlySet<string> | undefined;
  readonly item?: Reading;
  readonly properties?: Readonly<Record<string, Reading>>;
}

type QueryScalar = QueryFieldShape['types'][number];

const NOTHING: Reading = { types: new Set(), literals: [], characters: new Set() };
/** A value of a kind that the table does not prove: it reads as text and can hold any character. */
const TEXT: Reading = { types: new Set<QueryScalar>(['string']), literals: [], characters: undefined };

/** The text of a literal or an enum value. */
const textOf = (value: unknown): string => String(value);

function union(left: Reading, right: Reading): Reading {
  return {
    types: new Set([...left.types, ...right.types]),
    literals: [...left.literals, ...right.literals],
    characters: left.characters === undefined || right.characters === undefined ? undefined : new Set([...left.characters, ...right.characters]),
    ...(left.item || right.item ? { item: left.item && right.item ? union(left.item, right.item) : (left.item ?? right.item)! } : {}),
    ...(left.properties || right.properties ? { properties: mergeProperties(left.properties ?? {}, right.properties ?? {}) } : {}),
  };
}

function mergeProperties(left: Readonly<Record<string, Reading>>, right: Readonly<Record<string, Reading>>): Record<string, Reading> {
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].map((name) => [name, left[name] && right[name] ? union(left[name]!, right[name]!) : (left[name] ?? right[name])!]));
}

/** An intersection holds what all its variants hold: the characters that every variant that proves some can hold. */
function intersection(variants: readonly Reading[]): Reading {
  const merged = variants.reduce(union);
  const proven = variants.map((variant) => variant.characters).filter((characters): characters is ReadonlySet<string> => characters !== undefined);
  return { ...merged, characters: proven.length === 0 ? undefined : new Set([...proven[0]!].filter((character) => proven.every((set) => set.has(character)))) };
}

/**
 * The reading of a descriptor by its kind, one closed table. A number holds digits, a sign, a dot and an exponent (no dot when it is an integer), a boolean
 * holds its two words, a literal holds its text, and a string with an enum holds the texts of the enum. Every other kind (a bare string, a date, an unknown
 * value, anything a descriptor does not carry) reads as text that can hold any character. An array and a tuple read their items, and an object its members.
 */
function read(descriptor: ModelTypeDescriptor, analysis: OpenApiModelAnalysis, depth = 0): Reading {
  if (depth > 12) return TEXT;
  const next = (child: ModelTypeDescriptor): Reading => read(child, analysis, depth + 1);
  switch (descriptor.kind) {
    case 'number': {
      const integer = descriptor.constraints?.some((constraint) => constraint.kind === 'integer') === true;
      return { types: new Set<QueryScalar>([integer ? 'integer' : 'number']), literals: [], characters: new Set(integer ? '0123456789-' : '0123456789-+.eE') };
    }
    case 'boolean': return { types: new Set<QueryScalar>(['boolean']), literals: [], characters: new Set('truefals') };
    case 'null': return { ...NOTHING, characters: new Set('null') };
    case 'literal': return { types: new Set(), literals: [descriptor.value], characters: new Set(textOf(descriptor.value)) };
    case 'string': {
      const values = descriptor.constraints?.find((constraint) => constraint.kind === 'enum');
      return values?.kind === 'enum' ? { ...TEXT, characters: new Set(values.values.flatMap((value) => [...textOf(value)])) } : TEXT;
    }
    case 'array': return { ...NOTHING, item: next(descriptor.item) };
    case 'tuple': return { ...NOTHING, item: [...descriptor.items, ...(descriptor.rest ? [descriptor.rest.item] : [])].map(next).reduce(union, NOTHING) };
    case 'object': return { ...NOTHING, properties: Object.fromEntries(Object.entries(descriptor.properties).map(([name, member]) => [name, next(member)])) };
    case 'union': return descriptor.variants.map(next).reduce(union, NOTHING);
    case 'intersection': return intersection(descriptor.variants.map(next));
    case 'generated-model': {
      const model = analysis.graphInputs.models.find((candidate) => candidate.name === descriptor.id);
      return model ? next(model.descriptor) : TEXT;
    }
    case 'reference': {
      const alias = analysis.definitions.aliases.get(descriptor.name)?.descriptor;
      return alias ? next(alias) : TEXT;
    }
    default: return TEXT;
  }
}

/** A text parameter with its style rule and what the reader reads of it. */
interface ParameterAnalysis {
  readonly parameter: NormalizedParameter;
  readonly rule: ParameterStyleRule;
  readonly reading: Reading;
}

const analyses = new WeakMap<object, WeakMap<NormalizedOperation, ReadonlyMap<ParameterLocation, readonly ParameterAnalysis[]>>>();

function textParameters(operation: NormalizedOperation, location: ParameterLocation): NormalizedParameter[] {
  return operation.parameters.filter((parameter) => parameter.in === location && parameter.content === undefined);
}

/** The analysis of the text parameters of an operation by place, made once for the operation of a document: the table and the check read the same one. */
function analyse(operation: NormalizedOperation, document: unknown, analysis: OpenApiModelAnalysis): ReadonlyMap<ParameterLocation, readonly ParameterAnalysis[]> {
  const ofDocument = analyses.get(document as object) ?? new WeakMap();
  analyses.set(document as object, ofDocument);
  let found = ofDocument.get(operation);
  if (found === undefined) {
    const env = modelEnv(document, undefined, undefined, analysis.resources, analysis.selections, analysis.dates);
    found = new Map(LOCATIONS.flatMap((location) => {
      const parameters = textParameters(operation, location);
      return parameters.length ? [[location, parameters.map((parameter): ParameterAnalysis => {
        // The loader refuses a style that the place does not have, so a parameter that reaches the generator has a rule.
        const rule = parameterStyleRule(location, parameter.style, parameter.explode)!;
        const schema = parameterSchema(parameter);
        return { parameter, rule, reading: isRecord(schema) ? read(modelConversionDescriptor(schema, analysis.definitions, env, 'to'), analysis) : TEXT };
      })] as const] : [];
    }));
    ofDocument.set(operation, found);
  }
  return found;
}

/** The decode shape of a reading, without what only the check uses. */
function shapeOf(reading: Reading): QueryFieldShape {
  const types = (['string', 'number', 'integer', 'boolean'] as const).filter((type) => reading.types.has(type));
  const literals = types.includes('string') ? [] : [...new Set(reading.literals)];
  return {
    types,
    ...(literals.length > 0 ? { literals } : {}),
    ...(reading.item ? { item: shapeOf(reading.item) } : {}),
  };
}

/** The inbound table of the text parameters of an operation: for each place, the shape of each parameter that is read from text, with the style it is written in. */
export function inboundTextTable(operation: NormalizedOperation, document: unknown, analysis: OpenApiModelAnalysis): Record<string, unknown> {
  return Object.fromEntries([...analyse(operation, document, analysis)].flatMap(([location, parameters]) => {
    const entries = parameters.flatMap(({ parameter, rule, reading }) => {
      const base = shapeOf(reading);
      const decodes = (base.types.length > 0 && !base.types.includes('string')) || base.literals !== undefined;
      if (!(reading.properties || base.item !== undefined || rule.prefix !== undefined || decodes)) return [];
      const style = { ...(parameter.style === undefined ? {} : { style: parameter.style }), ...(parameter.explode === undefined ? {} : { explode: parameter.explode }) };
      const properties = reading.properties ? { properties: Object.fromEntries(Object.entries(reading.properties).map(([name, member]) => [name, shapeOf(member)])) } : {};
      return [[parameter.name, { ...base, ...properties, parameter: style }] as const];
    });
    return entries.length ? [[location, Object.fromEntries(entries)] as const] : [];
  }));
}

/** Whether a value of the reading can hold one of `characters`. */
function mayHold(reading: Reading, characters: readonly string[]): boolean {
  return reading.characters === undefined || characters.some((character) => reading.characters!.has(character));
}

/** Why the array parameter cannot be read back, or undefined when it can. */
function arrayAmbiguity(item: Reading, location: ParameterLocation, rule: ParameterStyleRule): string | undefined {
  if (rule.array.layout === 'joined') return mayHold(item, [rule.array.separator]) ? `an item can hold "${rule.array.separator}"` : undefined;
  // A repeated name is read as the first value only.
  if (location === 'cookie') return 'a cookie parser keeps only the first value of a name that repeats';
  return rule.prefix === 'matrix' && mayHold(item, [';']) ? 'an item can hold ";"' : undefined;
}

/** Why the object parameter cannot be read back, or undefined when it can. */
function objectAmbiguity(parameter: NormalizedParameter, rule: ParameterStyleRule, properties: Readonly<Record<string, Reading>>, siblings: readonly NormalizedParameter[]): string | undefined {
  const entries = Object.entries(properties);
  if (entries.length === 0) return 'the properties of its object are not listed';
  const layout = rule.object;
  if (layout.layout === 'deep') {
    return entries.some(([, member]) => member.properties !== undefined || member.item !== undefined) ? 'a property is an object or an array, so its key name[a][b] has no single reading' : undefined;
  }
  if (layout.layout === 'keys') {
    const clash = entries.find(([name]) => siblings.some((other) => other !== parameter && other.name === name));
    return clash === undefined ? undefined : `its property "${clash[0]}" is also the name of another ${parameter.in} parameter`;
  }
  // The text splits at the separator, and a keyed pair splits at its first "=": only a name can hold that.
  const clash = entries.find(([name, member]) => name.includes(layout.separator) || (layout.layout === 'keyed' && name.includes('=')) || mayHold(member, [layout.separator]));
  return clash === undefined ? undefined : `a property "${clash[0]}" can hold "${layout.separator}"${layout.layout === 'keyed' ? ' or "="' : ''}`;
}

/**
 * One error for each path, query or cookie parameter of an inbound operation whose text cannot be read back to the value the client writes: the handler gets the text
 * the framework has already decoded, read by the descriptor kinds of the parameter. An item or a member that can hold the separator of its style splits wrong. The error names the fix.
 */
export function inboundParameterDiagnostics(operations: readonly NormalizedOperation[], document: unknown, analysis: OpenApiModelAnalysis): GolemDiagnostic[] {
  // A header list splits on commas whatever its items hold: the standard defines no escaping for it, so a header is not refused.
  return operations.flatMap((operation) => [...analyse(operation, document, analysis)].filter(([location]) => location !== 'header').flatMap(([location, parameters]) =>
    parameters.flatMap(({ parameter, rule, reading }): GolemDiagnostic[] => {
      const reason = reading.item !== undefined ? arrayAmbiguity(reading.item, location, rule)
        : reading.properties !== undefined ? objectAmbiguity(parameter, rule, reading.properties, parameters.map((other) => other.parameter)) : undefined;
      return reason === undefined ? [] : [{
        code: 'OPENAPI_INBOUND_PARAMETER_AMBIGUOUS',
        severity: GolemDiagnosticSeverity.Error,
        message: `The ${location} parameter "${parameter.name}" of the inbound operation ${operation.name} cannot be read back from its text: ${reason}. Set explode, use repeated keys or style deepObject, or give it an item type that cannot hold the separator.`,
      }];
    })));
}
