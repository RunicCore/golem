import { deduplicateProjections, modelSpecificationForClass } from '@exprtlabs/golem/type-analysis';
import { dirname, relative } from 'node:path';
import * as ts from '@exprtlabs/golem/ts';
import {
  emitModelFromJSON,
  emitModelFromInit,
  emitModelToJSON,
  emitCodecRuntime,
  pruneNamedImport,
  stringifyFunctionName,
  wireStringifyExportName,
  fromWireFunctionName,
  toWireFunctionName,
  literalValues,
  type FromJsonModelResolver,
  type ModelConversionDescriptor,
  type ModelDiscriminators,
  type SerdeResolver,
  type ToJsonModelResolver,
} from '@exprtlabs/golem/emitter';
import { createSchemaGraph, codecPublicId, codecShortName, internDescriptors, type SchemaGraph } from '@exprtlabs/golem/schema-graph';
import { propertyName, RESERVED_MODEL_MEMBERS, type CodegenProfile } from '@exprtlabs/golem/generator-api';
import type { ManifestIndex } from '@exprtlabs/golem/type-analysis';
import type { ModelSpecification } from '@exprtlabs/golem/type-analysis';
import { descriptorBuilder, propertyType } from '@exprtlabs/golem/type-analysis';
import {
  canonicalFilename,
  commonDirectory,
  generatedFilename,
  portableRelativeFilename,
} from '@exprtlabs/golem/type-analysis';
import type {
  ConstraintSchemaValue,
  ModelConstraint,
  SerdeBinding,
  ValidationBinding,
} from '@exprtlabs/golem/type-analysis';
import {
  canonicalSchemaKey,
  canonicalConstraintKey,
  createExecutableValidationMemo,
  projectPortableConstraints,
  type ExecutableValidationMemo,
  schemaForDescriptor,
  validationTagKey,
  validationTagSchemaDescriptor,
  VALIDATION_KEYWORD,
} from '@exprtlabs/golem/schema';

type RichDescriptor = ModelConversionDescriptor & {
  readonly validations?: readonly ValidationBinding[];
  readonly serde?: SerdeBinding & { readonly wireDescriptor?: ModelConversionDescriptor };
  readonly constraints?: readonly ModelConstraint[];
  readonly date?: true;
};

function richDescriptor(descriptor: ModelConversionDescriptor): RichDescriptor {
  return descriptor as RichDescriptor;
}

function sourceImportPath(source: string, output: string): string {
  const relativePath = relative(dirname(output), source)
    .replace(/\\/g, '/')
    .replace(/\.(?:m|c)?ts$/, '.js');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/**
 * Keep descriptor payloads as JSON data in generated modules.  Embedding a
 * JSON string and parsing it at module load preserves own `__proto__` keys;
 * an object literal would invoke the legacy prototype setter instead.
 */
function jsonDataExpression(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Generated descriptor data is not JSON serializable.');
  return `JSON.parse(${JSON.stringify(json)}) as object`;
}

function isModelDescriptor(value: ConstraintSchemaValue): value is ModelConversionDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'kind') === 'string';
}

function forEachConstraintSchema(
  constraint: ModelConstraint,
  visit: (descriptor: ModelConversionDescriptor) => void,
): void {
  const one = (value: ConstraintSchemaValue): void => {
    if (isModelDescriptor(value)) visit(value);
  };
  switch (constraint.kind) {
    case 'contains':
    case 'propertyNames':
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'items':
    case 'unevaluatedItems':
    case 'not':
      one(constraint.schema);
      break;
    case 'patternProperties':
      one(constraint.schema);
      break;
    case 'dependentSchemas':
      Object.values(constraint.value).forEach(one);
      break;
    case 'oneOf':
      constraint.schemas.forEach(one);
      break;
    case 'ifThenElse':
      one(constraint.if);
      if (constraint.then !== undefined) one(constraint.then);
      if (constraint.else !== undefined) one(constraint.else);
      break;
    default:
      break;
  }
}

function mapConstraint(
  constraint: ModelConstraint,
  validationEnabled: boolean,
  wire: boolean,
  retainPredicates: boolean,
  definitions: Readonly<Record<string, ModelConversionDescriptor>>,
): ModelConstraint {
  if (!validationEnabled) return constraint;
  const project = (value: ConstraintSchemaValue): ConstraintSchemaValue =>
    isModelDescriptor(value)
      ? projectDescriptor(value, validationEnabled, wire, retainPredicates, definitions)
      : value;
  switch (constraint.kind) {
    case 'contains':
    case 'propertyNames':
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'items':
    case 'unevaluatedItems':
    case 'not':
      return { ...constraint, schema: project(constraint.schema) };
    case 'patternProperties':
      return { ...constraint, schema: project(constraint.schema) };
    case 'dependentSchemas':
      return { ...constraint, value: Object.fromEntries(Object.entries(constraint.value).map(([name, value]) => [name, project(value)])) };
    case 'oneOf':
      return { ...constraint, schemas: constraint.schemas.map(project) };
    case 'ifThenElse':
      return {
        ...constraint,
        if: project(constraint.if),
        ...(constraint.then === undefined ? {} : { then: project(constraint.then) }),
        ...(constraint.else === undefined ? {} : { else: project(constraint.else) }),
      };
    default:
      return constraint;
  }
}

function descriptorExternalIds(
  descriptor: ModelConversionDescriptor,
  found = new Set<string>(),
): Set<string> {
  const wire = richDescriptor(descriptor).serde?.wireDescriptor;
  if (wire) descriptorExternalIds(wire, found);
  for (const constraint of richDescriptor(descriptor).constraints ?? []) {
    forEachConstraintSchema(constraint, (nested) => descriptorExternalIds(nested, found));
  }
  if (descriptor.kind === 'generated-model') found.add(descriptor.id);
  else if (descriptor.kind === 'array') descriptorExternalIds(descriptor.item, found);
  else if (descriptor.kind === 'tuple') {
    for (const item of descriptor.items) descriptorExternalIds(item, found);
    const rest = descriptor.rest;
    if (rest) descriptorExternalIds(rest.item, found);
  } else if (descriptor.kind === 'union' || descriptor.kind === 'intersection') {
    for (const item of descriptor.variants) descriptorExternalIds(item, found);
  } else if (descriptor.kind === 'object') {
    for (const item of Object.values(descriptor.properties)) descriptorExternalIds(item, found);
    if (typeof descriptor.additionalProperties === 'object') {
      descriptorExternalIds(descriptor.additionalProperties, found);
    }
  }
  return found;
}

function assertGeneratedNames(
  specifications: readonly ModelSpecification[],
  profile: CodegenProfile,
  externalIds: readonly string[],
  manifestIndex: ManifestIndex,
): Map<string, string> {
  // These names are part of the generated model API.  Reserve the complete
  // set even when a profile currently omits one integration so a later
  // profile change cannot turn a handwritten field into an API collision.
  const reserved = new Set(RESERVED_MODEL_MEMBERS);
  const used = new Map<string, string>();
  for (const specification of specifications) {
    for (const name of [specification.name, `${specification.name}Base`, `${specification.name}Fields`]) {
      if (used.has(name)) {
        throw new Error(`Generated model symbol collision for "${name}" between ${used.get(name)} and ${specification.sourceFile.fileName}.`);
      }
      used.set(name, specification.sourceFile.fileName);
    }
  }
  const names = new Map<string, string>();
  for (const id of externalIds) {
    const model = manifestIndex.byId.get(id);
    if (!model) throw new Error(`Generated model manifest id is missing: ${id}`);
    const name = model.generated.export;
    const previous = names.get(name) ?? used.get(name);
    if (previous) {
      throw new Error(
        `Generated model import collision for "${name}" between ${previous} and ${model.manifestFile}.`,
      );
    }
    if (reserved.has(name)) {
      throw new Error(`Generated model import "${name}" collides with a generated API member.`);
    }
    names.set(name, model.manifestFile);
  }
  return new Map(externalIds.map((id) => {
    const model = manifestIndex.byId.get(id);
    if (!model) throw new Error(`Generated model manifest id is missing: ${id}`);
    return [id, model.generated.export] as const;
  }));
}

function resolveFromJsonModel(
  externalNames: ReadonlyMap<string, string>,
  id: string,
): FromJsonModelResolver {
  const className = externalNames.get(id);
  if (!className) throw new Error(`Generated model manifest id is missing: ${id}`);
  return {
    className,
    decode: (value) => `decodeGeneratedModelTrusted(${className}, ${value})`,
    // SDK constructors may be zero-argument classes.  Cast only the
    // constructor call boundary so nested initializers stay type-safe without
    // indexing an empty ConstructorParameters tuple.
    fromInit: (value) => `new (${className} as unknown as new (values?: unknown) => ${className})(${value})`,
  };
}

function resolveToJsonModel(
  externalNames: ReadonlyMap<string, string>,
  id: string,
): ToJsonModelResolver {
  const className = externalNames.get(id);
  if (!className) throw new Error(`Generated model manifest id is missing: ${id}`);
  return { className, encode: (value) => `encodeGeneratedModel(${value})` };
}

function resolveLocalModel(
  localNames: ReadonlySet<string>,
  externalNames: ReadonlyMap<string, string>,
  name: string,
  codecId?: string,
): FromJsonModelResolver {
  if (localNames.has(name)) {
    const className = `${name}Base`;
    const initType = `${name}Init`;
    // Same-file handwritten classes would TDZ if this companion imported them.
    // The ttsc plugin registers the class under the hashed codec id.
    const ctor = codecId
      ? `(requireIModelClass(${JSON.stringify(codecId)}) as unknown as new (values?: ${initType}) => ${className})`
      : `(${className} as unknown as new (values?: ${initType}) => ${className})`;
    const decodeCtor = codecId ? `requireIModelClass(${JSON.stringify(codecId)})` : className;
    return {
      className,
      decode: (value) => `decodeGeneratedModelTrusted(${decodeCtor}, ${value})`,
      fromInit: (value) => `new ${ctor}(${value} as unknown as ${initType})`,
    };
  }
  return resolveFromJsonModel(externalNames, name);
}

