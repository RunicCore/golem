import * as ts from '@exprtlabs/golem/internal/ts';
import {
  GolemDiagnosticSeverity,
  TsToOpenApiDiagnosticCode,
  diagnostic,
  type TsToOpenApiDiagnostic,
} from '../diagnostics.js';
import { evaluateStaticValue, isStaticArray, resolveValueSymbol, singleReturnExpression, unwrapExpression } from '../evaluation/static-value.js';
import { hasDecorator, isTypeScriptBuiltinConstructor, unwrapAsyncType } from './analysis-utils.js';
import {
  isAssertionFormat,
  isRecord,
  mergeSchemaMetadata,
  normalizeNullable,
  resolvedSchema,
  sameValue,
  schemaAllowsNull,
  schemaAnnotations,
  schemaReference,
  schemaValues,
  throwSchemaDiagnostic,
  type DtoSchema,
  type SchemaMergeOptions,
} from './json-schema-merge.js';
import { decoratorOptions, type DecoratorOptions, type MetadataReader } from './metadata.js';
import { NEST_SWAGGER, decoratorsOf } from './symbols.js';
import type { TypeReference } from './types.js';

interface DtoSchemaOptions extends SchemaMergeOptions {
  readonly isAuthoritativeType?: (type: ts.Type, node: ts.Node | undefined) => boolean;
  /** Receives non-fatal findings, such as a Swagger `type` this adapter does not model. */
  readonly onWarning?: (warning: TsToOpenApiDiagnostic) => void;
  /** Emit a component for a class named by `getSchemaPath()`/`refs()` in property metadata. */
  readonly registerSchemaComponent?: (name: string, reference: TypeReference) => void;
  /** Emit `components.schemas.<name>` for an `@ApiProperty({ enum, enumName })` enum. */
  readonly registerEnumComponent?: (name: string, schema: Record<string, unknown>, node: ts.Node) => void;
}

type SwaggerPrimitive = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

const SWAGGER_PRIMITIVES: ReadonlySet<string> = new Set<SwaggerPrimitive>(['string', 'number', 'integer', 'boolean', 'object', 'array']);

const PRIMITIVE_CONSTRUCTORS: Readonly<Record<string, SwaggerPrimitive>> = {
  String: 'string', Number: 'number', Boolean: 'boolean', Object: 'object', Array: 'array',
};

/** An explicit Swagger `type` option, classified by what it may assert about the TypeScript type. */
type SwaggerTypeSpec = { readonly isArray: boolean } & (
  | { readonly kind: 'primitive'; readonly primitive: SwaggerPrimitive }
  | { readonly kind: 'date' }
  | { readonly kind: 'enum'; readonly type: ts.Type }
  | { readonly kind: 'class'; readonly type: ts.Type }
  | { readonly kind: 'any' }
  /** A type name string this adapter does not model, such as `'file'`; reported as a warning. */
  | { readonly kind: 'unrecognized'; readonly text: string }
  /** An expression that names no Swagger type (for example a local function called `String`). */
  | { readonly kind: 'invalid' }
);

function swaggerTypeSpec(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): SwaggerTypeSpec {
  const value = unwrapExpression(expression);
  const invalid: SwaggerTypeSpec = { kind: 'invalid', isArray: false };
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    const returned = singleReturnExpression(value);
    return returned ? swaggerTypeSpec(checker, returned) : invalid;
  }
  if (ts.isArrayLiteralExpression(value)) {
    const [element] = value.elements;
    if (value.elements.length !== 1 || !element) return invalid;
    return { ...swaggerTypeSpec(checker, element), isArray: true };
  }
  if (ts.isIdentifier(value)) {
    const primitive = PRIMITIVE_CONSTRUCTORS[value.text];
    if (primitive && isTypeScriptBuiltinConstructor(checker, value, value.text)) return { kind: 'primitive', primitive, isArray: false };
    if (value.text === 'Date' && isTypeScriptBuiltinConstructor(checker, value, 'Date')) return { kind: 'date', isArray: false };
  }
  if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const symbol = resolveValueSymbol(checker, value);
    if (symbol && (symbol.flags & ts.SymbolFlags.Class) !== 0) {
      return { kind: 'class', type: checker.getDeclaredTypeOfSymbol(symbol), isArray: false };
    }
    if (symbol && (symbol.flags & ts.SymbolFlags.Enum) !== 0) {
      return { kind: 'enum', type: checker.getDeclaredTypeOfSymbol(symbol), isArray: false };
    }
  }
  const result = evaluateStaticValue(checker, value);
  return result.ok && typeof result.value === 'string' ? namedTypeSpec(result.value) : invalid;
}

