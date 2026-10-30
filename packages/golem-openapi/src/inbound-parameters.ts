import { GolemDiagnosticSeverity, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import { isRecord, parameterStyleRule, queryFieldShapes, type FieldReading, type ParameterLocation, type ParameterStyleRule } from '@exprtlabs/golem/internal/generator-support';
import { asRecord } from './json.js';
import { parameterSchema, type NormalizedOperation, type NormalizedParameter } from './normalize.js';

/** The text parameters of an operation, by place in the request. */
const LOCATIONS = ['path', 'query', 'header', 'cookie'] as const;

type Readings = Readonly<Record<string, FieldReading>>;

function textParameters(operation: NormalizedOperation, location: ParameterLocation): NormalizedParameter[] {
  return operation.parameters.filter((parameter) => parameter.in === location && parameter.content === undefined);
}

/** The reading of each parameter of a place, as the inbound reader reads it: the one walk of the schema that a decode of a query model makes. */
function readParameters(parameters: readonly NormalizedParameter[], document: unknown): Readings {
  const group = { type: 'object', properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameterSchema(parameter) ?? true])), components: asRecord(document).components };
  return queryFieldShapes(group, () => undefined);
}

/** The reading of each property of an object parameter, also the properties that stay text. */
function readProperties(parameter: NormalizedParameter, document: unknown): Readings {
  const schema = parameterSchema(parameter);
  return isRecord(schema) ? queryFieldShapes({ ...schema, components: asRecord(document).components }, () => undefined) : {};
}

/** Whether the parameter is an object: its schema admits one, or lists properties. */
function objectReading(reading: FieldReading | undefined, properties: Readings): boolean {
  return reading?.object === true || Object.keys(properties).length > 0;
}

/** The inbound table of the text parameters of an operation: for each place, the shape of each parameter that is read from text, with the style it is written in. */
export function inboundTextTable(operation: NormalizedOperation, document: unknown): Record<string, unknown> {
  return Object.fromEntries(LOCATIONS.flatMap((location) => {
    const parameters = textParameters(operation, location);
    if (!parameters.length) return [];
    const readings = readParameters(parameters, document);
    const entries = parameters.flatMap((parameter) => {
      const rule = parameterStyleRule(location, parameter.style, parameter.explode);
      const reading = readings[parameter.name];
      const properties = rule ? readProperties(parameter, document) : {};
      const object = objectReading(reading, properties);
      const base = reading?.shape ?? { types: [] };
      const decodes = (base.types.length > 0 && !base.types.includes('string')) || base.literals !== undefined;
      if (!rule || !(object || base.item !== undefined || rule.prefix !== undefined || decodes)) return [];
      const style = { ...(parameter.style === undefined ? {} : { style: parameter.style }), ...(parameter.explode === undefined ? {} : { explode: parameter.explode }) };
      return [[parameter.name, { ...base, ...(object ? { properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, property.shape])) } : {}), parameter: style }] as const];
    });
    return entries.length ? [[location, Object.fromEntries(entries)] as const] : [];
  }));
}

/** Whether a value of the reading can hold one of `characters`. */
function mayHold(reading: FieldReading, characters: readonly string[]): boolean {
  return reading.characters === undefined || characters.some((character) => reading.characters!.has(character));
}

/** Why the array parameter cannot be read back, or undefined when it can. */
function arrayAmbiguity(item: FieldReading, location: ParameterLocation, rule: ParameterStyleRule): string | undefined {
  if (rule.array.layout === 'joined') return mayHold(item, [rule.array.separator]) ? `an item can hold "${rule.array.separator}"` : undefined;
  // A repeated name is read as the first value only.
  if (location === 'cookie') return 'a cookie parser keeps only the first value of a name that repeats';
  return rule.prefix === 'matrix' && mayHold(item, [';']) ? 'an item can hold ";"' : undefined;
}

/** Why the object parameter cannot be read back, or undefined when it can. */
function objectAmbiguity(parameter: NormalizedParameter, rule: ParameterStyleRule, properties: Readings, siblings: readonly NormalizedParameter[]): string | undefined {
  const entries = Object.entries(properties);
  if (entries.length === 0) return 'the properties of its object are not listed';
  const layout = rule.object;
  if (layout.layout === 'deep') {
    return entries.some(([, property]) => property.object || property.item !== undefined) ? 'a property is an object or an array, so its key name[a][b] has no single reading' : undefined;
  }
  if (layout.layout === 'keys') {
    const clash = entries.find(([name]) => siblings.some((other) => other !== parameter && other.name === name));
    return clash === undefined ? undefined : `its property "${clash[0]}" is also the name of another ${parameter.in} parameter`;
  }
  // The text splits at the separator, and a keyed pair splits at its first "=": only a name can hold that.
  const clash = entries.find(([name, property]) => name.includes(layout.separator) || (layout.layout === 'keyed' && name.includes('=')) || mayHold(property, [layout.separator]));
  return clash === undefined ? undefined : `a property "${clash[0]}" can hold "${layout.separator}"${layout.layout === 'keyed' ? ' or "="' : ''}`;
}

/**
 * One error for each path, query or cookie parameter of an inbound operation whose text cannot be read back to the value the client writes: the handler gets the text
 * the framework has already decoded, read from the same shapes as the table. An item or a member that can hold the separator of its style splits wrong. The error names the fix.
 */
export function inboundParameterDiagnostics(operations: readonly NormalizedOperation[], document: unknown): GolemDiagnostic[] {
  // A header list splits on commas whatever its items hold: the standard defines no escaping for it, so a header is not refused.
  return operations.flatMap((operation) => LOCATIONS.filter((location) => location !== 'header').flatMap((location) => {
    const parameters = textParameters(operation, location);
    const readings = parameters.length ? readParameters(parameters, document) : {};
    return parameters.flatMap((parameter): GolemDiagnostic[] => {
      const rule = parameterStyleRule(location, parameter.style, parameter.explode);
      const reading = readings[parameter.name];
      const properties = rule ? readProperties(parameter, document) : {};
      const reason = !rule || !reading ? undefined
        : reading.item !== undefined ? arrayAmbiguity(reading.item, location, rule)
          : objectReading(reading, properties) ? objectAmbiguity(parameter, rule, properties, parameters) : undefined;
      return reason === undefined ? [] : [{
        code: 'OPENAPI_INBOUND_PARAMETER_AMBIGUOUS',
        severity: GolemDiagnosticSeverity.Error,
        message: `The ${location} parameter "${parameter.name}" of the inbound operation ${operation.name} cannot be read back from its text: ${reason}. Set explode, use repeated keys or style deepObject, or give it an item type that cannot hold the separator.`,
      }];
    });
  }));
}