interface BindingRegistry {
  readonly validations: Map<string, ValidationBinding>;
  readonly serde: Map<string, SerdeBinding>;
}

function visitDescriptor(
  descriptor: ModelConversionDescriptor,
  registry: BindingRegistry,
): void {
  const rich = richDescriptor(descriptor);
  for (const binding of rich.validations ?? []) registry.validations.set(binding.id, binding);
  if (rich.serde) {
    registry.serde.set(rich.serde.id, rich.serde);
    if (rich.serde.wireDescriptor) visitDescriptor(rich.serde.wireDescriptor, registry);
  }
  for (const constraint of rich.constraints ?? []) {
    forEachConstraintSchema(constraint, (nested) => visitDescriptor(nested, registry));
  }
  switch (descriptor.kind) {
    case 'array': visitDescriptor(descriptor.item, registry); break;
    case 'tuple':
      descriptor.items.forEach((item) => visitDescriptor(item, registry));
      if (descriptor.rest) visitDescriptor(descriptor.rest.item, registry);
      break;
    case 'union':
    case 'intersection': descriptor.variants.forEach((item) => visitDescriptor(item, registry)); break;
    case 'object':
      Object.values(descriptor.properties).forEach((item) => visitDescriptor(item, registry));
      if (typeof descriptor.additionalProperties === 'object') visitDescriptor(descriptor.additionalProperties, registry);
      break;
    default: break;
  }
}

export interface TagSchema {
  readonly key: string;
  readonly id: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface TagSchemaCompilation {
  readonly id: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** Metadata lookup keys that may share this compiled validator. */
  readonly keys: readonly string[];
}

/**
 * Group equivalent JSON schemas while retaining every metadata lookup key.
 * Callback identities and closed reference definitions are part of the
 * canonical schema key, so equivalent schemas can share a compiler while
 * distinct executable or reference semantics remain separate.
 */
export function deduplicateTagSchemas(
  schemas: readonly TagSchema[],
): readonly TagSchemaCompilation[] {
  const byMetadataKey = new Map<string, TagSchema>();
  for (const schema of schemas) {
    const previous = byMetadataKey.get(schema.key);
    if (!previous) {
      byMetadataKey.set(schema.key, schema);
      continue;
    }
    if (canonicalSchemaKey(previous.schema) !== canonicalSchemaKey(schema.schema)) {
      throw new Error(`Conflicting generated tag schema for metadata key ${JSON.stringify(schema.key)}.`);
    }
  }

  interface Group {
    readonly schemaKey: string;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly keys: string[];
    readonly order: number;
  }
  const groups = new Map<string, Group>();
  let order = 0;
  for (const schema of byMetadataKey.values()) {
    const schemaKey = canonicalSchemaKey(schema.schema);
    const existing = groups.get(schemaKey);
    if (existing) {
      existing.keys.push(schema.key);
    } else {
      groups.set(schemaKey, {
        schemaKey,
        schema: schema.schema,
        keys: [schema.key],
        order: order++,
      });
    }
  }
  return [...groups.values()]
    .sort((left, right) => left.schemaKey.localeCompare(right.schemaKey)
      || left.order - right.order)
    .map((group, index) => ({
      id: `runic:model-tag:${index}`,
      schema: group.schema,
      keys: [...group.keys].sort(),
    }));
}

function tagSchemas(
  descriptors: readonly ModelConversionDescriptor[],
  enabled: boolean,
  definitions: Readonly<Record<string, ModelConversionDescriptor>> = {},
  representation: 'model' | 'wire' = 'model',
): readonly TagSchema[] {
  if (!enabled) return [];
  const schemas = new Map<string, Readonly<Record<string, unknown>>>();
  const register = (key: string, schema: Readonly<Record<string, unknown>>): void => {
    const previous = schemas.get(key);
    if (previous && canonicalSchemaKey(previous) !== canonicalSchemaKey(schema)) {
      throw new Error('Generated tag metadata key resolves to conflicting validation schemas.');
    }
    schemas.set(key, schema);
  };
  const schemaOptions = { definitions };
  const visit = (descriptor: ModelConversionDescriptor): void => {
    const rich = richDescriptor(descriptor);
    const constraints = [...(rich.constraints ?? [])].sort((left, right) =>
      canonicalConstraintKey(left).localeCompare(canonicalConstraintKey(right)));
    const validations = [...(rich.validations ?? [])]
      .map((binding) => typeof binding === 'string' ? binding : (binding as ValidationBinding).id).sort();
    if (constraints.length > 0) {
      const key = validationTagKey(descriptor, { constraints, validations: [] }, { definitions, representation });
      // Keep structural siblings in the same schema context as object and
      // array keywords. In particular, `additionalProperties` must see the
      // descriptor's declared properties, and contains bounds must remain
      // siblings of contains. The key remains constraint-only so runtime
      // lookup continues to share validators for equivalent tag groups.
      const structural = schemaForDescriptor(
        validationTagSchemaDescriptor(descriptor, constraints, { definitions }),
        { ...schemaOptions, representation, executableBindings: true },
      );
      register(
        key,
        typeof structural === 'boolean' ? { allOf: [structural] } : structural,
      );
    }
    if (validations.length > 0) {
      const key = validationTagKey(descriptor, { constraints: [], validations }, { definitions, representation });
      register(key, { [VALIDATION_KEYWORD]: validations });
    }
    switch (descriptor.kind) {
      case 'array': visit(descriptor.item); break;
      case 'tuple':
        descriptor.items.forEach(visit);
        if (descriptor.rest) visit(descriptor.rest.item);
        break;
      case 'union':
      case 'intersection': descriptor.variants.forEach(visit); break;
      case 'object':
        Object.values(descriptor.properties).forEach(visit);
        if (typeof descriptor.additionalProperties === 'object') visit(descriptor.additionalProperties);
        break;
      default: break;
    }
  };
  descriptors.forEach(visit);
  return [...schemas.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, schema], index) => ({ key, schema, id: `runic:model-tag:${index}` }));
}

function projectDescriptor(
  descriptor: ModelConversionDescriptor,
  validationEnabled: boolean,
  wire: boolean,
  retainPredicates = !wire,
  definitions: Readonly<Record<string, ModelConversionDescriptor>> = {},
): ModelConversionDescriptor {
  const rich = richDescriptor(descriptor);
  const constraints = wire && !retainPredicates
    ? projectPortableConstraints(rich.constraints ?? [], { definitions, executableMemo: executableMemos.get(definitions) }, descriptor)
    : rich.constraints ?? [];
  if (wire && rich.serde) {
    const wireDescriptor = rich.serde.wireDescriptor;
    return wireDescriptor
      ? projectDescriptor(wireDescriptor, validationEnabled, true, true, definitions)
      : { kind: 'unknown' };
  }
  // TypeScript brands are commonly expressed as an intersection such as
  // `string & { readonly __wireCode?: never }`.  The brand carries no wire
  // data and must not turn a scalar JSON value into an impossible allOf of a
  // scalar and an object.  Keep genuine object intersections intact.
  if (wire && descriptor.kind === 'intersection') {
    const isBrand = (item: ModelConversionDescriptor): boolean => item.kind === 'object'
      && item.required.length === 0
      && item.additionalProperties === false
      && Object.entries(item.properties).every(([name, property]) =>
        name.startsWith('__') && (property.kind === 'undefined' || property.kind === 'never'));
    const scalar = descriptor.variants.find((item) =>
      item.kind === 'string' || item.kind === 'number' || item.kind === 'boolean' || item.kind === 'null',
    );
    if (scalar && descriptor.variants.every((item) => item === scalar || isBrand(item))) {
      const projectedScalar = projectDescriptor(scalar, validationEnabled, true, retainPredicates, definitions);
      const normalizedConstraints = validationEnabled
        ? constraints.map((constraint) => mapConstraint(
          constraint,
          validationEnabled,
          true,
          retainPredicates,
          definitions,
        )).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        : [];
      const normalizedValidations = [...(rich.validations ?? [])]
        .map((binding) => typeof binding === 'string' ? binding : (binding as ValidationBinding).id)
        .sort();
      return {
        ...projectedScalar,
        ...(retainPredicates && normalizedValidations.length ? { validations: normalizedValidations } : {}),
        ...(normalizedConstraints.length ? { constraints: normalizedConstraints } : {}),
      } as ModelConversionDescriptor;
    }
  }
  if (wire && descriptor.kind === 'date') {
    return {
      kind: 'string',
      ...(validationEnabled ? { constraints: [{ kind: 'format', value: 'date-time' }] } : {}),
    } as ModelConversionDescriptor;
  }
  let projected: ModelConversionDescriptor;
  switch (descriptor.kind) {
    case 'array': projected = {
      kind: 'array',
      ...(descriptor.isReadonly ? { isReadonly: true as const } : {}),
      item: projectDescriptor(descriptor.item, validationEnabled, wire, retainPredicates, definitions),
    }; break;
    case 'tuple':
      projected = {
        kind: 'tuple',
        ...(descriptor.isReadonly ? { isReadonly: true as const } : {}),
        items: descriptor.items.map((item) => projectDescriptor(item, validationEnabled, wire, retainPredicates, definitions)),
        ...(descriptor.optionalFrom === undefined ? {} : { optionalFrom: descriptor.optionalFrom }),
        ...(descriptor.rest ? {
          rest: { index: descriptor.rest.index, item: projectDescriptor(descriptor.rest.item, validationEnabled, wire, retainPredicates, definitions) },
        } : {}),
      };
      break;
    case 'union': projected = {
      kind: 'union',
      variants: descriptor.variants.map((item) => projectDescriptor(item, validationEnabled, wire, retainPredicates, definitions)),
      // Variants map one to one, so the tag table keeps its indexes.
      ...(descriptor.discriminator ? { discriminator: descriptor.discriminator } : {}),
    }; break;
    case 'intersection': projected = { kind: 'intersection', variants: descriptor.variants.map((item) => projectDescriptor(item, validationEnabled, wire, retainPredicates, definitions)) }; break;
    case 'object':
      projected = {
        kind: 'object',
        ...(descriptor.projection ? { projection: true as const } : {}),
        ...(descriptor.readonlyProperties ? { readonlyProperties: descriptor.readonlyProperties } : {}),
        properties: Object.fromEntries(Object.entries(descriptor.properties).map(([name, item]) => [name, projectDescriptor(item, validationEnabled, wire, retainPredicates, definitions)])),
        required: descriptor.required,
        additionalProperties: typeof descriptor.additionalProperties === 'object'
          ? projectDescriptor(descriptor.additionalProperties, validationEnabled, wire, retainPredicates, definitions)
          : descriptor.additionalProperties,
      };
      break;
    default: projected = { kind: descriptor.kind, ...('value' in descriptor ? { value: descriptor.value } : {}), ...('name' in descriptor ? { name: descriptor.name } : {}), ...('id' in descriptor ? { id: descriptor.id } : {}), ...('projection' in descriptor && descriptor.projection ? { projection: true } : {}), ...('construct' in descriptor && descriptor.construct ? { construct: true as const } : {}) } as ModelConversionDescriptor;
  }
  const normalizedConstraints = validationEnabled
    ? constraints.map(constraint => mapConstraint(constraint, validationEnabled, wire, retainPredicates, definitions))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  const normalizedValidations = [...(rich.validations ?? [])]
    .map((binding) => typeof binding === 'string' ? binding : (binding as ValidationBinding).id)
    .sort();
  const metadata = !validationEnabled
    ? {}
    : {
      ...(rich.validations?.length && retainPredicates
        ? { validations: normalizedValidations }
        : {}),
      ...(normalizedConstraints.length ? { constraints: normalizedConstraints } : {}),
    };
  return { ...projected, ...metadata } as ModelConversionDescriptor;
}

