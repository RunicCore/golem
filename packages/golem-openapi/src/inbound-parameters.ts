import { GolemDiagnosticSeverity, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { isRecord, parameterStyleRule, queryFieldShapes, queryFieldTable, type ParameterLocation, type ParameterStyleRule } from '@exprtlabs/golem/internal/generator-support';
import { asRecord } from './json.js';
import { parameterSchema, resolveLocal, type NormalizedOperation, type NormalizedParameter } from './normalize.js';

/** What an inbound handler needs to read the text parameters of an operation: one table for each location, by parameter name. */
const LOCATIONS = ['path', 'query', 'header', 'cookie'] as const;

type Shapes = ReturnType<typeof queryFieldShapes>;

function textParameters(operation: NormalizedOperation, location: ParameterLocation): NormalizedParameter[] {
  return operation.parameters.filter((parameter) => parameter.in === location && parameter.content === undefined);
}

/** The schema of each parameter of a location as one object schema, so the walk that decodes a query model reads the parameters. */
function groupSchema(parameters: readonly NormalizedParameter[], document: unknown): Record<string, unknown> {
  return { type: 'object', properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameterSchema(parameter) ?? true])), components: asRecord(document).components };
}

/** The properties of an object schema with their schemas: its own, and those of its `allOf`, `oneOf` and `anyOf` members. */
function propertySchemas(schema: unknown, document: unknown, depth = 0): Map<string, unknown> {
  const found = new Map<string, unknown>();
  const resolved = resolveLocal(document, schema);
  if (!isRecord(resolved) || depth > 8) return found;
  if (isRecord(resolved.properties)) for (const [name, property] of Object.entries(resolved.properties)) found.set(name, property);
  for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
    const members = resolved[keyword];
    if (Array.isArray(members)) for (const member of members) for (const [name, property] of propertySchemas(member, document, depth + 1)) found.set(name, property);
  }
  return found;
}

/** The inbound table of the text parameters of an operation: for each location, the shape of each parameter that is read from text and the style it is written in. */
export function inboundTextTable(operation: NormalizedOperation, document: unknown): Record<string, unknown> {
  return Object.fromEntries(LOCATIONS.flatMap((location) => {
    const parameters = textParameters(operation, location);
    if (!parameters.length) return [];
    const group = groupSchema(parameters, document);
    const shapes = queryFieldShapes(group, () => undefined);
    const decoded = queryFieldTable(group, () => undefined) ?? {};
    const entries = parameters.flatMap((parameter) => {
      const rule = parameterStyleRule(location, parameter.style, parameter.explode);
      const schema = resolveLocal(document, parameterSchema(parameter));
      const properties = rule && isRecord(schema) ? objectProperties(schema, document) : undefined;
      const base = shapes[parameter.name] ?? { types: [] };
      const needed = properties !== undefined || base.item !== undefined || rule?.prefix !== undefined || decoded[parameter.name] !== undefined;
      if (!rule || !needed) return [];
      const style = { location, ...(parameter.style === undefined ? {} : { style: parameter.style }), ...(parameter.explode === undefined ? {} : { explode: parameter.explode }), name: parameter.name };
      return [[parameter.name, { ...base, ...(properties ? { properties } : {}), parameter: style }] as const];
    });
    return entries.length ? [[location, Object.fromEntries(entries)] as const] : [];
  }));
}

/** The shape of each property of an object parameter, also the properties that stay text; undefined when the schema is no object with listed properties. */
function objectProperties(schema: Record<string, unknown>, document: unknown): Shapes | undefined {
  const shapes = queryFieldShapes({ ...schema, components: asRecord(document).components }, () => undefined);
  return Object.keys(shapes).length > 0 ? shapes : undefined;
}

/** The characters that each format writes; a value of the format cannot hold any other. */
const FORMAT_CHARACTERS: Readonly<Record<string, string>> = {
  uuid: '0123456789abcdefABCDEF-',
  date: '0123456789-',
  'date-time': '0123456789-:TtZz.+',
  time: '0123456789:.Zz+-',
  ipv4: '0123456789.',
  byte: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',
};