/** A Swagger `type` given as a name string, such as `'integer'` or `'file'`. */
function namedTypeSpec(name: string): SwaggerTypeSpec {
  if (SWAGGER_PRIMITIVES.has(name)) return { kind: 'primitive', primitive: name as SwaggerPrimitive, isArray: false };
  if (name === 'any') return { kind: 'any', isArray: false };
  return { kind: 'unrecognized', text: name, isArray: false };
}

/** The `type` option: an inline expression, or a name string supplied by a spread or constant. */
function optionTypeSpec(checker: ts.TypeChecker, options: DecoratorOptions): SwaggerTypeSpec | undefined {
  const entry = options.entry('type');
  if (!entry) return undefined;
  if (entry.kind === 'value' && typeof entry.value === 'string') return namedTypeSpec(entry.value);
  return swaggerTypeSpec(checker, options.expression('type')!);
}

/** Remove `null`/`undefined` members from a union when exactly one value member remains. */
function nonNullable(type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const members = type.types.filter(item => (item.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
  return members.length === 1 ? members[0]! : type;
}

function isArrayLike(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker.isArrayType(type) || checker.isTupleType(type);
}

function typeSymbolName(type: ts.Type): string | undefined {
  return type.getSymbol()?.getName() ?? type.aliasSymbol?.getName();
}

/** `any` and `unknown` place no constraint a Swagger `type` could contradict. */
function isUnconstrained(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function typeMatchesPrimitive(
  checker: ts.TypeChecker,
  type: ts.Type,
  primitive: SwaggerPrimitive,
  format: string | undefined,
): boolean {
  if (primitive === 'array') return isArrayLike(checker, type);
  if (primitive === 'object') return (type.flags & ts.TypeFlags.Object) !== 0;
  if (primitive === 'string') {
    // Nest documents a `Date` or an upload object (`format: 'binary'`) as a formatted string.
    return (type.flags & ts.TypeFlags.StringLike) !== 0
      || typeSymbolName(type) === 'String'
      || typeSymbolName(type) === 'Date'
      || (format !== undefined && (type.flags & ts.TypeFlags.Object) !== 0);
  }
  if (primitive === 'number' || primitive === 'integer') {
    return (type.flags & ts.TypeFlags.NumberLike) !== 0 || typeSymbolName(type) === 'Number';
  }
  return (type.flags & ts.TypeFlags.BooleanLike) !== 0 || typeSymbolName(type) === 'Boolean';
}

function typeMatchesSpec(
  checker: ts.TypeChecker,
  type: ts.Type,
  spec: SwaggerTypeSpec,
  format: string | undefined,
): boolean {
  const value = nonNullable(type);
  if (isUnconstrained(value) || spec.kind === 'any' || spec.kind === 'unrecognized') return true;
  const isArray = isArrayLike(checker, value);
  if (spec.kind === 'primitive' && spec.primitive === 'array' && !spec.isArray) return isArray;
  if (spec.isArray !== isArray) return false;
  const element = isArray ? checker.getTypeArguments(value as ts.TypeReference)[0] : value;
  if (!element) return false;
  const item = nonNullable(element);
  if (isUnconstrained(item)) return true;
  switch (spec.kind) {
    case 'primitive': return typeMatchesPrimitive(checker, item, spec.primitive, format);
    case 'date': return typeSymbolName(item) === 'Date';
    case 'enum': return checker.isTypeAssignableTo(item, spec.type);
    // A narrower TypeScript type may be documented as its base class.
    case 'class': return checker.isTypeAssignableTo(item, spec.type);
    case 'invalid': return false;
  }
}

/** The schema an explicit primitive Swagger `type` states; other specs keep the TypeScript-derived schema. */
function schemaForSwaggerType(spec: SwaggerTypeSpec): Record<string, unknown> | undefined {
  if (spec.kind !== 'primitive') return undefined;
  const base: Record<string, unknown> = { type: spec.primitive };
  return spec.isArray && spec.primitive !== 'array' ? { type: 'array', items: base } : base;
}

interface PropertyMetadata {
  readonly property: ts.Symbol;
  readonly node: ts.Node;
  readonly hidden: boolean;
  readonly optional: boolean;
  readonly options?: DecoratorOptions;
}

function nodeForProperty(property: ts.Symbol, fallback: ts.Node): ts.Node {
  return property.valueDeclaration ?? property.declarations?.[0] ?? fallback;
}

function propertyMetadata(reader: MetadataReader, property: ts.Symbol, fallback: ts.Node): PropertyMetadata | undefined {
  const node = nodeForProperty(property, fallback);
  const decorators = decoratorsOf(reader.checker, node);
  const hide = hasDecorator(decorators, 'ApiHideProperty', NEST_SWAGGER);
  const api = hasDecorator(decorators, 'ApiProperty', NEST_SWAGGER);
  const optional = hasDecorator(decorators, 'ApiPropertyOptional', NEST_SWAGGER);
  const decorator = api ?? optional;
  if (!hide && !decorator) return undefined;
  return {
    property,
    node,
    hidden: hide !== undefined,
    optional: optional !== undefined,
    ...(decorator ? { options: decoratorOptions(reader, decorator) } : {}),
  };
}

function setRequired(
  schema: Record<string, unknown>,
  property: string,
  required: boolean,
): void {
  const current = Array.isArray(schema.required) ? [...schema.required].map(String) : [];
  const next = new Set(current);
  if (required) next.add(property);
  else next.delete(property);
  const requiredNames = [...next].sort();
  if (requiredNames.length === 0) delete schema.required;
  else schema.required = requiredNames;
}

function schemaPropertyType(
  checker: ts.TypeChecker,
  property: ts.Symbol,
  fallback: ts.Node,
): ts.Type {
  return checker.getTypeOfSymbolAtLocation(property, nodeForProperty(property, fallback));
}

function schemaShape(value: DtoSchema): DtoSchema {
  if (typeof value === 'boolean') return value;
  const result: Record<string, unknown> = {};
  for (const key of ['type', 'items', 'properties', 'required', 'additionalProperties', 'enum', 'const']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function applyPropertyMetadata(
  checker: ts.TypeChecker,
  entry: PropertyMetadata,
  schema: Record<string, unknown>,
  options: DtoSchemaOptions,
): void {
  const fail = (code: TsToOpenApiDiagnosticCode, message: string): never => throwSchemaDiagnostic(entry.node, code, message);
  const conflict = (message: string): never => fail(TsToOpenApiDiagnosticCode.ConflictingSchemaMetadata, message);
  if (!isRecord(schema.properties)) {
    if (options.authoritative) conflict(`Swagger property metadata for ${entry.property.name} cannot be applied to an unresolved authoritative schema.`);
    return;
  }
  const name = entry.property.name;
  const existing = schema.properties[name];
  if (existing === undefined) conflict(`Swagger property ${name} is absent from the TypeScript schema.`);
  if (entry.hidden) {
    if (options.authoritative) conflict(`@ApiHideProperty() would remove authoritative IModel field ${name}.`);
    const properties = { ...schema.properties };
    delete properties[name];
    schema.properties = properties;
    setRequired(schema, name, false);
    return;
  }

  const read = entry.options;
  const propertyType = schemaPropertyType(checker, entry.property, entry.node);
  const explicitType = read && optionTypeSpec(checker, read);
  const isArrayOption = read?.boolean('isArray') === true;
  const format = read?.string('format');
  const typeSpec: SwaggerTypeSpec | undefined = explicitType
    ? { ...explicitType, isArray: explicitType.isArray || isArrayOption }
    : isArrayOption ? { kind: 'any', isArray: true } : undefined;
  if (typeSpec?.kind === 'unrecognized') {
    options.onWarning?.(diagnostic(
      entry.node.getSourceFile(),
      read?.node('type') ?? entry.node,
      TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
      `Swagger property ${name} type ${typeSpec.text} is not modelled; the TypeScript property type ${checker.typeToString(propertyType)} is used.`,
      GolemDiagnosticSeverity.Warning,
    ));
  } else if (typeSpec && !typeMatchesSpec(checker, propertyType, typeSpec, format)) {
    conflict(`Swagger property ${name} type conflicts with the TypeScript property type ${checker.typeToString(propertyType)}.`);
  }
  const generated = typeSpec && schemaForSwaggerType(typeSpec);
  if (options.authoritative && generated && !sameValue(schemaShape(existing as DtoSchema), generated)) {
    conflict(`Swagger property ${name} type would overwrite the authoritative IModel wire schema.`);
  }

  // An unconstrained ordinary field (`unknown`) is the `true` schema; give its metadata an object to live on.
  let propertySchema: DtoSchema = existing === true && !options.authoritative ? {} : existing as DtoSchema;
  const explicitSchema = read?.value('schema');
  if (explicitSchema !== undefined) {
    if (!isRecord(explicitSchema) && typeof explicitSchema !== 'boolean') {
      fail(TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata, `Swagger property ${name} schema must be a static object or boolean.`);
    }
    propertySchema = mergeSchemaMetadata(propertySchema, explicitSchema as DtoSchema, {
      ...options,
      node: entry.node,
      location: `${options.location ?? 'schema'}.properties.${name}`,
    });
  }
  if (typeof propertySchema !== 'boolean') {
    // An ordinary DTO field documented as another primitive (an upload object as
    // `{ type: 'string', format: 'binary' }`) takes that shape instead of its own.
    const replacesShape = generated !== undefined && !options.authoritative && propertySchema.type !== generated.type;
    const schemaRecord: Record<string, unknown> = replacesShape ? schemaAnnotations(propertySchema) : { ...propertySchema };
    let normalizedPropertySchema: DtoSchema | undefined;
    const docs: readonly [string, unknown][] = [
      ['title', read?.documentationString('title')],
      ['description', read?.documentationString('description')],
      ['default', read?.value('default')],
      ['example', read?.documentation('example')],
      ['examples', read?.documentation('examples')],
      ['deprecated', read?.boolean('deprecated')],
      ['readOnly', read?.boolean('readOnly')],
      ['writeOnly', read?.boolean('writeOnly')],
      ['externalDocs', read?.documentation('externalDocs')],
      ['xml', read?.value('xml')],
      ['discriminator', read?.value('discriminator')],
    ];
    for (const [key, value] of docs) if (value !== undefined) schemaRecord[key] = value;
    const enumValue = read?.value('enum');
    if (enumValue !== undefined) {
      if (!isStaticArray(enumValue)) return fail(TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata, `Swagger property ${name} enum must be a static array or an enum.`);
      const expected = schemaValues(propertySchema);
      if (options.authoritative && expected && !sameValue([...expected].sort(), [...enumValue].sort())) {
        conflict(`Swagger property ${name} enum conflicts with the authoritative IModel wire schema.`);
      }
      schemaRecord.enum = enumValue;
    }
    const structural: readonly [string, unknown][] = [
      ['pattern', read?.string('pattern')],
      ['minimum', read?.number('minimum')],
      ['maximum', read?.number('maximum')],
      ['exclusiveMinimum', read?.number('exclusiveMinimum')],
      ['exclusiveMaximum', read?.number('exclusiveMaximum')],
      ['multipleOf', read?.number('multipleOf')],
      ['minLength', read?.number('minLength')],
      ['maxLength', read?.number('maxLength')],
      ['minItems', read?.number('minItems')],
      ['maxItems', read?.number('maxItems')],
      ['uniqueItems', read?.boolean('uniqueItems')],
    ];
    if (format !== undefined) {
      if (options.authoritative && isAssertionFormat(format)) {
        if (schemaRecord.format !== undefined && !sameValue(schemaRecord.format, format)) {
          conflict(`Swagger property ${name}.format conflicts with the authoritative IModel wire schema.`);
        }
        if (schemaRecord.format === undefined) {
          conflict(`Swagger property ${name}.format adds a validation assertion absent from the authoritative IModel wire schema.`);
        }
      }
      schemaRecord.format = format;
    }
    for (const [key, value] of structural) {
      if (value === undefined) continue;
      if (options.authoritative && schemaRecord[key] !== undefined && !sameValue(schemaRecord[key], value)) {
        conflict(`Swagger property ${name}.${key} conflicts with the authoritative IModel wire schema.`);
      }
      if (options.authoritative && schemaRecord[key] === undefined) {
        conflict(`Swagger property ${name}.${key} adds a constraint absent from the authoritative IModel wire schema.`);
      }
      schemaRecord[key] = value;
    }
    const nullable = read?.boolean('nullable');
    if (nullable !== undefined) {
      if (options.authoritative) {
        const allowsNull = schemaAllowsNull(propertySchema, options);
        if (nullable && !allowsNull) conflict(`Swagger property ${name}.nullable permits null but the authoritative IModel wire schema does not.`);
        if (!nullable && allowsNull) conflict(`Swagger property ${name}.nullable forbids null but the authoritative IModel wire schema permits it.`);
      } else {
        normalizedPropertySchema = normalizeNullable(schemaRecord, nullable, options);
      }
    }
    if (generated && !options.authoritative) {
      schemaRecord.type = generated.type;
      if (generated.type === 'array') schemaRecord.items = generated.items;
    }
    propertySchema = normalizedPropertySchema ?? schemaRecord;
    const enumName = read?.string('enumName');
    if (enumName !== undefined) {
      propertySchema = namedEnumReference(checker, entry, enumName, propertySchema, options);
    }
  }
  const requiredOption = read?.boolean('required');
  const required = requiredOption ?? (!entry.optional && (entry.property.flags & ts.SymbolFlags.Optional) === 0);
  if (options.authoritative) {
    const expectedRequired = Array.isArray(schema.required) && schema.required.includes(name);
    if (required !== expectedRequired) conflict(`Swagger property ${name} requiredness conflicts with the authoritative IModel wire schema.`);
  }
  setRequired(schema, name, required);
  schema.properties = { ...schema.properties, [name]: propertySchema };
}

/**
 * `@ApiProperty({ enum, enumName })`: Nest documents the enum once as
 * `components.schemas.<enumName>` and references it from each property. An
 * IModel field keeps its authoritative inline enum.
 */
function namedEnumReference(
  checker: ts.TypeChecker,
  entry: PropertyMetadata,
  enumName: string,
  schema: DtoSchema,
  options: DtoSchemaOptions,
): DtoSchema {
  const fail = (message: string): never => throwSchemaDiagnostic(entry.node, TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata, message);
  const name = entry.property.name;
  if (typeof schema === 'boolean') return schema;
  const isArray = isArrayLike(checker, nonNullable(schemaPropertyType(checker, entry.property, entry.node)));
  const valueSchema = isArray && isRecord(schema.items) ? schema.items : schema;
  const values = schemaValues(valueSchema);
  if (!values) return fail(`Swagger property ${name} sets enumName ${enumName} without enum values.`);
  if (options.authoritative) {
    options.onWarning?.(diagnostic(
      entry.node.getSourceFile(),
      entry.node,
      TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
      `Swagger property ${name} enumName ${enumName} is ignored; the IModel wire schema keeps its inline enum.`,
      GolemDiagnosticSeverity.Warning,
    ));
    return schema;
  }
  if (!options.registerEnumComponent) return fail(`Swagger property ${name} enumName ${enumName} needs a components registry.`);
  const types = [...new Set(values.map(value => (value === null ? 'null' : typeof value)))];
  const type = types.length === 1 && (types[0] === 'string' || types[0] === 'number') ? types[0] : undefined;
  options.registerEnumComponent(enumName, { ...(type ? { type } : {}), enum: [...values] }, entry.node);
  const reference = { $ref: `#/components/schemas/${enumName}` };
  const annotations = schemaAnnotations(schema);
  const nullable = schemaAllowsNull(schema, options);
  const value = isArray ? { type: 'array', items: reference } : reference;
  return nullable
    ? { ...annotations, anyOf: [value, { type: 'null' }] }
    : { ...annotations, ...value };
}

/** Apply the overlay to each object-valued branch of a nullable/optional `anyOf`/`oneOf` wrapper. */
function applyToVariants(
  checker: ts.TypeChecker,
  type: ts.Type,
  schema: Record<string, unknown>,
  sourceNode: ts.Node,
  options: DtoSchemaOptions,
  active: Set<ts.Type>,
): DtoSchema {
  let result = schema;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = result[key];
    if (!Array.isArray(variants)) continue;
    result = {
      ...result,
      [key]: variants.map(variant => (
        isRecord(variant) && (isRecord(variant.properties) || schemaReference(variant) !== undefined)
          ? overlay(checker, type, variant, sourceNode, options, active)
          : variant
      )),
    };
  }
  return result;
}

function overlay(
  checker: ts.TypeChecker,
  declaredType: ts.Type,
  schema: DtoSchema,
  sourceNode: ts.Node,
  options: DtoSchemaOptions,
  active: Set<ts.Type>,
): DtoSchema {
  if (typeof schema === 'boolean') return schema;
  const type = nonNullable(unwrapAsyncType(checker, declaredType).type);
  if (isArrayLike(checker, type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    const items = schema.items;
    if (!element || (typeof items !== 'boolean' && !isRecord(items))) return schema;
    return { ...schema, items: overlay(checker, element, items, sourceNode, options, active) };
  }
  if ((type.flags & ts.TypeFlags.Object) === 0 || active.has(type)) return schema;
  if (!isRecord(schema.properties) && !schemaReference(schema)) {
    return applyToVariants(checker, type, schema, sourceNode, options, active);
  }
  active.add(type);
  try {
    const reader: MetadataReader = {
      checker,
      ...(options.registerSchemaComponent ? { registerSchemaComponent: options.registerSchemaComponent } : {}),
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    };
    const properties = checker.getPropertiesOfType(type);
    const metadata = properties
      .map(property => propertyMetadata(reader, property, sourceNode))
      .filter((entry): entry is PropertyMetadata => entry !== undefined);
    if (schemaReference(schema)) {
      if (!options.authoritative || metadata.length === 0) return schema;
      const resolved = resolvedSchema(schema, options);
      if (!resolved) throwSchemaDiagnostic(sourceNode, TsToOpenApiDiagnosticCode.ConflictingSchemaMetadata, 'Swagger property metadata cannot be checked against an unresolved authoritative IModel reference.');
      // Validate against the resolved contract, but keep the reference in the
      // emitted operation so the component remains authoritative.
      active.delete(type);
      overlay(checker, type, resolved, sourceNode, options, active);
      return schema;
    }
    const result: Record<string, unknown> = { ...schema };
    for (const entry of metadata) applyPropertyMetadata(checker, entry, result, options);
    if (!isRecord(result.properties)) return result;
    // Nested DTOs carry their own decorators whether or not the parent field is decorated.
    const nested: Record<string, unknown> = { ...result.properties };
    for (const property of properties) {
      const propertySchema = nested[property.name];
      if (propertySchema === undefined || (typeof propertySchema !== 'boolean' && !isRecord(propertySchema))) continue;
      const node = nodeForProperty(property, sourceNode);
      const propertyType = schemaPropertyType(checker, property, sourceNode);
      nested[property.name] = overlay(checker, propertyType, propertySchema, node, {
        ...options,
        authoritative: options.isAuthoritativeType?.(nonNullable(propertyType), node) ?? false,
        location: `${options.location ?? 'schema'}.properties.${property.name}`,
      }, active);
    }
    result.properties = nested;
    return result;
  } finally {
    active.delete(type);
  }
}

/**
 * Apply actual @nestjs/swagger property decorators to an ordinary DTO
 * schema, looking through arrays, `Promise`/`Observable` and nullable or
 * optional unions, and into nested DTOs. IModel references remain
 * authoritative; metadata that would remove or change their wire contract is
 * rejected by the same structural checks.
 */
export function applySwaggerPropertyMetadata(
  checker: ts.TypeChecker,
  type: ts.Type,
  schema: DtoSchema,
  sourceNode: ts.Node,
  options: DtoSchemaOptions = {},
): DtoSchema {
  return overlay(checker, type, schema, sourceNode, options, new Set());
}