function descriptorType(
  descriptor: ModelConversionDescriptor,
  mode: 'model' | 'wire' | 'init',
  localNames: ReadonlySet<string>,
  externalNames: ReadonlyMap<string, string>,
): string {
  const rich = richDescriptor(descriptor);
  if (mode === 'wire' && rich.serde) {
    return rich.serde.wireDescriptor
      ? descriptorType(rich.serde.wireDescriptor, 'wire', localNames, externalNames)
      : 'unknown';
  }
  if (mode === 'wire' && descriptor.kind === 'date') return 'string';
  if ((mode === 'model' || mode === 'init') && descriptor.kind === 'date') return 'Date';
  switch (descriptor.kind) {
    case 'any': return 'any';
    case 'unknown': return 'unknown';
    case 'never': return 'never';
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'bigint': return 'bigint';
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'literal': return JSON.stringify(descriptor.value);
    case 'reference': return descriptor.projection ? `${descriptor.name}${mode === 'wire' ? 'JSON' : mode === 'init' ? 'Init' : 'Fields'}` : mode === 'wire'
      ? `${descriptor.name}JSON`
      : mode === 'init'
        ? `${descriptor.name}Init | ${descriptor.name}Base`
        : `${descriptor.name}Base`;
    case 'generated-model': {
      const className = externalNames.get(descriptor.id) ?? 'object';
      return mode === 'wire'
        ? `GeneratedModelWire<InstanceType<typeof ${className}>>`
        : mode === 'init'
          ? `(ConstructorParameters<typeof ${className}> extends [] ? never : ConstructorParameters<typeof ${className}> extends [(infer Initializer)?, ...unknown[]] ? Initializer : never) | InstanceType<typeof ${className}>`
          : `InstanceType<typeof ${className}>`;
    }
    case 'array': return `${descriptor.isReadonly ? 'ReadonlyArray' : 'Array'}<${descriptorType(descriptor.item, mode, localNames, externalNames)}>`;
    case 'tuple': {
      const items = descriptor.items.map((item, index) => {
        const type = descriptorType(item, mode, localNames, externalNames);
        return descriptor.optionalFrom !== undefined && index >= descriptor.optionalFrom ? `(${type})?` : type;
      });
      if (!descriptor.rest) return `${descriptor.isReadonly ? 'readonly ' : ''}[${items.join(', ')}]`;
      const restType = descriptorType(descriptor.rest.item, mode, localNames, externalNames);
      return `${descriptor.isReadonly ? 'readonly ' : ''}[${[...items.slice(0, descriptor.rest.index), `...Array<${restType}>`, ...items.slice(descriptor.rest.index)].join(', ')}]`;
    }
    case 'union': return descriptor.variants.map((item) => descriptorType(item, mode, localNames, externalNames)).join(' | ') || 'never';
    case 'intersection': return descriptor.variants.map((item) => descriptorType(item, mode, localNames, externalNames)).join(' & ') || 'unknown';
    case 'object': {
      const properties = Object.entries(descriptor.properties).map(([name, item]) => {
        const optional = descriptor.required.includes(name) ? '' : '?';
        return `${descriptor.readonlyProperties?.includes(name) ? "readonly " : ""}${propertyName(name)}${optional}: ${descriptorType(item, mode, localNames, externalNames)}`;
      });
      if (typeof descriptor.additionalProperties === 'object') properties.push(`[key: string]: ${descriptorType(descriptor.additionalProperties, mode, localNames, externalNames)}`);
      return `{ ${properties.join('; ')} }`;
    }
  }
  return 'unknown';
}

function fieldDescriptors(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  describe: (type: ts.Type, context: ModelSpecification, seen?: ReadonlySet<ts.Type>, node?: ts.TypeNode) => ModelConversionDescriptor,
  fields = checker.getPropertiesOfType(specification.fieldsType).filter((field) => !field.getName().startsWith('__@')),
): Map<string, ModelConversionDescriptor> {
  return new Map(
    fields.map((field) => [
      field.getName(),
      describe(
        propertyType(checker, field, specification.declaration),
        specification,
        undefined,
        (() => {
          const declaration = field.valueDeclaration ?? field.declarations?.[0];
          return declaration && (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration))
            ? declaration.type
            : undefined;
        })(),
      ),
    ]),
  );
}