/** Whether a value of `schema` can hold one of `characters` once it is decoded; false only when its type, its values or its format rule them out. */
function mayHold(schema: unknown, characters: readonly string[], document: unknown): boolean {
  const resolved = resolveLocal(document, schema);
  if (!isRecord(resolved)) return true;
  const { type, format } = resolved;
  if (type === 'integer' || type === 'boolean') return false;
  if (type === 'number') return characters.includes('.');
  const values = Array.isArray(resolved.enum) ? resolved.enum : 'const' in resolved ? [resolved.const] : undefined;
  if (values !== undefined) return values.some((value) => characters.some((character) => String(value).includes(character)));
  if (type === 'string' && typeof format === 'string' && Object.hasOwn(FORMAT_CHARACTERS, format)) return characters.some((character) => FORMAT_CHARACTERS[format]!.includes(character));
  return true;
}

/** Why the text of the parameter cannot be read back to the value that was written, or undefined when it can. */
function ambiguity(parameter: NormalizedParameter, rule: ParameterStyleRule, schema: Record<string, unknown>, siblings: readonly NormalizedParameter[], document: unknown): string | undefined {
  const properties = propertySchemas(schema, document);
  if (schema.type === 'array' || (schema.items !== undefined && properties.size === 0)) {
    if (rule.array.layout !== 'joined') return undefined;
    const separator = rule.array.separator;
    return mayHold(schema.items, [separator], document) ? `an item can hold "${separator}"` : undefined;
  }
  if (!(schema.type === 'object' || properties.size > 0)) return undefined;
  const layout = rule.object;
  if (layout.layout === 'deep') {
    if (properties.size === 0) return 'the properties of its object are not listed';
    return [...properties.values()].some((property) => { const resolved = resolveLocal(document, property); return !isRecord(resolved) || resolved.type === 'object' || resolved.type === 'array' || resolved.properties !== undefined; })
      ? 'a property is an object or an array, so its key name[a][b] has no single reading' : undefined;
  }
  if (properties.size === 0) return 'the properties of its object are not listed';
  if (layout.layout === 'keys') {
    const clash = [...properties.keys()].find((name) => siblings.some((other) => other !== parameter && other.name === name));
    return clash === undefined ? undefined : `its property "${clash}" is also the name of another ${parameter.in} parameter`;
  }
  const characters = layout.layout === 'keyed' ? [layout.separator, '='] : [layout.separator];
  const clash = [...properties].find(([name, property]) => characters.some((character) => name.includes(character)) || mayHold(property, characters, document));
  return clash === undefined ? undefined : `a property "${clash[0]}" can hold "${characters.join('" or "')}"`;
}

/**
 * One error for each path, query or cookie parameter of an inbound operation whose text cannot be read back to the value the client writes: the handler gets the text the framework
 * has already decoded, so an item or a member that can hold the separator of its style splits wrong. The error names the fix.
 */
export function inboundParameterDiagnostics(operations: readonly NormalizedOperation[], document: unknown): GolemDiagnostic[] {
  // A header list splits on commas whatever its items hold: the standard defines no escaping for it, so a header is not refused.
  return operations.flatMap((operation) => LOCATIONS.filter((location) => location !== 'header').flatMap((location) => {
    const parameters = textParameters(operation, location);
    return parameters.flatMap((parameter): GolemDiagnostic[] => {
      const rule = parameterStyleRule(location, parameter.style, parameter.explode);
      const schema = resolveLocal(document, parameterSchema(parameter));
      const reason = rule && isRecord(schema) ? ambiguity(parameter, rule, schema, parameters, document) : undefined;
      return reason === undefined ? [] : [{
        code: 'OPENAPI_INBOUND_PARAMETER_AMBIGUOUS',
        severity: GolemDiagnosticSeverity.Error,
        message: `The ${location} parameter "${parameter.name}" of the inbound operation ${operation.name} cannot be read back from its text: ${reason}. Set explode, use repeated keys or style deepObject, or give it an item type that cannot hold the separator.`,
      }];
    });
  }));
}