function exportedConcreteClass(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  specifications: readonly ModelSpecification[],
  compilerOptions?: ts.CompilerOptions,
): string | undefined {
  const declaration = specification.sourceFile.statements.find((statement) =>
    ts.isClassDeclaration(statement)
      && statement.name?.text === specification.name
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
  return declaration && ts.isClassDeclaration(declaration) && declaration.name
    && modelSpecificationForClass(checker, checker.getTypeAtLocation(declaration), specifications, compilerOptions) === specification
    ? declaration.name.text
    : undefined;
}

function descriptorReferences(
  descriptor: ModelConversionDescriptor,
  found = new Set<string>(),
): Set<string> {
  const wire = richDescriptor(descriptor).serde?.wireDescriptor;
  if (wire) descriptorReferences(wire, found);
  for (const constraint of richDescriptor(descriptor).constraints ?? []) {
    forEachConstraintSchema(constraint, (nested) => descriptorReferences(nested, found));
  }
  if (descriptor.kind === 'reference') found.add(descriptor.name);
  else if (descriptor.kind === 'array') descriptorReferences(descriptor.item, found);
  else if (descriptor.kind === 'tuple') {
    descriptor.items.forEach((item) => descriptorReferences(item, found));
    if (descriptor.rest) descriptorReferences(descriptor.rest.item, found);
  } else if (descriptor.kind === 'union' || descriptor.kind === 'intersection') {
    descriptor.variants.forEach((item) => descriptorReferences(item, found));
  } else if (descriptor.kind === 'object') {
    Object.values(descriptor.properties).forEach((item) => descriptorReferences(item, found));
    if (typeof descriptor.additionalProperties === 'object') descriptorReferences(descriptor.additionalProperties, found);
  }
  return found;
}

function collectReferences(
  descriptor: ModelConversionDescriptor,
  owner: ModelSpecification,
  byName: ReadonlyMap<string, readonly ModelSpecification[]>,
  emitted: ReadonlySet<ModelSpecification>,
  pending: ModelSpecification[],
): void {
  const wire = richDescriptor(descriptor).serde?.wireDescriptor;
  if (wire) collectReferences(wire, owner, byName, emitted, pending);
  for (const constraint of richDescriptor(descriptor).constraints ?? []) {
    forEachConstraintSchema(constraint, (nested) => collectReferences(nested, owner, byName, emitted, pending));
  }
  if (descriptor.kind === 'reference') {
    const candidates = byName.get(descriptor.name) ?? [];
    const sameSource = candidates.filter((candidate) =>
      canonicalFilename(candidate.sourceFile.fileName) === canonicalFilename(owner.sourceFile.fileName),
    );
    const referenced = sameSource.length === 1
      ? sameSource[0]
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (candidates.length > 1 && sameSource.length !== 1) {
      throw new Error(
        `Ambiguous generated type reference "${descriptor.name}" in ${owner.sourceFile.fileName}.`,
      );
    }
    if (referenced && !emitted.has(referenced)) pending.push(referenced);
    return;
  }
  if (descriptor.kind === 'array') collectReferences(descriptor.item, owner, byName, emitted, pending);
  else if (descriptor.kind === 'tuple') {
    descriptor.items.forEach((item) => collectReferences(item, owner, byName, emitted, pending));
    if (descriptor.rest) collectReferences(descriptor.rest.item, owner, byName, emitted, pending);
  } else if (descriptor.kind === 'union' || descriptor.kind === 'intersection') {
    descriptor.variants.forEach((item) => collectReferences(item, owner, byName, emitted, pending));
  } else if (descriptor.kind === 'object') {
    Object.values(descriptor.properties).forEach((item) => collectReferences(item, owner, byName, emitted, pending));
    if (typeof descriptor.additionalProperties === 'object') {
      collectReferences(descriptor.additionalProperties, owner, byName, emitted, pending);
    }
  }
}

export interface SourceModelGraph {
  readonly source: string;
  readonly output: string;
  readonly identityRoot: string;
  readonly compilerOptions?: ts.CompilerOptions;
  readonly definitions: Readonly<Record<string, ModelConversionDescriptor>>;
  readonly modelDefinitions: Readonly<Record<string, ModelConversionDescriptor>>;
  readonly wireDefinitions: Readonly<Record<string, ModelConversionDescriptor>>;
  readonly externalIds: readonly string[];
  readonly externalNames: ReadonlyMap<string, string>;
  readonly registry: BindingRegistry;
  readonly schemas: readonly TagSchema[];
  /** Every model this companion names: its own, inlined ones, and sibling models. */
  readonly emitted: readonly ModelSpecification[];
  /**
   * Models another source of the same job declares. Their companion
   * emits their code; this companion references them by codec id.
   */
  readonly siblings: readonly ModelSpecification[];
}

/** A job's executable-validation memo, keyed by the lookup objects its walks receive. */
const executableMemos = new WeakMap<object, ExecutableValidationMemo>();

/** One job's type analysis: every model is described once, shared by all companions. */
export interface JobAnalysis {
  readonly describe: ReturnType<typeof descriptorBuilder>;
  readonly described: Map<ModelSpecification, ModelConversionDescriptor>;
  /** Canonical filenames of the job's model sources. */
  readonly sources: ReadonlySet<string>;
  readonly executableMemo: ExecutableValidationMemo;
  /**
   * Descriptors of every job model and projection by name, for schema
   * lookups that follow a sibling model's own references. Built once every
   * model is described; names declared twice are left out.
   */
  lookup?: Readonly<Record<string, ModelConversionDescriptor>>;
}

/** Describe every model of the job once and index the results for lookups. */
export function describeJob(job: JobAnalysis, specifications: readonly ModelSpecification[]): void {
  const byName = new Map<string, ModelConversionDescriptor | null>();
  for (const specification of specifications) {
    if (!job.sources.has(canonicalFilename(specification.sourceFile.fileName))) continue;
    let descriptor = job.described.get(specification);
    if (!descriptor) {
      descriptor = job.describe(specification.fieldsType, specification, undefined, specification.fieldsNode);
      job.described.set(specification, descriptor);
    }
    byName.set(specification.name, byName.has(specification.name) ? null : descriptor);
  }
  const lookup: Record<string, ModelConversionDescriptor> = Object.create(null) as Record<string, ModelConversionDescriptor>;
  for (const [name, descriptor] of job.describe.projections) lookup[name] = descriptor;
  for (const [name, descriptor] of byName) if (descriptor) lookup[name] = descriptor;
  job.lookup = lookup;
}

export function createJobAnalysis(
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
  manifestIndex: ManifestIndex,
  profile: CodegenProfile,
  sources: readonly string[],
  identityRoot?: string,
  compilerOptions?: ts.CompilerOptions,
): JobAnalysis {
  const stableIdentityRoot = canonicalFilename(identityRoot ?? commonDirectory(
    specifications.map((specification) => specification.sourceFile.fileName),
  ));
  return {
    describe: descriptorBuilder(
      checker,
      specifications,
      manifestIndex,
      profile.validation,
      profile.allowAny ?? false,
      stableIdentityRoot,
      compilerOptions,
    ),
    described: new Map(),
    sources: new Set(sources.map(canonicalFilename)),
    executableMemo: createExecutableValidationMemo(),
  };
}

/** Build one source graph without emitting application or generated code. */
export function analyzeSourceGraph(
  source: string,
  output: string,
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
  manifestIndex: ManifestIndex,
  profile: CodegenProfile,
  identityRoot?: string,
  compilerOptions?: ts.CompilerOptions,
  job: JobAnalysis = createJobAnalysis(checker, specifications, manifestIndex, profile, [source], identityRoot, compilerOptions),
): SourceModelGraph | undefined {
  const stableIdentityRoot = canonicalFilename(identityRoot ?? commonDirectory(
    specifications.map((specification) => specification.sourceFile.fileName),
  ));
  const { describe } = job;
  const describeOnce = (specification: ModelSpecification): ModelConversionDescriptor => {
    let descriptor = job.described.get(specification);
    if (!descriptor) {
      descriptor = describe(specification.fieldsType, specification, undefined, specification.fieldsNode);
      job.described.set(specification, descriptor);
    }
    return descriptor;
  };
  const canonicalSource = canonicalFilename(source);
  const local = specifications.filter((item) => canonicalFilename(item.sourceFile.fileName) === canonicalSource);
  if (local.length === 0) return undefined;
  // A model of another job source is emitted by that source's companion.
  const isSibling = (specification: ModelSpecification): boolean => {
    const owner = canonicalFilename(specification.sourceFile.fileName);
    return owner !== canonicalSource && job.sources.has(owner);
  };
  const byName = new Map<string, ModelSpecification[]>();
  for (const specification of specifications) {
    const candidates = byName.get(specification.name) ?? [];
    candidates.push(specification);
    byName.set(specification.name, candidates);
  }
  let definitions: Record<string, ModelConversionDescriptor> = {};
  const emitted = new Set<ModelSpecification>();
  const siblings = new Set<ModelSpecification>();
  const projections = new Map<string, ModelConversionDescriptor>();
  const pending = [...local];
  const collectProjections = (descriptor: ModelConversionDescriptor, owner: ModelSpecification): void => {
    for (const name of descriptorReferences(descriptor)) {
      const projection = describe.projections.get(name);
      if (!projection || projections.has(name)) continue;
      projections.set(name, projection);
      collectReferences(projection, owner, byName, emitted, pending);
      collectProjections(projection, owner);
    }
  };
  while (pending.length > 0) {
    const specification = pending.shift();
    if (!specification || emitted.has(specification)) continue;
    const duplicate = [...emitted].find((item) => item.name === specification.name);
    if (duplicate) throw new Error(`Generated model symbol collision for "${specification.name}" in ${source}.`);
    const descriptor = describeOnce(specification);
    definitions[specification.name] = descriptor;
    emitted.add(specification);
    if (isSibling(specification)) {
      // Its companion owns its conversion code and nested models.
      siblings.add(specification);
      continue;
    }
    collectReferences(descriptor, specification, byName, emitted, pending);
    collectProjections(descriptor, specification);
  }
  for (const [name, projection] of projections) definitions[name] = projection;
  definitions = deduplicateProjections(definitions, new Set(projections.keys()));
  const owned = Object.fromEntries(Object.entries(definitions).filter(([name]) =>
    ![...siblings].some((sibling) => sibling.name === name)));
  const externalIds = [...Object.values(owned).reduce(
    (found, descriptor) => descriptorExternalIds(descriptor, found),
    new Set<string>(),
  )].sort();
  const externalNames = assertGeneratedNames([...emitted], profile, externalIds, manifestIndex);
  const registry: BindingRegistry = { validations: new Map(), serde: new Map() };
  Object.values(owned).forEach((descriptor) => visitDescriptor(descriptor, registry));
  const ownedSpecifications = [...emitted].filter((specification) => !siblings.has(specification));
  const anyDeclValidation = ownedSpecifications.some((specification) => specification.validation ?? profile.validation);
  if (!anyDeclValidation) registry.validations.clear();
  // Sibling models keep their own references; lookups fall back to the job's descriptors.
  const lookup: Record<string, ModelConversionDescriptor> = Object.assign(
    Object.create(job.lookup ?? null) as Record<string, ModelConversionDescriptor>,
    definitions,
  );
  executableMemos.set(lookup, job.executableMemo);
  const modelDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, descriptor]) => [name, projectDescriptor(descriptor, profile.validation, false, true, lookup)]),
  );
  const wireDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, descriptor]) => [name, projectDescriptor(descriptor, profile.validation, true, false, lookup)]),
  );
  const wireLookup: Record<string, ModelConversionDescriptor> = Object.assign(
    Object.create(job.lookup ?? null) as Record<string, ModelConversionDescriptor>,
    wireDefinitions,
  );
  executableMemos.set(wireLookup, job.executableMemo);
  const schemas = [
    ...tagSchemas(Object.values(owned), profile.validation, lookup, 'model'),
    ...tagSchemas(Object.keys(owned).map((name) => wireDefinitions[name]), profile.validation, wireLookup, 'wire'),
  ];
  return {
    source,
    output,
    identityRoot: stableIdentityRoot,
    ...(compilerOptions ? { compilerOptions } : {}),
    definitions,
    modelDefinitions,
    wireDefinitions,
    externalIds,
    externalNames,
    registry,
    schemas,
    emitted: [...emitted],
    siblings: [...siblings],
  };
}

export interface SourceSchemaGraphOptions {
  /** Job-fixed codec ids by model name, for this source's models and its siblings. */
  readonly codecIds?: ReadonlyMap<string, string>;
  /** Models emitted by another companion of the job. */
  readonly siblings?: readonly ModelSpecification[];
  /** Codec ids and aliases of models emitted elsewhere that publish residual schemas. */
  readonly externalResidualIds?: { readonly modelOnly: ReadonlySet<string>; readonly wireOnly: ReadonlySet<string> };
}

export function internSourceDefinitions(
  definitions: Readonly<Record<string, ModelConversionDescriptor>>,
  emitted: readonly ModelSpecification[],
  profileValidation = true,
  options: SourceSchemaGraphOptions = {},
): ReturnType<typeof createSchemaGraph> {
  const schemaGraph = createSchemaGraph({}, {
    ...(options.codecIds ? { codecIds: options.codecIds } : {}),
    ...(options.externalResidualIds ? { externalResidualIds: options.externalResidualIds } : {}),
  });
  const siblings = new Set(options.siblings ?? []);
  const interned = new Set<string>();
  const entries: Array<{
    name: string;
    descriptor: ModelConversionDescriptor;
    emitClass?: boolean;
    validationEnabled?: boolean;
  }> = [];
  for (const specification of emitted) {
    interned.add(specification.name);
    const descriptor = definitions[specification.name];
    if (!descriptor) continue;
    entries.push({
      name: specification.name,
      // A sibling is a codec reference: its schema and code come from its companion.
      descriptor: siblings.has(specification) ? { kind: 'reference', name: specification.name } : descriptor,
      emitClass: siblings.has(specification) ? false : specification.emitClass,
      validationEnabled: specification.validation ?? profileValidation,
    });
  }
  for (const [name, descriptor] of Object.entries(definitions)) {
    if (interned.has(name)) continue;
    entries.push({ name, descriptor, emitClass: false, validationEnabled: profileValidation });
  }
  internDescriptors(schemaGraph, entries);
  schemaGraph.seal();
  return schemaGraph;
}

export function codecEntriesForGraph(graph: SourceModelGraph, schemaGraph?: SchemaGraph): ReadonlyArray<{
  readonly source: string;
  readonly name: string;
  readonly codecId: string;
}> {
  const internedSchemaGraph = schemaGraph ?? internSourceDefinitions(graph.definitions, graph.emitted);
  return graph.emitted.map((specification) => {
    const descriptor = graph.definitions[specification.name];
    const node = descriptor ? internedSchemaGraph.nodeFor(descriptor, specification.name, specification.emitClass) : undefined;
    return {
      source: portableRelativeFilename(specification.sourceFile.fileName, graph.identityRoot),
      name: specification.name,
      codecId: node?.codecId ?? codecPublicId(specification.name, descriptor ?? { kind: 'unknown' }, undefined, { source: 'typescript', constructs: specification.emitClass }),
    };
  });
}

export interface SharedSourceOptions {
  readonly output: string;
  readonly profile: CodegenProfile;
  readonly graphs: readonly SourceModelGraph[];
  readonly standaloneCode?: string;
  /** Relative/absolute module specifier for an external standalone factory. */
  readonly standaloneModule?: string;
}

export interface SharedSourceReference {
  readonly modulePath: string;
  readonly keyFor: (source: string, modelName: string) => string;
  readonly validationSetName?: string;
}

function sharedGraphKey(graph: SourceModelGraph, name: string): string {
  return `${portableRelativeFilename(graph.source, graph.identityRoot)}\0${name}`;
}

function canonicalKey(graph: SourceModelGraph): string {
  return portableRelativeFilename(graph.source, graph.identityRoot);
}

/** Emit one job-level registry so bindings are shared. */
export function emitSharedSource(options: SharedSourceOptions): string | undefined {
  const { output, profile, graphs } = options;
  const validationMap = new Map<string, ValidationBinding>();
  const serdeMap = new Map<string, SerdeBinding>();
  for (const graph of graphs) {
    const anyDeclValidation = graph.emitted.some((specification) => specification.validation ?? profile.validation);
    if (anyDeclValidation) {
      for (const binding of graph.registry.validations.values()) validationMap.set(binding.id, binding);
    }
    for (const binding of graph.registry.serde.values()) serdeMap.set(binding.id, binding);
  }
  const validations = [...validationMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  const serde = [...serdeMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  const validationNames = new Map(validations.map((binding, index) => [binding.id, `__runicValidation${index}`] as const));
  const serdeNames = new Map(serde.map((binding, index) => [binding.id, {
    serialize: `__runicSerialize${index}`,
    deserialize: `__runicDeserialize${index}`,
  }] as const));
  const hasValidationBindings = validations.length > 0;
  const hasSerdeBindings = serde.length > 0;
  const hasStandaloneValidators = profile.validation && profile.ajvStandalone === true && Boolean(options.standaloneModule);
  if (!hasValidationBindings && !hasSerdeBindings && !hasStandaloneValidators) return undefined;
  const lines: string[] = ['/* Generated by @exprtlabs/golem-model. Do not edit. */'];
  if (hasStandaloneValidators && options.standaloneModule) {
    lines.push(`import { createValidatorSet } from ${JSON.stringify(options.standaloneModule)};`);
  }
  lines.push(
    ...validations.map((binding) => `import { ${binding.exportName} as ${validationNames.get(binding.id)} } from ${JSON.stringify(sourceImportPath(binding.module, output))};`),
    ...serde.flatMap((binding) => {
      const names = serdeNames.get(binding.id);
      return [
        `import { ${binding.serialize.exportName} as ${names?.serialize}Source } from ${JSON.stringify(sourceImportPath(binding.serialize.module, output))};`,
        `import { ${binding.deserialize.exportName} as ${names?.deserialize}Source } from ${JSON.stringify(sourceImportPath(binding.deserialize.module, output))};`,
      ];
    }),
  );
  if (hasValidationBindings) {
    lines.push(
      '',
      'export const modelValidationBindings = Object.freeze({',
      ...validations.map((binding) => `  ${JSON.stringify(binding.id)}: (value: unknown): boolean | string => ((${validationNames.get(binding.id)}) as (value: unknown) => boolean | string)(value),`),
      '});',
    );
  }
  if (hasSerdeBindings) {
    lines.push(
      '',
      'export const modelSerdeBindings = Object.freeze({',
      ...serde.map((binding) => {
        const names = serdeNames.get(binding.id);
        return `  ${JSON.stringify(binding.id)}: { serialize: (value: unknown): unknown => ((${names?.serialize}Source) as (value: unknown) => unknown)(value), deserialize: (value: unknown): unknown => ((${names?.deserialize}Source) as (value: unknown) => unknown)(value) },`;
      }),
      '});',
    );
  }
  if (hasStandaloneValidators) {
    lines.push(
      '',
      `export const modelValidatorSet = createValidatorSet(${hasValidationBindings ? 'modelValidationBindings' : '{}'});`,
    );
  }
  lines.push('');
  return `${lines.join('\n').trim()}\n`;
}

/** How this companion relates to the job's other companions. */
export interface SiblingCodecOptions {
  /** Sibling codecs whose companion exports a wire stringify. */
  readonly siblingWireCodecIds?: ReadonlySet<string>;
  /**
   * Siblings whose sources import this one back. Their classes resolve by
   * codec id at decode time: importing the handwritten class would evaluate a
   * module whose base class is not initialized yet.
   */
  readonly cyclicSiblings?: ReadonlySet<string>;
  /** This companion's codecs another companion writes with their wire stringify. */
  readonly referencedWireCodecIds?: ReadonlySet<string>;
  /** This companion's object-only models another companion converts with their helpers. */
  readonly referencedObjectCodecIds?: ReadonlySet<string>;
}

/** Export name of an object-only model's conversion helper, keyed by codec id. */
export function objectHelperExportName(kind: 'decode' | 'init' | 'encode', codecId: string): string {
  return `__runic${kind[0].toUpperCase()}${kind.slice(1)}_${codecId.replace(/[^A-Za-z0-9_$]/g, '_')}`;
}

export function emitSource(
  source: string,
  output: string,
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
  manifestIndex: ManifestIndex,
  profile: CodegenProfile,
  shared?: SharedSourceReference,
  identityRoot?: string,
  preparedGraph?: SourceModelGraph,
  preparedSchemaGraph?: SchemaGraph,
  siblingCodecs: SiblingCodecOptions = {},
): string | undefined {
  const { siblingWireCodecIds, cyclicSiblings, referencedWireCodecIds, referencedObjectCodecIds } = siblingCodecs;
  const graph = preparedGraph ?? analyzeSourceGraph(source, output, checker, specifications, manifestIndex, profile, identityRoot);
  if (!graph) return undefined;
  const { definitions, externalIds, externalNames, registry } = graph;
  const emitted = graph.emitted;
  const local = emitted.filter(item => canonicalFilename(item.sourceFile.fileName) === canonicalFilename(source));
  const localNames = new Set([...emitted].map((specification) => specification.name));
  const fileLocalNames = new Set(local.map((specification) => specification.name));
  // Object-only models of another source convert through their companion's exported helpers.
  const siblingObjects = graph.siblings.filter((specification) => !specification.emitClass);
  const siblingObjectNames = new Set(siblingObjects.map((specification) => specification.name));
  const objectOnlyNames = new Set(
    [...emitted]
      .filter((specification) => !specification.emitClass && !siblingObjectNames.has(specification.name))
      .map((specification) => specification.name),
  );
  const concreteNames = new Map(
    [...emitted]
      .filter((specification) => !cyclicSiblings?.has(specification.name))
      .map((specification) => [specification.name, exportedConcreteClass(checker, specification, specifications, graph.compilerOptions)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  const referenceNames = [...Object.values(definitions)].reduce(
    (found, descriptor) => descriptorReferences(descriptor, found),
    new Set<string>(),
  );
  const localImports = [...emitted]
    .filter((specification) => !local.some((item) => item === specification) && !siblingObjectNames.has(specification.name))
    .sort((left, right) => left.name.localeCompare(right.name) || left.sourceFile.fileName.localeCompare(right.sourceFile.fileName));
  const discriminators = (name: string): ModelDiscriminators => {
    const definition = definitions[name];
    if (definition?.kind !== 'object') return {};
    return Object.fromEntries(definition.required.flatMap(key => {
      const values = literalValues(definition.properties[key]);
      if (!values) return [];
      return [[key, values.length === 1 ? values[0] : values]];
    }));
  };
  const conversionHelpers = new Set<'field' | 'define'>();
  const schemaGraph = preparedSchemaGraph ?? internSourceDefinitions(definitions, emitted, profile.validation, { siblings: graph.siblings });
  const classModelNames = new Set(emitted.filter((specification) => specification.emitClass).map((specification) => specification.name));
  const projectionNames = new Set([
    ...Object.keys(definitions).filter((name) => !localNames.has(name) && !classModelNames.has(name)),
    ...objectOnlyNames,
  ]);
  const projectionHelperByName = new Map<string, {
    readonly representative: string;
    readonly decode: string;
    readonly init: string;
    readonly encode: string;
  }>();
  for (const name of projectionNames) {
    projectionHelperByName.set(name, {
      representative: name,
      decode: `decode${name}`,
      init: `init${name}`,
      encode: `encode${name}`,
    });
  }
  const resolveProjection = (name: string): FromJsonModelResolver & ToJsonModelResolver => ({
    className: 'Object',
    discriminators: discriminators(name),
    decode: value => `${projectionHelperByName.get(name)?.decode ?? `decode${name}`}(${value})`,
    fromInit: value => `${projectionHelperByName.get(name)?.init ?? `init${name}`}(${value})`,
    encode: value => `${projectionHelperByName.get(name)?.encode ?? `encode${name}`}(${value})`,
  });
  const siblingClass = (id: string): string | undefined => {
    if (!cyclicSiblings?.has(id)) return undefined;
    const node = [...schemaGraph.nodes.values()].find((item) => item.siblingCodec && item.name === id);
    return node ? `requireIModelClass(${JSON.stringify(node.codecId)})` : undefined;
  };
  const resolveImportedModel = (id: string): FromJsonModelResolver => {
    const registered = siblingClass(id);
    const cls = registered ?? concreteNames.get(id) ?? (classModelNames.has(id) ? id : undefined);
    if (!cls) return resolveFromJsonModel(externalNames, id);
    // A class looked up by codec id is a value, not a type name.
    const instance = registered ? `${id}Base` : cls;
    return {
      className: cls,
      discriminators: discriminators(id),
      decode: (value) => `decodeGeneratedModelTrusted(${cls}, ${value})`,
      fromInit: (value) => `new (${cls} as unknown as new (values?: unknown) => ${instance})(${value})`,
    };
  };
  const siblingObjectCodecId = (name: string): string => {
    const node = [...schemaGraph.nodes.values()].find((item) => item.siblingCodec && item.name === name);
    if (!node) throw new Error(`Generated sibling codec is missing: ${name}`);
    return node.codecId;
  };
  const resolveSiblingObject = (name: string): FromJsonModelResolver & ToJsonModelResolver => {
    const codecId = siblingObjectCodecId(name);
    return {
      className: 'Object',
      discriminators: discriminators(name),
      decode: (value) => `${objectHelperExportName('decode', codecId)}(${value})`,
      fromInit: (value) => `${objectHelperExportName('init', codecId)}(${value})`,
      encode: (value) => `${objectHelperExportName('encode', codecId)}(${value})`,
    };
  };
  const resolveFromAny = (id: string): FromJsonModelResolver => {
    if (projectionNames.has(id)) return resolveProjection(id);
    if (siblingObjectNames.has(id)) return resolveSiblingObject(id);
    if (fileLocalNames.has(id)) {
      const codecId = schemaGraph.nodeFor(definitions[id] ?? { kind: 'unknown' }, id)?.codecId;
      return { ...resolveLocalModel(fileLocalNames, externalNames, id, codecId), discriminators: discriminators(id) };
    }
    if (localImports.some((item) => item.name === id) && classModelNames.has(id)) return resolveImportedModel(id);
    return resolveFromJsonModel(externalNames, id);
  };
  const validationBindings = [...registry.validations.values()].sort((left, right) => left.id.localeCompare(right.id));
  const serdeBindings = [...registry.serde.values()].sort((left, right) => left.id.localeCompare(right.id));
  const bindingNames = new Map<string, string>();
  const serdeNames = new Map<string, { readonly serialize: string; readonly deserialize: string }>();
  validationBindings.forEach((binding, index) => bindingNames.set(binding.id, `__runicValidation${index}`));
  serdeBindings.forEach((binding, index) => serdeNames.set(binding.id, {
    serialize: `__runicSerialize${index}`,
    deserialize: `__runicDeserialize${index}`,
  }));
  const serdeExpression = (id: string, direction: 'serialize' | 'deserialize', value: string): string => {
    if (shared) return `modelSerdeBindings[${JSON.stringify(id)}].${direction}(${value})`;
    const names = serdeNames.get(id);
    return names ? `${names[direction]}(${value})` : value;
  };
  const projectionExpressions = new Map<string, {
    readonly decode: string;
    readonly init: string;
    readonly encode: string;
  }>();
  const emitProjectionExpressions = (name: string): { readonly decode: string; readonly init: string; readonly encode: string } => {
    const descriptor = definitions[name];
    const serde: SerdeResolver = {
      deserialize: (id, value) => serdeExpression(id, 'deserialize', value),
      serialize: (id, value) => serdeExpression(id, 'serialize', value),
    };
    const encodeResolver = (id: string): ToJsonModelResolver => projectionNames.has(id) ? resolveProjection(id)
      : siblingObjectNames.has(id) ? resolveSiblingObject(id)
      : localNames.has(id) ? { className: `${id}Base`, discriminators: discriminators(id), encode: value => `encodeGeneratedModel(${value})` }
      : resolveToJsonModel(externalNames, id);
    const decode = emitModelFromJSON(descriptor, 'data', resolveFromAny, serde);
    const init = emitModelFromInit(descriptor, 'data', resolveFromAny);
    const encode = emitModelToJSON(descriptor, 'data', encodeResolver, serde);
    return { decode, init, encode };
  };
  const initialProjectionExpressions = new Map<string, { readonly decode: string; readonly init: string; readonly encode: string }>();
  for (const name of projectionNames) initialProjectionExpressions.set(name, emitProjectionExpressions(name));
  const projectionRepresentativeByKey = new Map<string, string>();
  for (const name of projectionNames) {
    const expressions = initialProjectionExpressions.get(name);
    if (!expressions) throw new Error(`Generated projection expressions are missing: ${name}`);
    const key = canonicalSchemaKey({
      model: descriptorType(definitions[name], 'model', localNames, externalNames),
      wire: descriptorType(definitions[name], 'wire', localNames, externalNames),
      init: descriptorType(definitions[name], 'init', localNames, externalNames),
      expressions,
    });
    const representative = projectionRepresentativeByKey.get(key) ?? name;
    projectionRepresentativeByKey.set(key, representative);
    projectionHelperByName.set(name, {
      representative,
      decode: `decode${representative}`,
      init: `init${representative}`,
      encode: `encode${representative}`,
    });
  }
  for (const name of projectionNames) {
    const helper = projectionHelperByName.get(name);
    if (!helper) throw new Error(`Generated projection helper is missing: ${name}`);
    if (helper.representative !== name) continue;
    const expressions = emitProjectionExpressions(name);
    if (expressions.decode.includes('convertModelField(') || expressions.encode.includes('convertModelField(')) conversionHelpers.add('field');
    projectionExpressions.set(name, expressions);
  }
  const localEmissions = local.map((specification) => {
    const definition = definitions[specification.name];
    // Phantom tag members are part of the type-level intersection and must
    // remain in the root descriptor, but they are not model fields.  Emitting
    // them would make conversion look for descriptors that intentionally do
    // not exist.
    const fields = checker.getPropertiesOfType(specification.fieldsType).filter((field) =>
      definition.kind === 'object'
        ? Object.prototype.hasOwnProperty.call(definition.properties, field.getName())
        : !field.getName().startsWith('__@'),
    );
    const descriptors = definition.kind === 'object'
      ? new Map(Object.entries(definition.properties))
      : fieldDescriptors(checker, specification, descriptorBuilder(checker, specifications, manifestIndex, profile.validation, profile.allowAny ?? false, identityRoot), fields);
    return { specification, fields, descriptors };
  });
  const wrapRootConversion = (
    direction: 'serialize' | 'deserialize',
    field: string,
    input: string,
    converted: string,
  ): string => {
    if (converted === input) return converted;
    conversionHelpers.add('field');
    return `convertModelField(${JSON.stringify(direction)}, ${field}, () => (${converted}))`;
  };
  const importedModelNames = new Set([...concreteNames.values(), ...externalNames.values()]);
  let absentFieldName = '__runicAbsentField';
  while (importedModelNames.has(absentFieldName)) absentFieldName += '_';
  const rootFieldExpressions = new Map<string, {
    readonly encode: readonly string[];
    readonly decode: readonly string[];
    readonly init: readonly string[];
  }>();
  for (const { specification, fields, descriptors } of localEmissions) {
    const encode = fields.map((field) => {
      const name = JSON.stringify(field.getName());
      const input = `model[${name}]`;
      const descriptor = descriptors.get(field.getName());
      if (!descriptor) throw new Error(`Missing descriptor for field ${field.getName()}.`);
      const expression = emitModelToJSON(
        descriptor,
        input,
        (id) => projectionNames.has(id) ? resolveProjection(id)
          : siblingObjectNames.has(id) ? resolveSiblingObject(id)
          : localNames.has(id)
            ? { className: `${id}Base`, discriminators: discriminators(id), encode: (value: string) => `encodeGeneratedModel(${value})` }
            : resolveToJsonModel(externalNames, id),
        {
          deserialize: (_id, value) => value,
          serialize: (id, value) => serdeExpression(id, 'serialize', value),
        },
      );
      const converted = wrapRootConversion('serialize', name, input, expression);
      // Wire output omits an optional field whose value is undefined, as stringify and JSON.stringify do.
      const present = (field.flags & ts.SymbolFlags.Optional) !== 0
        ? `Object.prototype.hasOwnProperty.call(model, ${name}) && ${input} !== undefined`
        : `Object.prototype.hasOwnProperty.call(model, ${name})`;
      return `    [${name}]: ${present} ? (${converted}) : ${absentFieldName},`;
    });
    const decode: string[] = [];
    const init: string[] = [];
    for (const field of fields) {
      const name = JSON.stringify(field.getName());
      const input = `values[${name}]`;
      const descriptor = descriptors.get(field.getName());
      if (!descriptor) throw new Error(`Missing descriptor for field ${field.getName()}.`);
      const fromJson = emitModelFromJSON(
        descriptor,
        input,
        resolveFromAny,
        {
          deserialize: (id, value) => serdeExpression(id, 'deserialize', value),
          serialize: (_id, value) => value,
        },
      );
      const fromInit = emitModelFromInit(descriptor, input, resolveFromAny);
      if (fromJson !== input) {
        conversionHelpers.add('define');
        decode.push(`  if (Object.prototype.hasOwnProperty.call(values, ${name})) defineModelProperty(result, ${name}, ${wrapRootConversion('deserialize', name, input, fromJson)});`);
      }
      conversionHelpers.add('define');
      init.push(`    if (Object.prototype.hasOwnProperty.call(values, ${name})) defineModelProperty(this, ${name}, ${fromInit});`);
    }
    rootFieldExpressions.set(specification.name, { encode, decode, init });
  }
  const hasDate = Object.values(definitions).some((descriptor) => {
    const visit = (item: ModelConversionDescriptor): boolean => {
      if (item.kind === 'date') return true;
      const rich = richDescriptor(item);
      if (rich.serde?.wireDescriptor && visit(rich.serde.wireDescriptor)) return true;
      if (item.kind === 'array') return visit(item.item);
      if (item.kind === 'tuple') return item.items.some(visit) || Boolean(item.rest && visit(item.rest.item));
      if (item.kind === 'union' || item.kind === 'intersection') return item.variants.some(visit);
      if (item.kind === 'object') return Object.values(item.properties).some(visit) || (typeof item.additionalProperties === 'object' && visit(item.additionalProperties));
      return false;
    };
    return visit(descriptor);
  });

  const anyCodecValidation = [...schemaGraph.nodes.values()].some(
    (node) => node.kind !== 'reference' && node.validationEnabled !== false,
  );
  const lines: string[] = ['/* Generated by @exprtlabs/golem-model. Do not edit. */'];
  lines.push(
    'import {',
    '  registerGeneratedModel,',
    '  type GeneratedModel,',
    '  type GeneratedModelConstructor,',
    '  type generatedModelWireBrand,',
    '  type generatedModelFieldsBrand,',
    ...(externalIds.length ? ['  type GeneratedModelWire,'] : []),
    "} from '@exprtlabs/golem/model';",
  );
  const needsGeneratedDecode = externalIds.length > 0 || referenceNames.size > 0;
  const needsGeneratedEncode = needsGeneratedDecode;
  conversionHelpers.add('define');
  const conversionImports = [
    'cloneConversionInput',
    ...(needsGeneratedDecode ? ['decodeGeneratedModelTrusted'] : []),
    ...(needsGeneratedEncode ? ['encodeGeneratedModel'] : []),
    ...(conversionHelpers.has('field') ? ['convertModelField'] : []),
    ...(conversionHelpers.has('define') ? ['defineModelProperty'] : []),
    // Tagged union dispatch rejects unknown tags; the import is pruned when unused.
    'unknownDiscriminatorValue',
    'withDiscriminatorValue',
    'jsonWithDiscriminator',
    'requireModelObject',
  ];
  if (conversionImports.length) {
    lines.push(`import { ${conversionImports.join(', ')} } from '@exprtlabs/golem/conversion';`);
  }
  if (hasDate) lines.push("import { deserializeDate, serializeDate } from '@exprtlabs/golem/conversion';");
    lines.push("import { addNestedCodecSchema, ajvIssues, createObjectCodec, lazyAjvSchema, parseJson, registerIModelClass, requireAjvSchema, requireIModelClass, requireObjectCodec, resolveGeneratedModelSchemaRefs, resolveModelValidationContextValidator, runSynchronousValidation, serdeValidates, stringifyJsonArray, stringifyJsonBoolean, stringifyJsonNumber, stringifyJsonScalar, stringifyJsonString, validationFailure, validationUnavailable, IssueRepresentation, IssueSource } from '@exprtlabs/golem/serde';");
  if (anyCodecValidation && !shared?.validationSetName) lines.push("import { createOpenApiSyncAjvEngine } from '@exprtlabs/golem/ajv';");
  if (anyCodecValidation && profile.mobx) lines.push("import { enhanceValidatorWithMobX } from '@exprtlabs/golem/mobx-validation';");
  lines.push(
    // A sibling companion registers the codecs this module references by id.
    ...[...new Set(graph.siblings.map((item) => sourceImportPath(generatedFilename(item.sourceFile.fileName), output)))]
      .sort()
      .map((path) => `import ${JSON.stringify(path)};`),
    ...localImports.map((item) => `import { ${item.name}Base, type ${item.name}JSON, type ${item.name}Init } from ${JSON.stringify(sourceImportPath(generatedFilename(item.sourceFile.fileName), output))};`),
    ...siblingObjects.map((item) => {
      const codecId = siblingObjectCodecId(item.name);
      const helpers = (['decode', 'init', 'encode'] as const).map((kind) => objectHelperExportName(kind, codecId));
      return `import { type ${item.name}Fields, type ${item.name}JSON, type ${item.name}Init, ${helpers.join(', ')} } from ${JSON.stringify(sourceImportPath(generatedFilename(item.sourceFile.fileName), output))};`;
    }),
    ...localImports
      .filter((item) => !cyclicSiblings?.has(item.name))
      .filter((item) => classModelNames.has(item.name) || (referenceNames.has(item.name) && concreteNames.has(item.name)))
      .map((item) => `import { ${concreteNames.get(item.name) ?? item.name} } from ${JSON.stringify(sourceImportPath(item.sourceFile.fileName, output))};`),
    // Same-file nested class fields look up `requireIModelClass(id)` at decode
    // time. This module never imports the handwritten class (ESM TDZ if the user
    // file extends this companion). The ttsc plugin registers the class under
    // the hashed codec id after the handwritten module finishes evaluating.
    // Cross-file class fields import the class.
    ...(shared ? (() => {
      const names = [
        ...(serdeBindings.length > 0 ? ['modelSerdeBindings'] : []),
        ...(validationBindings.length > 0 && !shared.validationSetName ? ['modelValidationBindings'] : []),
        ...(shared.validationSetName ? [shared.validationSetName] : []),
      ];
      return names.length
        ? [`import { ${names.join(', ')} } from ${JSON.stringify(sourceImportPath(shared.modulePath, output))};`]
        : [];
    })() : []),
    ...externalIds.map((id) => {
      const model = manifestIndex.byId.get(id);
      if (!model) throw new Error(`Generated model manifest id is missing: ${id}`);
      const exported = model.generated.export;
      const localName = externalNames.get(id);
      if (!localName) throw new Error(`Generated model manifest id is missing: ${id}`);
      const binding = exported === localName ? exported : `${exported} as ${localName}`;
      const short = codecShortName(id);
      return `import { ${binding}, ${stringifyFunctionName(short)}, ${fromWireFunctionName(short)}, ${toWireFunctionName(short)} } from ${JSON.stringify(sourceImportPath(model.generatedFile, output))};`;
    }),
    ...(!shared ? validationBindings.map((binding) => `import { ${binding.exportName} as ${bindingNames.get(binding.id)} } from ${JSON.stringify(sourceImportPath(binding.module, output))};`) : []),
    ...(!shared ? serdeBindings.flatMap((binding) => {
      const names = serdeNames.get(binding.id);
      return [
        `import { ${binding.serialize.exportName} as ${names?.serialize}Source } from ${JSON.stringify(sourceImportPath(binding.serialize.module, output))};`,
        `import { ${binding.deserialize.exportName} as ${names?.deserialize}Source } from ${JSON.stringify(sourceImportPath(binding.deserialize.module, output))};`,
      ];
    }) : []),
    '',
  );
  if (validationBindings.length > 0 && !shared) {
    lines.push(
      'const modelValidationBindings = Object.freeze({',
      ...validationBindings.map((binding) => `  ${JSON.stringify(binding.id)}: (value: unknown): boolean | string => ((${bindingNames.get(binding.id)}) as (value: unknown) => boolean | string)(value),`),
      '});',
      '',
    );
  }
  if (serdeBindings.length > 0 && !shared) {
    lines.push(
      ...serdeBindings.flatMap((binding) => {
        const names = serdeNames.get(binding.id);
        return names ? [
          `const ${names.serialize} = (value: unknown): unknown => ((${names.serialize}Source) as (value: unknown) => unknown)(value);`,
          `const ${names.deserialize} = (value: unknown): unknown => ((${names.deserialize}Source) as (value: unknown) => unknown)(value);`,
        ] : [];
      }),
      '',
    );
  }
  if (localEmissions.some(({ fields }) => fields.length > 0)) lines.push(
    `const ${absentFieldName} = Symbol();`,
    '',
  );
  lines.push(
    'function modelObject(json: unknown, name: string): Record<string, unknown> {',
    '  return requireModelObject(json, name);',
    '}',
    '',
  );
  for (const name of projectionNames) {
    const descriptor = definitions[name];
    const helper = projectionHelperByName.get(name);
    if (!helper) throw new Error(`Generated projection helper is missing: ${name}`);
    const representative = helper.representative;
    const expressions = representative === name ? projectionExpressions.get(name) : undefined;
    if (representative === name && !expressions) throw new Error(`Generated projection expressions are missing: ${name}`);
    const fieldsType = representative === name
      ? descriptorType(descriptor, 'model', localNames, externalNames)
      : `${representative}Fields`;
    const jsonType = representative === name
      ? descriptorType(descriptor, 'wire', localNames, externalNames)
      : `${representative}JSON`;
    const initType = representative === name
      ? descriptorType(descriptor, 'init', localNames, externalNames)
      : `${representative}Init`;
    const exported = objectOnlyNames.has(name) ? 'export ' : '';
    lines.push(
      `${exported}type ${name}Fields = ${fieldsType};`,
      `${exported}type ${name}JSON = ${jsonType};`,
      `${exported}type ${name}Init = ${initType};`,
      ...(expressions ? [
        `function decode${name}(value: unknown): ${name}Fields { const data = modelObject(value, ${JSON.stringify(name)}); return (${expressions.decode}) as ${name}Fields; }`,
        `function init${name}(value: unknown): ${name}Fields { const data = modelObject(value, ${JSON.stringify(name)}); return (${expressions.init}) as ${name}Fields; }`,
        `function encode${name}(value: unknown): ${name}JSON { const data = value as Record<string, unknown>; return (${expressions.encode}) as ${name}JSON; }`,
      ] : []),
      '',
    );
  }
  // Another companion converts these object-only models with their helpers.
  for (const name of objectOnlyNames) {
    if (!fileLocalNames.has(name)) continue;
    const codecId = schemaGraph.nodeFor(definitions[name] ?? { kind: 'unknown' }, name)?.codecId;
    const representative = projectionHelperByName.get(name)?.representative;
    if (!codecId || !representative || !referencedObjectCodecIds?.has(codecId)) continue;
    lines.push(
      `export { decode${representative} as ${objectHelperExportName('decode', codecId)}, init${representative} as ${objectHelperExportName('init', codecId)}, encode${representative} as ${objectHelperExportName('encode', codecId)} };`,
      '',
    );
  }
  for (const { specification, fields } of localEmissions) {
    const fieldNames = fields.map((field) => field.getName());
    const collision = fieldNames.find((name) => RESERVED_MODEL_MEMBERS.includes(name));
    if (collision) {
      throw new Error(`Model ${specification.name} field "${collision}" collides with a generated API member.`);
    }
    const baseName = `${specification.name}Base`;
    const fieldsName = `${specification.name}Fields`;
    const definition = definitions[specification.name] ?? { kind: 'unknown' } as ModelConversionDescriptor;
    const fieldType = descriptorType(definition, 'model', localNames, externalNames);
    const initType = descriptorType(definition, 'init', localNames, externalNames);
    const fieldExpressions = rootFieldExpressions.get(specification.name);
    if (!fieldExpressions) throw new Error(`Generated model field expressions are missing: ${specification.name}`);
    const encodeFields = fieldExpressions.encode;
    const decodeFields = fieldExpressions.decode;
    const initFields = fieldExpressions.init;
    if (!specification.emitClass) {
      continue;
    }
    lines.push(
      `export type ${fieldsName} = ${fieldType};`,
      `export type ${specification.name}JSON = ${descriptorType(definition, 'wire', localNames, externalNames)};`,
      `export type ${specification.name}Init = Partial<${initType}>;`,
      '',
      `export abstract class ${baseName} implements GeneratedModel<${specification.name}JSON, ${fieldsName}> {`,
      `  declare readonly [generatedModelWireBrand]: ${specification.name}JSON;`,
      `  declare readonly [generatedModelFieldsBrand]: ${fieldsName};`,
      ...fields.map((field) => {
        const optional = (field.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
        return `  declare ${definition.kind === "object" && definition.readonlyProperties?.includes(field.getName()) ? "readonly " : ""}${propertyName(field.getName())}${optional}: ${fieldsName}[${JSON.stringify(field.getName())}];`;
      }),
      '',
      `  public constructor(${fields.length ? 'values' : '_values'}: ${specification.name}Init = {}) {`,
      ...initFields,
      '  }',
      '',
    );
    lines.push(
      '}',
      '',
      `function decode${specification.name}Model(constructor: GeneratedModelConstructor, json: unknown): ${baseName} {`,
      `  const values = modelObject(json, ${JSON.stringify(baseName)});`,
      ...(decodeFields.length
        ? [
          '  const result: Record<string, unknown> = { ...values };',
          ...decodeFields,
          `  return Reflect.construct(constructor, [result]) as ${baseName};`,
        ]
        : [
          `  return Reflect.construct(constructor, [values]) as ${baseName};`,
        ]),
      '}',
      '',
      `function encode${specification.name}Model(${encodeFields.length > 0 ? 'model' : '_model'}: ${baseName}): ${specification.name}JSON {`,
      '  const result: Record<string, unknown> = {',
      ...encodeFields,
      '  };',
      // Keep absent fields distinct from present undefined values. Computed
      // literal keys define own data properties without inherited setters.
      ...fieldNames.map((name) => `  if (result[${JSON.stringify(name)}] === ${absentFieldName}) delete result[${JSON.stringify(name)}];`),
      `  return result as ${specification.name}JSON;`,
      '}',
      '',
      `registerGeneratedModel(${baseName}, {`,
      `  fields: [${fieldNames.map((name) => JSON.stringify(name)).join(', ')}],`,
      '  conversion: {',
      `    decode: (value, constructor) => decode${specification.name}Model(constructor ?? ${baseName}, value),`,
      `    encode: encode${specification.name}Model,`,
      '  },',
      `  codecId: ${JSON.stringify(schemaGraph.nodeFor(definition, specification.name)?.codecId ?? specification.name)},`,
      `  profile: { validation: ${(specification.validation ?? profile.validation) ? 'true' : 'false'}, mobx: ${profile.mobx ? 'true' : 'false'} },`,
      ...((specification.validation ?? profile.validation) && profile.mobx ? ['  enhanceValidator: enhanceValidatorWithMobX,'] : []),
      '});',
      '',
      `registerIModelClass(${JSON.stringify(
        schemaGraph.nodeFor(definition, specification.name)?.codecId ?? specification.name,
      )}, ${baseName});`,
      '',
    );
  }
  const nestedConstruct = (name: string): string => {
    const node = [...schemaGraph.nodes.values()].find((item) => item.codecId === name || item.name === name);
    const short = node?.name ?? name;
    const id = node?.codecId ?? name;
    const cls = concreteNames.get(short);
    if (cls && localImports.some((item) => item.name === short)) return cls;
    return `requireIModelClass(${JSON.stringify(id)})`;
  };
  const nestedGenerated = (id: string): string => {
    const className = externalNames.get(id);
    if (!className) throw new Error(`Generated model manifest id is missing: ${id}`);
    return className;
  };
  const nestedImportedSerde = (id: string) => {
    const match = [...externalNames.entries()].find(([manifestId, className]) => (
      manifestId === id
      || className === id
      || codecShortName(manifestId) === id
    ));
    if (!match) return undefined;
    const short = codecShortName(match[0]);
    return {
      stringify: stringifyFunctionName(short),
      fromWire: fromWireFunctionName(short),
      toWire: toWireFunctionName(short),
    };
  };
  const codecRuntime = emitCodecRuntime(
    schemaGraph,
    {
      validationBindingsExpr: validationBindings.length > 0 ? 'modelValidationBindings' : '{}',
      validationEnabled: profile.validation,
      validatorSetExpr: shared?.validationSetName,
      serde: {
        deserialize: (id, value) => serdeExpression(id, 'deserialize', value),
        serialize: (id, value) => serdeExpression(id, 'serialize', value),
      },
      nestedConstruct,
      nestedGenerated,
      nestedImportedSerde,
      wireType: (node) => Object.hasOwn(definitions, node.name) || localNames.has(node.name) ? `${node.name}JSON` : undefined,
      ...(siblingWireCodecIds ? { siblingWireCodecIds } : {}),
      ...(referencedWireCodecIds ? { exportedWireStringifyIds: referencedWireCodecIds } : {}),
    },
  );
  lines.push(codecRuntime);
  // Wire stringify functions of sibling codecs this module writes.
  const siblingWireImports = [...schemaGraph.nodes.values()].flatMap((node) => {
    const name = wireStringifyExportName(node.codecId);
    const sibling = node.siblingCodec ? graph.siblings.find((item) => item.name === node.name) : undefined;
    return sibling && codecRuntime.includes(name)
      ? [`import { ${name} } from ${JSON.stringify(sourceImportPath(generatedFilename(sibling.sourceFile.fileName), output))};`]
      : [];
  });
  lines.splice(1, 0, ...siblingWireImports);
  const companion = pruneExternalCodecImports(pruneNamedImport(
    pruneNamedImport(
      pruneNamedImport(`${lines.join('\n').trim()}\n`, '@exprtlabs/golem/serde'),
      '@exprtlabs/golem/ajv',
    ),
    '@exprtlabs/golem/conversion',
  ));
  assertExternalImportsExported(companion, externalIds, manifestIndex, source, output);
  return companion;
}

/**
 * A companion imports the model class and its codec helpers from each SDK module.
 * Reject the generation when that module lacks one, so no uncompilable companion is written.
 */
function assertExternalImportsExported(
  companion: string,
  externalIds: readonly string[],
  manifestIndex: ManifestIndex,
  source: string,
  output: string,
): void {
  const checked = new Set<string>();
  for (const id of externalIds) {
    const model = manifestIndex.byId.get(id);
    if (!model || checked.has(model.generatedFile)) continue;
    checked.add(model.generatedFile);
    const from = JSON.stringify(sourceImportPath(model.generatedFile, output));
    const exports = manifestIndex.runtimeExports(model);
    const imported = [...companion.matchAll(/^import \{([^}]+)\} from ("(?:\\.|[^"])+");$/gm)]
      .filter((match) => match[2] === from)
      .flatMap((match) => match[1].split(','))
      .map((specifier) => specifier.trim().split(/\s+as\s+/)[0].trim())
      .filter((name) => name.length > 0);
    const missing = [...new Set(imported.filter((name) => !exports.has(name)))];
    if (missing.length > 0) {
      throw new Error(
        `${source}: generated model module ${model.generated.module} (model manifest ${model.manifestFile}) `
        + `does not export ${missing.join(', ')}. Regenerate the SDK so it exports the model class and its codec helpers.`,
      );
    }
  }
}

function specifierLocalName(specifier: string): string {
  let name = specifier.trim();
  if (name.startsWith('type ')) name = name.slice('type '.length).trim();
  const alias = name.split(/\s+as\s+/);
  return (alias.length === 2 ? alias[1] : name).trim();
}

/** Drop codec helpers an external model import never calls. Keep the class when the body uses it. */
function pruneExternalCodecImports(source: string): string {
  return source.replace(
    /import \{([^}]+)\} from ("(?:\\.|[^"])+");\n?/g,
    (statement, names: string) => {
      const specifiers = names.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
      const importsCodecHelper = specifiers.some((name) => /^(?:stringify|fromWireFormat|toWireFormat)/.test(specifierLocalName(name)));
      if (!importsCodecHelper) return statement.endsWith('\n') ? statement : `${statement}\n`;
      const body = source.split(statement).join('');
      const used = specifiers.filter((name) => {
        const local = specifierLocalName(name);
        return local.length > 0 && new RegExp(`\\b${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body);
      });
      if (used.length === 0) return '';
      const from = statement.slice(statement.lastIndexOf(' from ') + ' from '.length).replace(/;\n?$/, '');
      return `import { ${used.join(', ')} } from ${from};\n`;
    },
  );
}
