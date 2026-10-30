import { assertImportableClassName, deduplicateProjections, exportedConcreteClass, isGeneratedBrandKey, isGolemTagKey, linkedClassNames } from '@exprtlabs/golem/internal/type-analysis';
import * as ts from '@exprtlabs/golem/internal/ts';
import { PACKAGE_VERSION } from './package-info.js';
import {
  emitModelFromJSON,
  blockComment,
  isCode,
  runtimeLinesOf,
  MODEL_IMPORT_ORDER,
  wrapRootConversion,
  type Piece,
  code,
  emitCodecRuntimeCode,
  fileImports,
  helper,
  helperName,
  bindInput,
  identifier,
  inputOf,
  inputSlot,
  MODULE_CONSTANT_HELPERS,
  placeHelpers,
  ImportSource,
  join,
  literal,
  localCode,
  propertyKey,
  rt,
  rtType,
  sameCode,
  render,
  fromWireFunctionName,
  stringifyFunctionName,
  toWireFunctionName,
  type Code,
  type Helper,
  type ImportOptions,
  type JsonValue,
  emitModelFromInit,
  wireStringifyExportName,
  TEMPORAL_SERDE,
  TEMPORAL_SERDE_PREFIX,
  descriptorNeedsConversion,
  type FromJsonModelResolver,
  type ModelConversionDescriptor,
  type NestedImportedSerde,
  type SerdeResolver,
  presentKeysCode,
} from '@exprtlabs/golem/internal/emitter';
import { anonymousShapeKeys, createSchemaGraph, codecPublicId, codecShortName, internDescriptors, mapNamedTypes, type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import { compareText, type GolemProfile } from '@exprtlabs/golem/generator-api';
import { displayPath, RESERVED_MODEL_MEMBERS } from '@exprtlabs/golem/internal/generator-support';
import type { ManifestIndex } from '@exprtlabs/golem/internal/type-analysis';
import type { ModelBoundary, ModelSpecification } from '@exprtlabs/golem/internal/type-analysis';
import { descriptorBuilder, describeRootKind, nonObjectRootDiagnostic, propertyType } from '@exprtlabs/golem/internal/type-analysis';
import {
  canonicalFilename,
  commonDirectory,
  companionOfSpecification,
  portableRelativeFilename,
  projectFilesImportedBy,
  sourceImportPath,
} from '@exprtlabs/golem/internal/type-analysis';
import type {
  ModelConstraint,
  SerdeBinding,
  ValidationBinding,
} from '@exprtlabs/golem/internal/type-analysis';
import {
  canonicalSchemaKey,
  canonicalConstraintKey,
  constraintSchemaValues,
  createExecutableValidationMemo,
  isBrandDescriptor,
  mapConstraintSchemaValues,
  projectPortableConstraints,
  type ExecutableValidationMemo,
  schemaForDescriptor,
  validationTagSchemaDescriptor,
  VALIDATION_KEYWORD,
} from '@exprtlabs/golem/internal/schema';

type RichDescriptor = ModelConversionDescriptor & {
  readonly validations?: readonly ValidationBinding[];
  readonly serde?: SerdeBinding & { readonly wireDescriptor?: ModelConversionDescriptor };
  readonly constraints?: readonly ModelConstraint[];
  readonly date?: true;
};

function richDescriptor(descriptor: ModelConversionDescriptor): RichDescriptor {
  return descriptor as RichDescriptor;
}

function bindingImportPath(binding: { readonly module: string; readonly specifier?: string }, output: string): string {
  return binding.specifier ?? sourceImportPath(binding.module, output);
}

function isModelDescriptor(value: unknown): value is ModelConversionDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'kind') === 'string';
}

function mapConstraint(
  constraint: ModelConstraint,
  validationEnabled: boolean,
  wire: boolean,
  retainPredicates: boolean,
  definitions: Readonly<Record<string, ModelConversionDescriptor>>,
): ModelConstraint {
  if (!validationEnabled) return constraint;
  return mapConstraintSchemaValues(constraint, (value) =>
    isModelDescriptor(value) ? projectDescriptor(value, validationEnabled, wire, retainPredicates, definitions) : value);
}

/**
 * What a walk reaches below a descriptor: `structure` is the items, variants and properties; `wire` adds the wire
 * descriptor of a serde; `all` adds the schemas of the constraints.
 */
type DescriptorReach = 'structure' | 'wire' | 'all';

interface DescriptorVisitor {
  /** Runs on a descriptor before the descriptors below it. */
  readonly enter?: (descriptor: ModelConversionDescriptor) => void;
  /** Runs on a descriptor after the descriptors below it. */
  readonly leave?: (descriptor: ModelConversionDescriptor) => void;
}

/** The one read-only walk over a descriptor tree: below each descriptor it reaches the wire descriptor, then the constraint schemas, then the structure. */
function walkDescriptor(descriptor: ModelConversionDescriptor, visitor: DescriptorVisitor, reach: DescriptorReach = 'all'): void {
  const rich = richDescriptor(descriptor);
  const walk = (child: ModelConversionDescriptor): void => walkDescriptor(child, visitor, reach);
  visitor.enter?.(descriptor);
  if (reach !== 'structure' && rich.serde?.wireDescriptor) walk(rich.serde.wireDescriptor);
  if (reach === 'all') {
    for (const constraint of rich.constraints ?? []) constraintSchemaValues(constraint).filter(isModelDescriptor).forEach(walk);
  }
  switch (descriptor.kind) {
    case 'array': walk(descriptor.item); break;
    case 'tuple':
      descriptor.items.forEach(walk);
      if (descriptor.rest) walk(descriptor.rest.item);
      break;
    case 'union':
    case 'intersection': descriptor.variants.forEach(walk); break;
    case 'object':
      Object.values(descriptor.properties).forEach(walk);
      if (typeof descriptor.additionalProperties === 'object') walk(descriptor.additionalProperties);
      break;
    default: break;
  }
  visitor.leave?.(descriptor);
}

interface BindingRegistry {
  readonly validations: Map<string, ValidationBinding>;
  readonly serde: Map<string, SerdeBinding>;
}

/** An id names one function: a path from the project root, or a package import. A second binding with the id is the same function reached again, so the first stays. */
function registerValidation(bindings: Map<string, ValidationBinding>, binding: ValidationBinding): void {
  if (!bindings.has(binding.id)) bindings.set(binding.id, binding);
}

function registerSerde(bindings: Map<string, SerdeBinding>, binding: SerdeBinding): void {
  // A `temporal:` id names a codec of the runtime: there is no function of the user's to import, and `serdeExpression` calls the codec itself.
  if (binding.id.startsWith(TEMPORAL_SERDE_PREFIX)) return;
  if (!bindings.has(binding.id)) bindings.set(binding.id, binding);
}

function visitDescriptor(
  descriptor: ModelConversionDescriptor,
  registry: BindingRegistry,
): void {
  walkDescriptor(descriptor, {
    enter: (item) => {
      const rich = richDescriptor(item);
      for (const binding of rich.validations ?? []) registerValidation(registry.validations, binding);
      if (rich.serde) registerSerde(registry.serde, rich.serde);
    },
  });
}

/** A validation schema of a tag and its canonical key: schemas with one key share one compiled validator. */
export interface TagSchema {
  readonly key: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

interface TagSchemaCompilation {
  readonly id: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/**
 * Give each distinct schema one id, in the order of its canonical key. Callback
 * identities and closed reference definitions are part of that key, so
 * equivalent schemas share a compiler while distinct executable or reference
 * semantics stay separate.
 */
export function deduplicateTagSchemas(
  schemas: readonly TagSchema[],
): readonly TagSchemaCompilation[] {
  const byKey = new Map<string, Readonly<Record<string, unknown>>>();
  for (const { key, schema } of schemas) if (!byKey.has(key)) byKey.set(key, schema);
  return [...byKey.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, schema], index) => ({ id: `golem:model-tag:${index}`, schema }));
}

function tagSchemas(
  descriptors: readonly ModelConversionDescriptor[],
  enabled: boolean,
  definitions: Readonly<Record<string, ModelConversionDescriptor>> = {},
  representation: 'model' | 'wire' = 'model',
): readonly TagSchema[] {
  if (!enabled) return [];
  const schemas = new Map<string, Readonly<Record<string, unknown>>>();
  const register = (schema: Readonly<Record<string, unknown>>): void => {
    const key = canonicalSchemaKey(schema);
    if (!schemas.has(key)) schemas.set(key, schema);
  };
  const schemaOptions = { definitions };
  const registerTags = (descriptor: ModelConversionDescriptor): void => {
    const rich = richDescriptor(descriptor);
    const constraints = [...(rich.constraints ?? [])].sort((left, right) =>
      compareText(canonicalConstraintKey(left), canonicalConstraintKey(right)));
    const validations = [...(rich.validations ?? [])]
      .map((binding) => typeof binding === 'string' ? binding : (binding as ValidationBinding).id).sort();
    if (constraints.length > 0) {
      // Keep structural siblings in the same schema context as object and
      // array keywords. In particular, `additionalProperties` must see the
      // descriptor's declared properties, and contains bounds must remain
      // siblings of contains.
      const structural = schemaForDescriptor(
        validationTagSchemaDescriptor(descriptor, constraints, { definitions }),
        { ...schemaOptions, representation, executableBindings: true },
      );
      register(typeof structural === 'boolean' ? { allOf: [structural] } : structural);
    }
    if (validations.length > 0) register({ [VALIDATION_KEYWORD]: validations });
  };
  descriptors.forEach((descriptor) => walkDescriptor(descriptor, { enter: registerTags }, 'structure'));
  return [...schemas.entries()].map(([key, schema]) => ({ key, schema }));
}

/**
 * TypeScript brands are commonly expressed as an intersection such as `string & { readonly __wireCode?: never }`. The
 * brand carries no wire data and must not turn a scalar JSON value into an impossible allOf of a scalar and an object.
 * The scalar of such an intersection; a genuine object intersection has none.
 */
function brandedScalar(descriptor: ModelConversionDescriptor): ModelConversionDescriptor | undefined {
  if (descriptor.kind !== 'intersection') return undefined;
  const scalar = descriptor.variants.find((item) =>
    item.kind === 'string' || item.kind === 'number' || item.kind === 'boolean' || item.kind === 'null',
  );
  return scalar && descriptor.variants.every((item) => item === scalar || isBrandDescriptor(item)) ? scalar : undefined;
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
  if (wire && descriptor.kind === 'date') {
    return {
      kind: 'string',
      ...(validationEnabled ? { constraints: [{ kind: 'format', value: 'date-time' }] } : {}),
    } as ModelConversionDescriptor;
  }
  const project = (item: ModelConversionDescriptor): ModelConversionDescriptor =>
    projectDescriptor(item, validationEnabled, wire, retainPredicates, definitions);
  const scalar = wire ? brandedScalar(descriptor) : undefined;
  let projected: ModelConversionDescriptor;
  if (scalar) projected = project(scalar);
  else switch (descriptor.kind) {
    case 'array': projected = {
      kind: 'array',
      ...(descriptor.isReadonly ? { isReadonly: true as const } : {}),
      item: project(descriptor.item),
    }; break;
    case 'tuple':
      projected = {
        kind: 'tuple',
        ...(descriptor.isReadonly ? { isReadonly: true as const } : {}),
        items: descriptor.items.map(project),
        ...(descriptor.optionalFrom === undefined ? {} : { optionalFrom: descriptor.optionalFrom }),
        ...(descriptor.rest ? {
          rest: { index: descriptor.rest.index, item: project(descriptor.rest.item) },
        } : {}),
      };
      break;
    case 'union': projected = {
      kind: 'union',
      variants: descriptor.variants.map(project),
      // Variants map one to one, so the tag table keeps its indexes.
      ...(descriptor.discriminator ? { discriminator: descriptor.discriminator } : {}),
    }; break;
    case 'intersection': projected = { kind: 'intersection', variants: descriptor.variants.map(project) }; break;
    case 'object':
      projected = {
        kind: 'object',
        ...(descriptor.projection ? { projection: true as const } : {}),
        ...(descriptor.readonlyProperties ? { readonlyProperties: descriptor.readonlyProperties } : {}),
        properties: Object.fromEntries(Object.entries(descriptor.properties).map(([name, item]) => [name, project(item)])),
        required: descriptor.required,
        additionalProperties: typeof descriptor.additionalProperties === 'object'
          ? project(descriptor.additionalProperties)
          : descriptor.additionalProperties,
        ...(descriptor.additionalPropertiesDeclared ? { additionalPropertiesDeclared: true as const } : {}),
      };
      break;
    // `typeImport` is an absolute path used only while emitting imports; generated data keeps the name.
    case 'class-value': projected = { kind: 'class-value', typeName: descriptor.typeName } as ModelConversionDescriptor; break;
    default: projected = { kind: descriptor.kind, ...('value' in descriptor ? { value: descriptor.value } : {}), ...('name' in descriptor ? { name: descriptor.name } : {}), ...('id' in descriptor ? { id: descriptor.id } : {}), ...('projection' in descriptor && descriptor.projection ? { projection: true } : {}), ...('construct' in descriptor && descriptor.construct ? { construct: true as const } : {}) } as ModelConversionDescriptor;
  }
  const normalizedConstraints = validationEnabled
    ? constraints.map(constraint => mapConstraint(constraint, validationEnabled, wire, retainPredicates, definitions))
      .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)))
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

/** Identifies an imported class across descriptors: its module (or package specifier) and export name. */
function classImportKey(typeImport: { readonly exportName: string; readonly module: string; readonly specifier?: string }): string {
  return `${typeImport.specifier ?? typeImport.module}\0${typeImport.exportName}`;
}

/** The names a type text takes from other modules, as parts: the file imports the ones its types use. */
interface TypeNames {
  /** The local name of a class a TSerde field names, by `classImportKey`. */
  readonly classValue: (key: string) => Code | undefined;
  /** `<name><suffix>` of a model: imported from the file that holds the model, or this file's own. */
  readonly modelType: (name: string, suffix: 'BaseModel' | 'JSON' | 'Init' | 'Fields') => Code;
  /** `<codec id><suffix>`: the local type of an SDK node that a descriptor names by its codec id. */
  readonly sdkNodeType: (codecId: string, suffix: 'JSON' | 'Init' | 'Fields') => Code;
}

function descriptorType(
  descriptor: ModelConversionDescriptor,
  mode: 'model' | 'wire' | 'init',
  names: TypeNames,
): Code {
  const rich = richDescriptor(descriptor);
  if (mode === 'wire' && rich.serde) {
    return rich.serde.wireDescriptor
      ? descriptorType(rich.serde.wireDescriptor, 'wire', names)
      : code`unknown`;
  }
  if (mode === 'wire' && descriptor.kind === 'date') return code`string`;
  if ((mode === 'model' || mode === 'init') && descriptor.kind === 'date') return code`Date`;
  if ((mode === 'model' || mode === 'init') && descriptor.kind === 'class-value') {
    // `Temporal.Instant` imported from a module is `<alias>.Instant`: the import brings in the outermost name.
    const alias = descriptor.typeImport && names.classValue(classImportKey(descriptor.typeImport));
    const path = descriptor.typeName.split('.');
    return join(alias ? [alias, ...path.slice(1).map(identifier)] : path.map(identifier), code`.`);
  }
  switch (descriptor.kind) {
    case 'any': return code`any`;
    case 'unknown': return code`unknown`;
    case 'never': return code`never`;
    case 'string': return code`string`;
    case 'number': return code`number`;
    case 'boolean': return code`boolean`;
    case 'bigint': return code`bigint`;
    case 'null': return code`null`;
    case 'undefined': return code`undefined`;
    case 'literal': return literal(descriptor.value as JsonValue);
    case 'reference':
      if (descriptor.projection) return names.modelType(descriptor.name, mode === 'wire' ? 'JSON' : mode === 'init' ? 'Init' : 'Fields');
      return mode === 'wire'
        ? names.modelType(descriptor.name, 'JSON')
        : mode === 'init'
          ? code`${names.modelType(descriptor.name, 'Init')} | ${names.modelType(descriptor.name, 'BaseModel')}`
          : names.modelType(descriptor.name, 'BaseModel');
    case 'generated-model': return names.sdkNodeType(descriptor.id, mode === 'wire' ? 'JSON' : mode === 'init' ? 'Init' : 'Fields');
    case 'array': return code`${descriptor.isReadonly ? code`ReadonlyArray` : code`Array`}<${descriptorType(descriptor.item, mode, names)}>`;
    case 'tuple': {
      const items = descriptor.items.map((item, index) => {
        const type = descriptorType(item, mode, names);
        return descriptor.optionalFrom !== undefined && index >= descriptor.optionalFrom ? code`(${type})?` : type;
      });
      const readonlyTuple = descriptor.isReadonly ? code`readonly ` : code``;
      if (!descriptor.rest) return code`${readonlyTuple}[${join(items, code`, `)}]`;
      const restType = descriptorType(descriptor.rest.item, mode, names);
      return code`${readonlyTuple}[${join([...items.slice(0, descriptor.rest.index), code`...Array<${restType}>`, ...items.slice(descriptor.rest.index)], code`, `)}]`;
    }
    case 'union': return descriptor.variants.length > 0 ? join(descriptor.variants.map((item) => descriptorType(item, mode, names)), code` | `) : code`never`;
    case 'intersection': return descriptor.variants.length > 0 ? join(descriptor.variants.map((item) => descriptorType(item, mode, names)), code` & `) : code`unknown`;
    case 'object': {
      const properties = Object.entries(descriptor.properties).map(([name, item]) => {
        const optional = descriptor.required.includes(name) ? code`` : code`?`;
        const readonlyProperty = descriptor.readonlyProperties?.includes(name) ? code`readonly ` : code``;
        return code`${readonlyProperty}${propertyKey(name)}${optional}: ${descriptorType(item, mode, names)}`;
      });
      // The values of an additionalProperties tag have no index signature: the authored type has none.
      if (typeof descriptor.additionalProperties === 'object' && !descriptor.additionalPropertiesDeclared) properties.push(code`[key: string]: ${descriptorType(descriptor.additionalProperties, mode, names)}`);
      return code`{ ${join(properties, code`; `)} }`;
    }
  }
  return code`unknown`;
}

function fieldDescriptors(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  describe: (type: ts.Type, context: ModelSpecification, seen?: ReadonlySet<ts.Type>, node?: ts.TypeNode) => ModelConversionDescriptor,
  fields: readonly ts.Symbol[],
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

function descriptorReferences(
  descriptor: ModelConversionDescriptor,
  found = new Set<string>(),
  /** Collect only the references that name a class the app wrote (a field typed `Customer`, not `TCustomer`). */
  throughClass = false,
): Set<string> {
  walkDescriptor(descriptor, {
    leave: (item) => { if (item.kind === 'reference' && (!throughClass || item.construct)) found.add(item.name); },
  });
  return found;
}

function collectReferences(
  descriptor: ModelConversionDescriptor,
  owner: ModelSpecification,
  byName: ReadonlyMap<string, readonly ModelSpecification[]>,
  emitted: ReadonlySet<ModelSpecification>,
  pending: ModelSpecification[],
): void {
  walkDescriptor(descriptor, {
    leave: (item) => {
      if (item.kind !== 'reference') return;
      const candidates = byName.get(item.name) ?? [];
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
          `Ambiguous generated type reference "${item.name}" in ${displayPath(owner.sourceFile.fileName)}.`,
        );
      }
      if (referenced && !emitted.has(referenced)) pending.push(referenced);
    },
  });
}

export interface SourceModelGraph {
  readonly source: string;
  readonly output: string;
  readonly identityRoot: string;
  readonly definitions: Readonly<Record<string, ModelConversionDescriptor>>;
  readonly modelDefinitions: Readonly<Record<string, ModelConversionDescriptor>>;
  readonly wireDefinitions: Readonly<Record<string, ModelConversionDescriptor>>;
  readonly registry: BindingRegistry;
  readonly schemas: readonly TagSchema[];
  /** Every model this companion names: its own, inlined ones, and sibling models. */
  readonly emitted: readonly ModelSpecification[];
  /**
   * Models another source of the same job declares. Their companion
   * emits their code; this companion references them by codec id.
   */
  readonly siblings: readonly ModelSpecification[];
  /** The job's descriptor builder, which describes the fields of a model that is an SDK model's fields. */
  readonly describe: ReturnType<typeof descriptorBuilder>;
}

/** A job's executable-validation memo, keyed by the lookup objects its walks receive. */
const executableMemos = new WeakMap<object, ExecutableValidationMemo>();

/** One job's type analysis: every model is described once, shared by all companions. */
interface JobAnalysis {
  readonly checker: ts.TypeChecker;
  readonly describe: ReturnType<typeof descriptorBuilder>;
  readonly described: Map<ModelSpecification, ModelConversionDescriptor>;
  /** Canonical filenames of the job's model sources. */
  readonly sources: ReadonlySet<string>;
  readonly executableMemo: ExecutableValidationMemo;
  /** The files each file imports or re-exports, by canonical filename; filled as the import graphs are read. */
  readonly directImports: Map<string, readonly string[]>;
  /** The job's model-file suffixes: a model file of a shared package is read through an import. */
  readonly suffixes: readonly string[] | undefined;
  /** The parsed file of a canonical filename, when the program holds it. */
  readonly sourceFileOf: (filename: string) => ts.SourceFile | undefined;
  /**
   * Descriptors of every job model and projection by name, for schema
   * lookups that follow a sibling model's own references. Built once every
   * model is described; names declared twice are left out.
   */
  lookup?: Readonly<Record<string, ModelConversionDescriptor>>;
}

/** The conversion descriptor of a model's fields type, described once per job. */
function describeRoot(job: JobAnalysis, specification: ModelSpecification): ModelConversionDescriptor {
  let descriptor = job.described.get(specification);
  if (!descriptor) {
    descriptor = job.describe(specification.fieldsType, specification, undefined, specification.fieldsNode);
    job.described.set(specification, descriptor);
  }
  return descriptor;
}

/**
 * A model emits the fields of an object. A root that a TSerde converts as a whole, or any other root
 * that is no object, has no fields to emit: it stops with RUNM1052 once its other uses have been described.
 */
function assertRootHasFields(specification: ModelSpecification, definition: ModelConversionDescriptor): void {
  const found = 'serde' in definition ? 'a type that a TSerde converts as a whole'
    : definition.kind === 'object' ? undefined
      : describeRootKind(definition.kind);
  if (found) throw nonObjectRootDiagnostic(specification.sourceFile, specification.declaration, specification.emitClass ? 'IModel' : 'IObject', found);
}

/** Describe every model of the job once and index the results for lookups. */
export function describeJob(job: JobAnalysis, specifications: readonly ModelSpecification[]): void {
  const byName = new Map<string, ModelConversionDescriptor | null>();
  for (const specification of specifications) {
    if (!job.sources.has(canonicalFilename(specification.sourceFile.fileName))) continue;
    const descriptor = describeRoot(job, specification);
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
  profile: GolemProfile,
  sources: readonly string[],
  isDefaultLibraryFile: (file: ts.SourceFile) => boolean,
  identityRoot?: string,
  sourceFileOf?: (filename: string) => ts.SourceFile | undefined,
  boundary?: ModelBoundary,
): JobAnalysis {
  const stableIdentityRoot = canonicalFilename(identityRoot ?? commonDirectory(
    specifications.map((specification) => specification.sourceFile.fileName),
  ));
  const modelSources = new Set(sources.map(canonicalFilename));
  return {
    checker,
    describe: descriptorBuilder(
      checker,
      specifications,
      manifestIndex,
      profile.validation,
      profile.allowAny ?? false,
      stableIdentityRoot,
      true,
      undefined,
      modelSources,
      boundary,
      undefined,
      isDefaultLibraryFile,
    ),
    described: new Map(),
    sources: modelSources,
    executableMemo: createExecutableValidationMemo(),
    directImports: new Map(),
    suffixes: boundary?.suffixes,
    sourceFileOf: sourceFileOf ?? ((filename) => specifications
      .find((specification) => canonicalFilename(specification.sourceFile.fileName) === filename)?.sourceFile),
  };
}

/** The project files a file imports or re-exports. A package, a declaration file and a file the program lacks are left out. */
function directImports(job: JobAnalysis, file: ts.SourceFile): readonly string[] {
  const key = canonicalFilename(file.fileName);
  const known = job.directImports.get(key);
  if (known) return known;
  const imports = projectFilesImportedBy(file, job.checker, job.suffixes);
  job.directImports.set(key, imports);
  return imports;
}

/** Every project file `file` reaches through imports and re-exports, whatever the depth. */
function importedFiles(job: JobAnalysis, file: ts.SourceFile): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [file];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const imported of directImports(job, next)) {
      if (reached.has(imported)) continue;
      reached.add(imported);
      const parsed = job.sourceFileOf(imported);
      if (parsed) pending.push(parsed);
    }
  }
  return reached;
}

/** Build one source graph without emitting application or generated code. */
export function analyzeSourceGraph(
  source: string,
  output: string,
  specifications: readonly ModelSpecification[],
  profile: GolemProfile,
  identityRoot: string | undefined,
  job: JobAnalysis,
): SourceModelGraph | undefined {
  const stableIdentityRoot = canonicalFilename(identityRoot ?? commonDirectory(
    specifications.map((specification) => specification.sourceFile.fileName),
  ));
  const { describe } = job;
  const canonicalSource = canonicalFilename(source);
  const local = specifications.filter((item) => canonicalFilename(item.sourceFile.fileName) === canonicalSource);
  if (local.length === 0) return undefined;
  // A model of another file this source imports is emitted by that file's companion. The import graph is the source's
  // own, so the companion is the same in every app that generates it.
  const imported = importedFiles(job, local[0].sourceFile);
  // A field typed with an app class reaches its model through the class's generated base, and that class file need not import the model file.
  const classModels = new Set<string>();
  const isSibling = (specification: ModelSpecification): boolean => {
    const owner = canonicalFilename(specification.sourceFile.fileName);
    return owner !== canonicalSource && (imported.has(owner) || classModels.has(specification.name));
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
      // A projection can reach a class (`Pick<TOrder, 'customer'>`), so its models count as siblings before they are asked for.
      descriptorReferences(projection, classModels, true);
      collectReferences(projection, owner, byName, emitted, pending);
      collectProjections(projection, owner);
    }
  };
  while (pending.length > 0) {
    const specification = pending.shift();
    if (!specification || emitted.has(specification)) continue;
    const duplicate = [...emitted].find((item) => item.name === specification.name);
    if (duplicate) throw new Error(`Generated model symbol collision for "${specification.name}" in ${displayPath(source)}.`);
    const descriptor = describeRoot(job, specification);
    definitions[specification.name] = descriptor;
    emitted.add(specification);
    if (isSibling(specification)) {
      // Its companion owns its conversion code and nested models.
      siblings.add(specification);
      continue;
    }
    descriptorReferences(descriptor, classModels, true);
    collectReferences(descriptor, specification, byName, emitted, pending);
    collectProjections(descriptor, specification);
  }
  for (const [name, projection] of projections) definitions[name] = projection;
  definitions = deduplicateProjections(definitions, new Set(projections.keys()));
  const owned = Object.fromEntries(Object.entries(definitions).filter(([name]) =>
    ![...siblings].some((sibling) => sibling.name === name)));
  const registry: BindingRegistry = { validations: new Map(), serde: new Map() };
  Object.values(owned).forEach((descriptor) => visitDescriptor(descriptor, registry));
  const ownedSpecifications = [...emitted].filter((specification) => !siblings.has(specification));
  // A model never validates above its project, so a project that does not validate has no model that does.
  const anyDeclValidation = profile.validation !== false && ownedSpecifications.some((specification) => specification.validation !== false);
  if (!anyDeclValidation) registry.validations.clear();
  // Sibling models keep their own references; lookups fall back to the job's descriptors.
  const lookup: Record<string, ModelConversionDescriptor> = Object.assign(
    Object.create(job.lookup ?? null) as Record<string, ModelConversionDescriptor>,
    definitions,
  );
  executableMemos.set(lookup, job.executableMemo);
  const modelDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, descriptor]) => [name, projectDescriptor(descriptor, profile.validation !== false, false, true, lookup)]),
  );
  const wireDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, descriptor]) => [name, projectDescriptor(descriptor, profile.validation !== false, true, false, lookup)]),
  );
  const wireLookup: Record<string, ModelConversionDescriptor> = Object.assign(
    Object.create(job.lookup ?? null) as Record<string, ModelConversionDescriptor>,
    wireDefinitions,
  );
  executableMemos.set(wireLookup, job.executableMemo);
  // The tag schemas serve the validators of this source's models; a source whose models are all off has none, and its
  // validation functions are not imported (`validatorImports`), so a schema that names one could not compile.
  const schemas = !anyDeclValidation ? [] : [
    ...tagSchemas(Object.values(owned), true, lookup, 'model'),
    ...tagSchemas(Object.keys(owned).map((name) => wireDefinitions[name]), true, wireLookup, 'wire'),
  ];
  return {
    source,
    output,
    identityRoot: stableIdentityRoot,
    definitions,
    modelDefinitions,
    wireDefinitions,
    registry,
    schemas,
    emitted: [...emitted],
    siblings: [...siblings],
    describe,
  };
}

interface SourceSchemaGraphOptions {
  /** Job-fixed codec ids by model name, for this source's models and its siblings. */
  readonly codecIds?: ReadonlyMap<string, string>;
  /** Models emitted by another companion of the job. */
  readonly siblings?: readonly ModelSpecification[];
  /** What a model that sets no `validation` does: the validation of the app's profile. */
  readonly defaultValidation?: GolemProfile['validation'];
  /** Codec ids and aliases of models emitted elsewhere that publish residual schemas. */
  readonly externalResidualIds?: { readonly modelOnly: ReadonlySet<string>; readonly wireOnly: ReadonlySet<string> };
  /** Codec ids and aliases of models emitted elsewhere that publish a `#wire` schema. */
  readonly externalWireIds?: ReadonlySet<string>;
  /** The unnamed object types a validating model of another source of the job holds; see `validatedShapeKeys`. */
  readonly validatedShapes?: ReadonlySet<string>;
}

interface SourceEntry {
  readonly name: string;
  readonly descriptor: ModelConversionDescriptor;
  readonly emitClass: boolean;
  readonly validation?: GolemProfile['validation'];
}

/** The models of a source to intern, each with its validation level. */
function sourceEntries(
  definitions: Readonly<Record<string, ModelConversionDescriptor>>,
  emitted: readonly ModelSpecification[],
  options: SourceSchemaGraphOptions,
): SourceEntry[] {
  const siblings = new Set(options.siblings ?? []);
  const interned = new Set<string>();
  const entries: SourceEntry[] = [];
  for (const specification of emitted) {
    interned.add(specification.name);
    const descriptor = definitions[specification.name];
    if (!descriptor) continue;
    entries.push({
      name: specification.name,
      // A sibling is a codec reference: its schema and code come from its companion.
      descriptor: siblings.has(specification) ? { kind: 'reference', name: specification.name } : descriptor,
      emitClass: siblings.has(specification) ? false : specification.emitClass,
      // A model that sets `validation` keeps it (the project's level caps it); any other follows the profile of the app.
      ...(specification.validation ?? options.defaultValidation) === undefined ? {} : { validation: specification.validation ?? options.defaultValidation },
    });
  }
  for (const [name, descriptor] of Object.entries(definitions)) {
    if (interned.has(name)) continue;
    entries.push({ name, descriptor, emitClass: false, ...(options.defaultValidation === undefined ? {} : { validation: options.defaultValidation }) });
  }
  return entries;
}

/** The keys of the unnamed object types that a validating model of the source holds (see `SchemaGraphOptions.validatedShapes`). */
export function validatedShapeKeys(
  definitions: Readonly<Record<string, ModelConversionDescriptor>>,
  emitted: readonly ModelSpecification[],
  options: SourceSchemaGraphOptions = {},
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of sourceEntries(definitions, emitted, options)) {
    if (entry.validation !== false) anonymousShapeKeys(entry.descriptor, keys);
  }
  return keys;
}

export function internSourceDefinitions(
  definitions: Readonly<Record<string, ModelConversionDescriptor>>,
  emitted: readonly ModelSpecification[],
  options: SourceSchemaGraphOptions = {},
): ReturnType<typeof createSchemaGraph> {
  const entries = sourceEntries(definitions, emitted, options);
  const validatedShapes = options.validatedShapes ?? validatedShapeKeys(definitions, emitted, options);
  const schemaGraph = createSchemaGraph({}, {
    ...(options.codecIds ? { codecIds: options.codecIds } : {}),
    ...(options.externalResidualIds ? { externalResidualIds: options.externalResidualIds } : {}),
    ...(options.externalWireIds ? { externalWireIds: options.externalWireIds } : {}),
    validatedShapes,
  });
  internDescriptors(schemaGraph, entries);
  schemaGraph.seal();
  return schemaGraph;
}

/** One entry per model; the names of its linked classes are more exact names for the codec. */
export function codecEntriesForGraph(
  graph: SourceModelGraph,
  schemaGraph: SchemaGraph | undefined,
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
): ReadonlyArray<{
  readonly source: string;
  readonly name: string;
  readonly codecId: string;
  readonly classNames: readonly string[];
}> {
  const internedSchemaGraph = schemaGraph ?? internSourceDefinitions(graph.definitions, graph.emitted);
  return graph.emitted.map((specification) => {
    const descriptor = descriptorOf(graph.definitions, specification.name);
    const node = internedSchemaGraph.nodeFor(descriptor, specification.name, specification.emitClass);
    return {
      source: portableRelativeFilename(specification.sourceFile.fileName, graph.identityRoot),
      name: specification.name,
      classNames: linkedClassNames(checker, specification, specifications),
      codecId: node?.codecId ?? codecPublicId(specification.name, descriptor, undefined, { source: 'typescript', constructs: specification.emitClass }),
    };
  });
}

/** The user validation functions a job's generated validators import, keyed by binding id; import paths are relative to `validatorsFile`. */
export function validatorImports(
  graphs: readonly SourceModelGraph[],
  profile: GolemProfile,
  validatorsFile: string,
): ReadonlyMap<string, { readonly importPath: string; readonly exportName: string }> {
  const bindings = new Map<string, ValidationBinding>();
  for (const graph of graphs) {
    if (profile.validation === false || !graph.emitted.some((specification) => specification.validation !== false)) continue;
    for (const binding of graph.registry.validations.values()) registerValidation(bindings, binding);
  }
  return new Map([...bindings]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, binding]) => [id, { importPath: bindingImportPath(binding, validatorsFile), exportName: binding.exportName }] as const));
}

/**
 * The node codecs of the golem-mode SDKs that a model file names by the SDK's codec id. Each SDK's codecs file is one import
 * source for the whole file.
 */
interface SdkNodeCodecs {
  readonly find: (codecId: string) => NestedImportedSerde | undefined;
  readonly sources: readonly ImportSource[];
  /**
   * The type of an SDK node in one form: the SDK's own type when the SDK exports one (its plain, converted form is the model and init
   * form, and the wire form when the node converts nothing), else a local alias, which the file writes (`typeAliases`).
   */
  readonly type: (codecId: string, suffix: 'JSON' | 'Init' | 'Fields') => Code;
  /** The type aliases of the SDK node forms that the types of the file named, with the forms they name in turn. */
  readonly typeAliases: (describe: (descriptor: ModelConversionDescriptor, mode: 'model' | 'wire' | 'init') => Code) => readonly Code[];
}

function sdkNodeCodecs(sdks: AppOutputs['sdkCodecs'], output: string): SdkNodeCodecs {
  // One source for each codecs file; the import statement holds only the names the file's code uses.
  const sources = new Map((sdks ?? []).map((sdk) => [sdk.file, new ImportSource(sourceImportPath(sdk.file, output))] as const));
  // One type source for each module of the SDK that declares types.
  const typeSources = new Map((sdks ?? []).flatMap((sdk) => [...sdk.types.values()].map(({ file }) => file)).map((file) => [file, new ImportSource(sourceImportPath(file, output), true)] as const));
  const asked = new Set<string>();
  const written = new Set<string>();
  const ownType = (codecId: string): { readonly file: string; readonly name: string } | undefined => {
    for (const sdk of sdks ?? []) {
      const found = sdk.types.get(codecId);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return {
    find(codecId) {
      for (const sdk of sdks ?? []) {
        const node = sdk.graph.nodeByCodecId(codecId);
        if (node === undefined) continue;
        const source = sources.get(sdk.file)!;
        return {
          stringify: source.name(stringifyFunctionName(node.id)),
          fromWire: source.name(fromWireFunctionName(node.id)),
          toWire: source.name(toWireFunctionName(node.id)),
        };
      }
      return undefined;
    },
    sources: [...sources.values(), ...typeSources.values()],
    type(codecId, suffix) {
      const own = ownType(codecId);
      if (own !== undefined && (suffix !== 'JSON' || !wireDiffers(sdks, codecId))) return typeSources.get(own.file)!.name(own.name, { alias: codecId });
      asked.add(`${codecId}${NODE_FORM}${suffix}`);
      return identifier(`${codecId}${suffix}`);
    },
    typeAliases(describe) {
      const lines: Code[] = [];
      const modes = { Fields: 'model', JSON: 'wire', Init: 'init' } as const;
      // Writing the type of a form can ask for other forms: go on until every form asked for is written.
      for (let pending = [...asked].filter((form) => !written.has(form)).sort(compareText); pending.length > 0; pending = [...asked].filter((form) => !written.has(form)).sort(compareText)) {
        for (const form of pending) {
          written.add(form);
          const [codecId, suffix] = form.split(NODE_FORM) as [string, keyof typeof modes];
          lines.push(code`type ${identifier(`${codecId}${suffix}`)} = ${describe(sdkNodeDescriptor(sdks, codecId), modes[suffix])};`);
        }
      }
      return lines.length === 0 ? lines : [...lines, BLANK];
    },
  };
}

/** Separates the codec id from the form in the name of a type form that the file asked for. */
const NODE_FORM = '\0';

/** Whether the wire form of the SDK node `codecId` differs from its plain form: it holds a date, a serde value or a node that does. */
function wireDiffers(sdks: AppOutputs['sdkCodecs'], codecId: string, seen: Set<string> = new Set()): boolean {
  if (seen.has(codecId)) return false;
  seen.add(codecId);
  const differs = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(differs);
    if (value === null || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (record.kind === 'date' || record.kind === 'class-value' || record.serde !== undefined) return true;
    if (record.kind === 'generated-model' && typeof record.id === 'string') return wireDiffers(sdks, record.id, seen);
    return Object.values(record).some(differs);
  };
  return differs(sdkNodeDescriptor(sdks, codecId));
}

/**
 * The descriptor of the SDK node with codec id `codecId`, with each schema it names written as a reference by codec id, so a type
 * of it names the aliases of the other SDK nodes and the type of a schema that reaches itself is finite.
 */
function sdkNodeDescriptor(sdks: AppOutputs['sdkCodecs'], codecId: string): ModelConversionDescriptor {
  for (const sdk of sdks ?? []) {
    const node = sdk.graph.nodeByCodecId(codecId);
    if (node === undefined) continue;
    return mapNamedTypes(node.descriptor, (named) => {
      const target = sdk.graph.nodeFor(named);
      return { kind: 'generated-model', id: target?.codecId ?? (named.kind === 'reference' ? named.name : named.id) };
    });
  }
  throw new Error(`Internal error: no SDK node with the codec id "${codecId}" for the generated file.`);
}

/** What the app generated beside its model files, which a model file reads. */
interface AppOutputs {
  /**
   * The generated validators module, the name it exports each root under and the name of each root's fast check (see
   * `PlanValidators.exports` and `fastExports`); set when the app validates.
   */
  readonly validators?: { readonly module: string; readonly exports: ReadonlyMap<string, string>; readonly fastExports: ReadonlyMap<string, string>; readonly passExports: ReadonlyMap<string, { readonly structure: string; readonly predicates: string }> };
  /**
   * The codecs files of the golem-mode SDKs, each with its schema graph. A model that holds an SDK type which reaches itself
   * converts the inner occurrence with the node codec the file exports, under the SDK's codec id.
   */
  readonly sdkCodecs?: readonly {
    readonly file: string;
    readonly graph: SchemaGraph;
    /** The SDK's own type of each node it exports a type for, by codec id: the module that declares it and its export name. */
    readonly types: ReadonlyMap<string, { readonly file: string; readonly name: string }>;
  }[];
}

/** How this companion relates to the companions of the files its source imports. */
interface SiblingCodecOptions {
  /** Sibling codecs whose companion exports a wire stringify. */
  readonly siblingWireCodecIds?: ReadonlySet<string>;
  /** Whether each sibling codec's model is recursive, by codec id. */
  readonly siblingRecursion?: ReadonlyMap<string, boolean>;
  /**
   * Siblings whose sources import this one back. Their classes resolve by
   * codec id at decode time: importing the handwritten class would evaluate a
   * module whose base class is not initialized yet.
   */
  readonly cyclicSiblings?: ReadonlySet<string>;
}

/** Export name of an object-only model's conversion helper, keyed by codec id. */
function objectHelperExportName(kind: 'decode' | 'init', codecId: string): string {
  return `__golem${kind[0].toUpperCase()}${kind.slice(1)}_${codecId.replace(/[^A-Za-z0-9_$]/g, '_')}`;
}

/**
 * Everything the file takes from other modules, as parts: the code holds the part of each name it uses, and the import
 * statements hold exactly those names, in the order each source declares them.
 */
interface FileImports {
  /** `import "path"` of each sibling companion: it registers the codecs this file references by id when it loads. */
  readonly siblingCompanions: readonly Code[];
  /** One `import type` source for each class a TSerde field names. */
  readonly classSources: readonly ImportSource[];
  /** The other modules in statement order: companions, sibling helpers, handwritten classes and serde functions. */
  readonly sources: readonly ImportSource[];
  /** By `classImportKey`. */
  readonly classValues: ReadonlyMap<string, Code>;
  readonly localModels: ReadonlyMap<string, Readonly<Record<'BaseModel' | 'JSON' | 'Init', Code>>>;
  readonly siblingTypes: ReadonlyMap<string, Readonly<Record<'Fields' | 'JSON' | 'Init' | 'decode' | 'init', Code>>>;
  /** The handwritten class of a model of another file, by model name. */
  readonly concrete: ReadonlyMap<string, Code>;
  /** The imported source functions of a serde pair, by binding id. */
  readonly serde: ReadonlyMap<string, { readonly serialize: Code; readonly deserialize: Code }>;
}

/**
 * Everything about one source that the sections of its model file read. `buildEmitContext` makes it once; no section
 * changes it, and each section returns its code.
 */
interface EmitContext {
  readonly source: string;
  readonly output: string;
  readonly checker: ts.TypeChecker;
  readonly profile: GolemProfile;
  readonly siblingCodecs: SiblingCodecOptions;
  readonly appOutputs: AppOutputs;
  readonly sdkNodes: SdkNodeCodecs;
  readonly graph: SourceModelGraph;
  readonly schemaGraph: SchemaGraph;
  /** The models of this file. */
  readonly local: readonly ModelSpecification[];
  readonly localNames: ReadonlySet<string>;
  readonly fileLocalNames: ReadonlySet<string>;
  readonly classModelNames: ReadonlySet<string>;
  readonly objectOnlyNames: ReadonlySet<string>;
  /** Object-only models of another source, converted through their companion's exported helpers. */
  readonly siblingObjects: readonly ModelSpecification[];
  readonly siblingObjectNames: ReadonlySet<string>;
  /** Models of other files that this file names, sorted. */
  readonly localImports: readonly ModelSpecification[];
  readonly concreteNames: ReadonlyMap<string, string>;
  readonly linkedByName: ReadonlyMap<string, ReturnType<typeof linkedClassNames>>;
  readonly referenceNames: ReadonlySet<string>;
  readonly projectionNames: ReadonlySet<string>;
  /** Projections that reach no date, serde value or model: they convert to themselves, so a use writes no call. */
  readonly identityProjections: ReadonlySet<string>;
  readonly imports: FileImports;
  readonly serdeBindings: readonly SerdeBinding[];
  readonly serdeNames: ReadonlyMap<string, { readonly serialize: string; readonly deserialize: string }>;
}

/** The item whose source name has the same codec short name as `name`: a node carries the short name (`$d` is `_d`), a source its raw one. */
function findByCodecName<T extends { readonly name: string }>(items: Iterable<T>, name: string): T | undefined {
  const short = codecShortName(name);
  for (const item of items) if (codecShortName(item.name) === short) return item;
  return undefined;
}

/** The codec id of an object-only model of another source. */
function siblingObjectCodecId(schemaGraph: SchemaGraph, name: string): string {
  const node = findByCodecName([...schemaGraph.nodes.values()].filter((item) => item.siblingCodec), name);
  if (!node) throw new Error(`Generated sibling codec is missing: ${name}`);
  return node.codecId;
}

function buildFileImports(
  output: string,
  graph: SourceModelGraph,
  schemaGraph: SchemaGraph,
  localImports: readonly ModelSpecification[],
  siblingObjects: readonly ModelSpecification[],
  concreteNames: ReadonlyMap<string, string>,
  classModelNames: ReadonlySet<string>,
  referenceNames: ReadonlySet<string>,
  cyclicSiblings: ReadonlySet<string> | undefined,
  serdeBindings: readonly SerdeBinding[],
  serdeNames: ReadonlyMap<string, { readonly serialize: string; readonly deserialize: string }>,
  classEntries: readonly (readonly [string, { readonly importPath: string; readonly exportName: string }])[],
  classNames: ReadonlyMap<string, string>,
): FileImports {
  const classValues = new Map<string, Code>();
  const classSources = classEntries.map(([key, item]) => {
    const source = new ImportSource(item.importPath, true);
    classValues.set(key, source.name(item.exportName, { alias: classNames.get(key) }));
    return source;
  });
  const sources: ImportSource[] = [];
  const localModels = new Map<string, Readonly<Record<'BaseModel' | 'JSON' | 'Init', Code>>>();
  for (const item of localImports) {
    const source = new ImportSource(sourceImportPath(companionOfSpecification(item), output));
    localModels.set(item.name, {
      BaseModel: source.name(`${item.name}BaseModel`),
      JSON: source.name(`${item.name}JSON`, { typeOnly: true }),
      Init: source.name(`${item.name}Init`, { typeOnly: true }),
    });
    sources.push(source);
  }
  const siblingTypes = new Map<string, Readonly<Record<'Fields' | 'JSON' | 'Init' | 'decode' | 'init', Code>>>();
  for (const item of siblingObjects) {
    const codecId = siblingObjectCodecId(schemaGraph, item.name);
    const source = new ImportSource(sourceImportPath(companionOfSpecification(item), output));
    siblingTypes.set(item.name, {
      Fields: source.name(`${item.name}Fields`, { typeOnly: true }),
      JSON: source.name(`${item.name}JSON`, { typeOnly: true }),
      Init: source.name(`${item.name}Init`, { typeOnly: true }),
      decode: source.name(objectHelperExportName('decode', codecId)),
      init: source.name(objectHelperExportName('init', codecId)),
    });
    sources.push(source);
  }
  const concrete = new Map<string, Code>();
  for (const item of localImports) {
    const name = concreteNames.get(item.name);
    if (cyclicSiblings?.has(item.name) || name === undefined || !(classModelNames.has(item.name) || referenceNames.has(item.name))) continue;
    assertImportableClassName(item, name);
    const source = new ImportSource(sourceImportPath(item.sourceFile.fileName, output));
    concrete.set(item.name, source.name(name));
    sources.push(source);
  }
  const serde = new Map<string, { readonly serialize: Code; readonly deserialize: Code }>();
  for (const binding of serdeBindings) {
    const names = serdeNames.get(binding.id);
    if (!names) throw new Error(`Generated serde names are missing: ${binding.id}`);
    const serialize = new ImportSource(bindingImportPath(binding.serialize, output));
    const deserialize = new ImportSource(bindingImportPath(binding.deserialize, output));
    serde.set(binding.id, {
      serialize: serialize.name(binding.serialize.exportName, { alias: `${names.serialize}Source` }),
      deserialize: deserialize.name(binding.deserialize.exportName, { alias: `${names.deserialize}Source` }),
    });
    sources.push(serialize, deserialize);
  }
  return {
    // A sibling companion registers the codecs this module references by id.
    siblingCompanions: [...new Set(graph.siblings.map((item) => sourceImportPath(companionOfSpecification(item), output)))]
      .sort()
      .map((path) => code`import ${literal(path)};`),
    classSources,
    sources,
    classValues,
    localModels,
    siblingTypes,
    concrete,
    serde,
  };
}

function buildEmitContext(
  source: string,
  output: string,
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
  profile: GolemProfile,
  graph: SourceModelGraph,
  preparedSchemaGraph: SchemaGraph | undefined,
  siblingCodecs: SiblingCodecOptions,
  appOutputs: AppOutputs,
): EmitContext {
  const { definitions, registry } = graph;
  const { cyclicSiblings } = siblingCodecs;
  const emitted = graph.emitted;
  const local = emitted.filter(item => canonicalFilename(item.sourceFile.fileName) === canonicalFilename(source));
  const localNames = new Set(emitted.map((specification) => specification.name));
  const fileLocalNames = new Set(local.map((specification) => specification.name));
  // A class-valued TSerde field names its class in the generated types. Each class is imported once under a
  // generated name, so two classes called `Money` from different modules do not collide.
  const classImports = new Map<string, { readonly importPath: string; readonly exportName: string }>();
  for (const descriptor of Object.values(definitions)) {
    walkDescriptor(descriptor, {
      enter: (item) => {
        if (item.kind === 'class-value' && item.typeImport) {
          const importPath = item.typeImport.specifier ?? sourceImportPath(item.typeImport.module, output);
          classImports.set(classImportKey(item.typeImport), { importPath, exportName: item.typeImport.exportName });
        }
      },
    }, 'wire');
  }
  const classEntries = [...classImports].sort(([, left], [, right]) => compareText(`${left.importPath}\0${left.exportName}`, `${right.importPath}\0${right.exportName}`));
  const classNames = new Map(classEntries.map(([key], index) => [key, `__golemClass${index}`] as const));
  // Object-only models of another source convert through their companion's exported helpers.
  const siblingObjects = graph.siblings.filter((specification) => !specification.emitClass);
  const siblingObjectNames = new Set(siblingObjects.map((specification) => specification.name));
  const objectOnlyNames = new Set(
    emitted
      .filter((specification) => !specification.emitClass && !siblingObjectNames.has(specification.name))
      .map((specification) => specification.name),
  );
  const concreteNames = new Map(
    emitted
      .filter((specification) => !cyclicSiblings?.has(specification.name))
      .map((specification) => [specification.name, exportedConcreteClass(checker, specification, specifications)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  const linkedByName = new Map(
    emitted
      .filter((specification) => !cyclicSiblings?.has(specification.name))
      .map((specification) => [specification.name, linkedClassNames(checker, specification, specifications)] as const),
  );
  const referenceNames = Object.values(definitions).reduce(
    (found, descriptor) => descriptorReferences(descriptor, found),
    new Set<string>(),
  );
  const localImports = emitted
    .filter((specification) => !local.some((item) => item === specification) && !siblingObjectNames.has(specification.name))
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.sourceFile.fileName, right.sourceFile.fileName));
  const schemaGraph = preparedSchemaGraph ?? internSourceDefinitions(definitions, emitted, { siblings: graph.siblings, defaultValidation: profile.validation });
  const classModelNames = new Set(emitted.filter((specification) => specification.emitClass).map((specification) => specification.name));
  const projectionNames = new Set([
    ...Object.keys(definitions).filter((name) => !localNames.has(name) && !classModelNames.has(name)),
    ...objectOnlyNames,
  ]);
  const identityProjections = new Set([...projectionNames].filter((name) => {
    const body = objectOnlyNames.has(name) ? undefined : definitions[name];
    return body !== undefined && !(body.kind === 'object' && body.projection === true) && !descriptorNeedsConversion(body, (held) => definitions[held]);
  }));
  const serdeBindings = [...registry.serde.values()].sort((left, right) => compareText(left.id, right.id));
  const serdeNames = new Map<string, { readonly serialize: string; readonly deserialize: string }>();
  serdeBindings.forEach((binding, index) => serdeNames.set(binding.id, {
    serialize: `__golemSerialize${index}`,
    deserialize: `__golemDeserialize${index}`,
  }));
  const imports = buildFileImports(
    output, graph, schemaGraph, localImports, siblingObjects, concreteNames, classModelNames, referenceNames,
    cyclicSiblings, serdeBindings, serdeNames, classEntries, classNames,
  );
  return {
    source, output, checker, profile, siblingCodecs, appOutputs, sdkNodes: sdkNodeCodecs(appOutputs.sdkCodecs, output), graph, schemaGraph,
    local, localNames, fileLocalNames, classModelNames, objectOnlyNames, siblingObjects, siblingObjectNames, localImports,
    concreteNames, linkedByName, referenceNames, projectionNames, identityProjections, imports,
    serdeBindings, serdeNames,
  };
}

/** The names a type text takes from other modules (see `descriptorType`). */
function typeNamesOf(context: EmitContext): TypeNames {
  const { imports } = context;
  return {
    classValue: (key) => imports.classValues.get(key),
    modelType: (name, suffix) => modelType(context, name, suffix),
    sdkNodeType: (codecId, suffix) => context.sdkNodes.type(codecId, suffix),
  };
}

/** `<name><suffix>`: the part imported from the companion of the file that holds the model, or the local name. */
function modelType(context: EmitContext, name: string, suffix: 'BaseModel' | 'JSON' | 'Init' | 'Fields'): Code {
  const fromCompanion = suffix === 'Fields' ? undefined : context.imports.localModels.get(name)?.[suffix];
  const fromSibling = suffix === 'BaseModel' ? undefined : context.imports.siblingTypes.get(name)?.[suffix];
  return fromCompanion ?? fromSibling ?? identifier(`${name}${suffix}`);
}

/** The type of a descriptor in this file's generated types. */
function typeOf(context: EmitContext, descriptor: ModelConversionDescriptor, mode: 'model' | 'wire' | 'init'): Code {
  return descriptorType(descriptor, mode, typeNamesOf(context));
}

function serdeExpression(context: EmitContext, id: string, direction: 'serialize' | 'deserialize', value: Code): Code {
  if (id.startsWith(TEMPORAL_SERDE_PREFIX)) return TEMPORAL_SERDE[direction](id, value);
  const names = context.serdeNames.get(id);
  if (names === undefined) throw new Error(`The generated model file of ${displayPath(context.source)} has no ${direction} function for the serde id ${JSON.stringify(id)}.`);
  return code`${identifier(names[direction])}(${value})`;
}

/** The serde functions of the file in both directions. */
function serdeResolver(context: EmitContext): SerdeResolver {
  return {
    deserialize: (id, value) => serdeExpression(context, id, 'deserialize', value),
    serialize: (id, value) => serdeExpression(context, id, 'serialize', value),
  };
}

/** The functions that write one projection: it shares them with every projection of the same shape (`representative`). */
interface ProjectionHelper {
  readonly representative: string;
  readonly decode: Helper;
  readonly init: Helper;
}

/** How a model, by name, converts from JSON in the expressions of this file. */
interface ModelResolvers {
  readonly fromAny: (id: string) => FromJsonModelResolver;
}

/** The record that a projection function reads its fields from: the walker takes it as an input and the function binds it to `data`. */
const DATA = inputSlot('data', 'name', true);

/** The descriptor of a model of the job; every emitted model has one. */
function descriptorOf(definitions: Readonly<Record<string, ModelConversionDescriptor>>, name: string): ModelConversionDescriptor {
  const descriptor = definitions[name];
  if (!descriptor) throw new Error(`Internal error: no descriptor for model "${name}".`);
  return descriptor;
}

/** A model name that no model of the file, no sibling and no import names: the graph holds no model for it. */
function unknownModel(id: string): never {
  throw new Error(`Internal error: no model "${id}" for the generated file.`);
}

function resolveLocalModel(context: EmitContext, name: string, codecId?: string): FromJsonModelResolver {
  if (context.localNames.has(name)) {
    const className = modelType(context, name, 'BaseModel');
    const initType = modelType(context, name, 'Init');
    // Same-file handwritten classes would TDZ if this companion imported them.
    // The build-time rewrite registers the class under the hashed codec id.
    const lookup = codecId ? code`${rt.serde.requireIModelClass}(${literal(codecId)})` : undefined;
    const ctor = lookup
      ? code`(${lookup} as unknown as new (values?: ${initType}) => ${className})`
      : code`(${className} as unknown as new (values?: ${initType}) => ${className})`;
    const decodeCtor = lookup ?? className;
    return {
      className,
      decode: (value) => code`${rt.conversion.decodeGeneratedModelTrusted}(${decodeCtor}, ${value})`,
      fromInit: (value) => code`new ${ctor}(${value} as unknown as ${initType})`,
    };
  }
  return unknownModel(name);
}

function modelResolvers(context: EmitContext, helpers: ReadonlyMap<string, ProjectionHelper>): ModelResolvers {
  const { cyclicSiblings } = context.siblingCodecs;
  const projectionHelper = (name: string): ProjectionHelper => {
    const found = helpers.get(name);
    if (!found) throw new Error(`Generated projection functions are missing: ${name}`);
    return found;
  };
  const resolveProjection = (name: string): FromJsonModelResolver => ({
    className: identifier('Object'),
    ...(context.identityProjections.has(name) ? { identity: true as const } : {}),
    decode: value => code`${helperName(projectionHelper(name).decode)}(${value})`,
    fromInit: value => code`${helperName(projectionHelper(name).init)}(${value})`,
  });
  const siblingClass = (id: string): Code | undefined => {
    if (!cyclicSiblings?.has(id)) return undefined;
    const node = findByCodecName([...context.schemaGraph.nodes.values()].filter((item) => item.siblingCodec), id);
    return node ? code`${rt.serde.requireIModelClass}(${literal(node.codecId)})` : undefined;
  };
  const resolveImportedModel = (id: string): FromJsonModelResolver => {
    const registered = siblingClass(id);
    const concrete = context.concreteNames.get(id);
    const cls = registered
      ?? (concrete === undefined ? undefined : context.imports.concrete.get(id) ?? identifier(concrete))
      ?? (context.classModelNames.has(id) ? modelType(context, id, 'BaseModel') : undefined);
    if (!cls) return unknownModel(id);
    // A class looked up by codec id is a value, not a type name.
    const instance = registered ? modelType(context, id, 'BaseModel') : cls;
    return {
      className: cls,
      decode: (value) => code`${rt.conversion.decodeGeneratedModelTrusted}(${cls}, ${value})`,
      fromInit: (value) => code`new (${cls} as unknown as new (values?: unknown) => ${instance})(${value})`,
    };
  };
  const resolveSiblingObject = (name: string): FromJsonModelResolver => {
    const functions = context.imports.siblingTypes.get(name);
    if (!functions) throw new Error(`Generated sibling codec is missing: ${name}`);
    return {
      className: identifier('Object'),
      decode: (value) => code`${functions.decode}(${value})`,
      fromInit: (value) => code`${functions.init}(${value})`,
    };
  };
  // A node of a golem-mode SDK: it converts with the node codec the SDK's codecs file exports. The model's validators have checked the
  // whole value, and a value in model form needs no conversion.
  const resolveSdkNode = (codecs: NestedImportedSerde): FromJsonModelResolver => ({
    className: identifier('Object'),
    plain: true,
    decode: (value) => code`${codecs.fromWire}(${value}, { validate: false })`,
    fromInit: (value) => value,
  });
  const fromAny = (id: string): FromJsonModelResolver => {
    const sdkNode = context.sdkNodes.find(id);
    if (sdkNode !== undefined) return resolveSdkNode(sdkNode);
    if (context.projectionNames.has(id)) return resolveProjection(id);
    if (context.siblingObjectNames.has(id)) return resolveSiblingObject(id);
    if (context.fileLocalNames.has(id)) {
      const codecId = context.schemaGraph.nodeFor(descriptorOf(context.graph.definitions, id), id)?.codecId;
      return resolveLocalModel(context, id, codecId);
    }
    if (context.localImports.some((item) => item.name === id) && context.classModelNames.has(id)) return resolveImportedModel(id);
    return unknownModel(id);
  };
  return { fromAny };
}

/** The conversion expressions of one projection. */
interface ProjectionExpressions {
  readonly decode: Code;
  readonly init: Code;
}

function projectionExpressionsOf(context: EmitContext, resolvers: ModelResolvers, name: string): ProjectionExpressions {
  const descriptor = context.graph.definitions[name];
  const serde = serdeResolver(context);
  const data = (expression: Code): Code => bindInput(expression, DATA, identifier('data'));
  return {
    decode: data(emitModelFromJSON(descriptor, inputOf(DATA), resolvers.fromAny, serde)),
    init: data(emitModelFromInit(descriptor, inputOf(DATA), resolvers.fromAny)),
  };
}

/** The projections of this file: the functions of each, and the expressions of the ones that write a function. */
interface Projections {
  readonly helpers: ReadonlyMap<string, ProjectionHelper>;
}

/** Projections of the same shape (types and expressions) share the functions of the first of them. */
function buildProjections(context: EmitContext): Projections {
  const { projectionNames } = context;
  const { definitions } = context.graph;
  // The functions of a projection are helpers: a file holds the ones its code calls. A definition reads the final expressions.
  const final = new Map<string, ProjectionExpressions>();
  const functions = new Map<string, ProjectionHelper>();
  const functionsOf = (name: string): ProjectionHelper => {
    const known = functions.get(name);
    if (known) return known;
    const fields = identifier(`${name}Fields`);
    const input = (): Code => definitions[name]?.kind === 'object'
      // A body that is not an object takes the value itself; only an object checks that the input is one.
      ? code`const data = ${rt.conversion.requireModelObject}(value, ${literal(name)});`
      : code`const data = value as Record<string, unknown>;`;
    const expressions = (): ProjectionExpressions => {
      const found = final.get(name);
      if (!found) throw new Error(`Generated projection expressions are missing: ${name}`);
      return found;
    };
    const decode: Helper = helper(`decode${name}`, () =>
      code`function ${identifier(`decode${name}`)}(value: unknown): ${fields} { ${input()} return (${expressions().decode}) as ${fields}; }`);
    const init: Helper = helper(`init${name}`, () => sameCode(expressions().init, expressions().decode)
      ? code`const ${identifier(`init${name}`)} = ${helperName(decode)};`
      : code`function ${identifier(`init${name}`)}(value: unknown): ${fields} { ${input()} return (${expressions().init}) as ${fields}; }`);
    const made = { representative: name, decode, init };
    functions.set(name, made);
    return made;
  };
  const helpersFor = (representatives: ReadonlyMap<string, string>): ReadonlyMap<string, ProjectionHelper> =>
    new Map([...representatives].map(([name, representative]) => [name, functionsOf(representative)] as const));
  const own = helpersFor(new Map([...projectionNames].map((name) => [name, name] as const)));
  const ownResolvers = modelResolvers(context, own);
  interface Shape { readonly name: string; readonly types: readonly Code[]; readonly expressions: ProjectionExpressions }
  const shapes: Shape[] = [];
  const representatives = new Map<string, string>();
  for (const name of projectionNames) {
    const expressions = projectionExpressionsOf(context, ownResolvers, name);
    const types = [typeOf(context, definitions[name], 'model'), typeOf(context, definitions[name], 'wire'), typeOf(context, definitions[name], 'init')];
    const same = shapes.find((shape) => types.every((type, index) => sameCode(type, shape.types[index]))
      && sameCode(expressions.decode, shape.expressions.decode) && sameCode(expressions.init, shape.expressions.init));
    if (!same) shapes.push({ name, types, expressions });
    representatives.set(name, same?.name ?? name);
  }
  const helpers = helpersFor(representatives);
  const resolvers = modelResolvers(context, helpers);
  for (const [name, representative] of representatives) {
    if (representative === name) final.set(name, projectionExpressionsOf(context, resolvers, name));
  }
  return { helpers };
}

/** The conversion code of the fields of one model of this file. */
interface ModelFieldEmission {
  readonly specification: ModelSpecification;
  readonly fields: readonly ts.Symbol[];
  /** Module-level functions and constants that the conversions call. */
  readonly helpers: readonly Code[];
  readonly decode: readonly Code[];
  readonly init: readonly Code[];
}

/** The name of the module-level function that converts one root field of a model. */
const rootHelperName = (model: string) => (index: number): string => `__convert_${model}_${index}_decode`;

function buildFieldEmissions(context: EmitContext, resolvers: ModelResolvers): ModelFieldEmission[] {
  const { checker } = context;
  const { definitions } = context.graph;
  const { fromAny: resolveFromAny } = resolvers;
  const serdeExpressionOf = (id: string, direction: 'serialize' | 'deserialize', value: Code): Code => serdeExpression(context, id, direction, value);
  return context.local.map((specification) => {
    const definition = definitions[specification.name];
    assertRootHasFields(specification, definition);
    // Phantom tag members are part of the type-level intersection and must
    // remain in the root descriptor, but they are not model fields.  Emitting
    // them would make conversion look for descriptors that intentionally do
    // not exist.
    const fields = checker.getPropertiesOfType(specification.fieldsType).filter((field) =>
      definition.kind === 'object'
        ? Object.prototype.hasOwnProperty.call(definition.properties, field.getName())
        : !isGeneratedBrandKey(checker, field) && !isGolemTagKey(checker, field),
    );
    const descriptors = definition.kind === 'object'
      ? new Map(Object.entries(definition.properties))
      : fieldDescriptors(checker, specification, context.graph.describe, fields);
    const helpers: Code[] = [];
    const decode: Code[] = [];
    const init: Code[] = [];
    const decodeCaptures: [key: string, local: Code][] = [];
    const initCaptures: [key: string, local: Code][] = [];
    for (const [index, field] of fields.entries()) {
      const name = literal(field.getName());
      // The JSON view, read once into a local by one Object.keys pass. Decode reads the own copy in `result`, so a
      // getter of the input runs once.
      const input = localCode('value', index);
      const descriptor = descriptors.get(field.getName());
      if (!descriptor) throw new Error(`Missing descriptor for field ${field.getName()}.`);
      const emitDecode = (value: Code): Code => emitModelFromJSON(
        descriptor,
        value,
        resolveFromAny,
        {
          deserialize: (id, value) => serdeExpressionOf(id, 'deserialize', value),
          serialize: (_id, value) => value,
        },
      );
      const fromInit = emitModelFromInit(descriptor, input, resolveFromAny);
      const converted = wrapRootConversion(helpers, rootHelperName(specification.name), 'deserialize', name, input, emitDecode, code`unknown`);
      if (!sameCode(converted, input)) {
        decodeCaptures.push([field.getName(), input]);
        decode.push(code`  if (${input} !== undefined) ${rt.conversion.defineModelProperty}(result, ${name}, ${converted});`);
      }
      initCaptures.push([field.getName(), input]);
      init.push(code`    if (${input} !== undefined) ${rt.conversion.defineModelProperty}(this, ${name}, ${fromInit});`);
    }
    if (decodeCaptures.length > 0) decode.unshift(code`  ${presentKeysCode(identifier('result'), decodeCaptures, { declare: (local) => code`${local}: unknown` })}`);
    if (initCaptures.length > 0) {
      const initType = (local: Code): Code => code`${local}: ${identifier(`${specification.name}Init`)}[${literal(initCaptures.find(([, captured]) => captured === local)?.[0] ?? null)}]`;
      init.unshift(code`    ${presentKeysCode(identifier('values'), initCaptures, { declare: initType })}`);
    }
    // A model with a dynamic map (an index signature) keeps the keys outside its fields as data: the constructor and
    // decode convert them, each by the conversion of the map value. An additionalProperties tag
    // does the same with the value type V of the tag, or keeps the values as they are when V is unknown or any, and the
    // generated types have no index signature for it. A default-open model has no map and writes its declared fields only.
    const mapDefinition = definitions[specification.name];
    const mapSchema = mapDefinition?.kind === 'object' ? mapDefinition.additionalProperties : undefined;
    const declaredMap = mapDefinition?.kind === 'object' && mapDefinition.additionalPropertiesDeclared === true;
    const typedMap = typeof mapSchema === 'object' && !declaredMap;
    const mapValue: ModelConversionDescriptor | undefined = typeof mapSchema === 'object' ? mapSchema
      : declaredMap ? { kind: 'unknown' } : undefined;
    if (mapValue) {
      const initValue = typedMap ? code`${identifier(`${specification.name}Init`)}[string]` : code`unknown`;
      const known = identifier(`__knownKeys_${specification.name}`);
      helpers.push(code`const ${known}: ReadonlySet<string> = new Set<string>([${join(fields.map((field) => literal(field.getName())), code`, `)}]);`);
      const serde = serdeResolver(context);
      const decodeMapValue = wrapRootConversion(helpers, rootHelperName(specification.name), 'deserialize', identifier('key'), identifier('value'), (value) => emitModelFromJSON(mapValue, value, resolveFromAny, { ...serde, serialize: (_id, value) => value }), code`unknown`);
      const initMapValue = emitModelFromInit(mapValue, identifier('value'), resolveFromAny);
      if (!sameCode(decodeMapValue, identifier('value'))) {
        decode.push(code`  for (const key of Object.keys(result)) if (!${known}.has(key)) { const value = result[key]; if (value !== undefined) ${rt.conversion.defineModelProperty}(result, key, ${decodeMapValue}); }`);
      }
      init.push(code`    for (const key of Object.keys(values)) if (!${known}.has(key)) { const value = (values as Record<string, ${initValue}>)[key]; if (value !== undefined) ${rt.conversion.defineModelProperty}(this, key, ${initMapValue}); }`);
    }
    return { specification, fields, helpers, decode, init };
  });
}

/** A class model registers the MobX validator hook when the app validates it and uses MobX. */
function observesValidator(context: EmitContext, specification: ModelSpecification): boolean {
  return context.profile.mobx && (specification.validation ?? context.profile.validation) !== false;
}

const BLANK = code``;

/** The serde functions the file calls: each import, typed `unknown` to `unknown`. */
function emitSerdeFunctions(context: EmitContext): Piece[] {
  if (context.serdeBindings.length === 0) return [];
  return [
    ...context.serdeBindings.flatMap((binding) => {
      const names = context.serdeNames.get(binding.id);
      const imported = context.imports.serde.get(binding.id);
      return names && imported ? [
        code`const ${identifier(names.serialize)} = ${imported.serialize} as (value: unknown) => unknown;`,
        code`const ${identifier(names.deserialize)} = ${imported.deserialize} as (value: unknown) => unknown;`,
      ] : [];
    }),
    BLANK,
  ];
}

/** The types, and the conversion functions, of the models that are not classes of this file. */
function emitProjectionTypes(context: EmitContext, projections: Projections): Piece[] {
  const lines: Piece[] = [];
  const { definitions } = context.graph;
  for (const [name, functions] of projections.helpers) {
    const descriptor = definitions[name];
    const representative = functions.representative;
    const own = representative === name;
    const exported = context.objectOnlyNames.has(name) ? code`export ` : code``;
    const typeName = (suffix: 'Fields' | 'JSON' | 'Init'): Code => identifier(`${name}${suffix}`);
    const typeFor = (mode: 'model' | 'wire' | 'init', suffix: 'Fields' | 'JSON' | 'Init'): Code =>
      own ? typeOf(context, descriptor, mode) : identifier(`${representative}${suffix}`);
    lines.push(
      code`${exported}type ${typeName('Fields')} = ${typeFor('model', 'Fields')};`,
      code`${exported}type ${typeName('JSON')} = ${typeFor('wire', 'JSON')};`,
      code`${exported}type ${typeName('Init')} = ${typeFor('init', 'Init')};`,
      ...(own && !context.identityProjections.has(name) ? [functions.decode, functions.init] : []),
      BLANK,
    );
  }
  return lines;
}

/** A companion of another source converts the object-only models of this file with these exports. */
function emitObjectHelperExports(context: EmitContext, helpers: ReadonlyMap<string, ProjectionHelper>): Piece[] {
  const lines: Piece[] = [];
  for (const name of context.objectOnlyNames) {
    if (!context.fileLocalNames.has(name)) continue;
    const codecId = context.schemaGraph.nodeFor(descriptorOf(context.graph.definitions, name), name)?.codecId;
    const functions = helpers.get(name);
    if (!codecId || !functions) continue;
    lines.push(
      code`export { ${helperName(functions.decode)} as ${identifier(objectHelperExportName('decode', codecId))}, ${helperName(functions.init)} as ${identifier(objectHelperExportName('init', codecId))} };`,
      BLANK,
    );
  }
  return lines;
}

/** One class model: its types, base class, conversion functions and registrations. */
function emitClassModel(context: EmitContext, emission: ModelFieldEmission): Piece[] {
  const { specification, fields, helpers, decode: decodeFields, init: initFields } = emission;
  const { schemaGraph, profile } = context;
  const fieldNames = fields.map((field) => field.getName());
  const baseName = identifier(`${specification.name}BaseModel`);
  const fieldsName = identifier(`${specification.name}Fields`);
  const jsonName = identifier(`${specification.name}JSON`);
  const initName = identifier(`${specification.name}Init`);
  const definition = descriptorOf(context.graph.definitions, specification.name);
  const node = schemaGraph.nodeFor(definition, specification.name);
  if (!node) throw new Error(`Internal error: no schema node for model "${specification.name}".`);
  const codecId = literal(node.codecId);
  const decodeModel = identifier(`decode${specification.name}Model`);
  return [
    code`export type ${fieldsName} = ${typeOf(context, definition, 'model')};`,
    code`export type ${jsonName} = ${typeOf(context, definition, 'wire')};`,
    code`export type ${initName} = Partial<${typeOf(context, definition, 'init')}>;`,
    BLANK,
    code`export abstract class ${baseName} implements ${rtType.model.GeneratedModel}<${jsonName}, ${fieldsName}> {`,
    code`  declare readonly [${rtType.model.generatedModelWireBrand}]: ${jsonName};`,
    code`  declare readonly [${rtType.model.generatedModelFieldsBrand}]: ${fieldsName};`,
    ...fields.map((field) => {
      const optional = (field.flags & ts.SymbolFlags.Optional) !== 0 ? code`?` : code``;
      const readonlyField = definition.kind === 'object' && definition.readonlyProperties?.includes(field.getName()) ? code`readonly ` : code``;
      return code`  declare ${readonlyField}${propertyKey(field.getName())}${optional}: ${fieldsName}[${literal(field.getName())}];`;
    }),
    BLANK,
    code`  public constructor(${identifier(initFields.length ? 'values' : '_values')}: ${initName} = {}) {`,
    ...initFields,
    code`  }`,
    BLANK,
    code`}`,
    BLANK,
    ...helpers.flatMap((each) => [each, BLANK]),
    code`function ${decodeModel}(constructor: ${rtType.model.GeneratedModelConstructor}, json: unknown): ${baseName} {`,
    code`  const values = ${rt.conversion.requireModelObject}(json, ${literal(`${specification.name}BaseModel`)});`,
    ...(decodeFields.length
      ? [
        code`  const result: Record<string, unknown> = { ...values };`,
        ...decodeFields,
        code`  return Reflect.construct(constructor, [result]) as ${baseName};`,
      ]
      : [
        code`  return Reflect.construct(constructor, [values]) as ${baseName};`,
      ]),
    code`}`,
    BLANK,
    code`${rt.model.registerGeneratedModel}(${baseName}, {`,
    code`  fields: [${join(fieldNames.map((name) => literal(name)), code`, `)}],`,
    code`  conversion: {`,
    code`    decode: (value, constructor) => ${decodeModel}(constructor ?? ${baseName}, value),`,
    code`  },`,
    code`  codecId: ${codecId},`,
    code`  profile: { validation: ${literal(specification.validation ?? profile.validation)} },`,
    ...(observesValidator(context, specification) ? [code`  enhanceValidator: ${rt['mobx-validation'].enhanceValidatorWithMobX},`] : []),
    // A model with a dynamic map, or an explicit additionalProperties true, has no program state: the keys outside its
    // fields are data. A default-open model declares none, so its other own keys are program state.
    ...(definition.kind === 'object' && (typeof definition.additionalProperties === 'object' || definition.additionalPropertiesDeclared) ? [code`  additionalProperties: true,`] : []),
    code`});`,
    BLANK,
    code`${rt.serde.registerIModelClass}(${codecId}, ${baseName});`,
    BLANK,
  ];
}

/** The class models of this file; a model that is not a class writes no code here. */
function emitClassModels(context: EmitContext, emissions: readonly ModelFieldEmission[]): Piece[] {
  const lines: Piece[] = [];
  for (const emission of emissions) {
    const collision = emission.fields.map((field) => field.getName()).find((name) => RESERVED_MODEL_MEMBERS.includes(name));
    if (collision) {
      throw new Error(`Model ${emission.specification.name} field "${collision}" collides with a generated API member.`);
    }
    if (emission.specification.emitClass) lines.push(...emitClassModel(context, emission));
  }
  return lines;
}

/**
 * The codecs of this file. `sources` are the modules the codecs name besides the file's own: the validators they call
 * and the wire stringify functions of sibling codecs. `lines` end the file.
 */
interface CodecSection {
  readonly sources: readonly ImportSource[];
  readonly lines: readonly Code[];
}

function emitCodecSection(context: EmitContext): CodecSection {
  const { output, schemaGraph, appOutputs, profile, graph, imports } = context;
  const { definitions } = graph;
  const { localNames } = context;
  const { siblingWireCodecIds, siblingRecursion } = context.siblingCodecs;
  const nestedConstruct = (name: string, className?: string): Code => {
    const node = [...schemaGraph.nodes.values()].find((item) => item.codecId === name || item.name === name);
    const short = node?.name ?? name;
    const id = node?.codecId ?? name;
    const cls = context.concreteNames.get(short);
    if (cls !== undefined && context.localImports.some((item) => item.name === short)) return imports.concrete.get(short) ?? identifier(cls);
    // A model with several linked classes registers each under `<id>#<class>`; the type names which one.
    if (className !== undefined && context.linkedByName.get(short)?.includes(className) && (context.linkedByName.get(short)?.length ?? 0) > 1) {
      return code`${rt.serde.requireIModelClass}(${literal(`${id}#${className}`)})`;
    }
    return code`${rt.serde.requireIModelClass}(${literal(id)})`;
  };
  // The generated base class of a class model this file declares or imports: a union tests an instance's class with it, so no guard looks up a registry. An IObject model has no class.
  const nestedBase = (name: string): Code | undefined => context.classModelNames.has(name) && (context.fileLocalNames.has(name) || imports.localModels.has(name))
    ? modelType(context, name, 'BaseModel')
    : undefined;
  // The validators the codecs use: the model file imports those and no others.
  const validators = appOutputs.validators;
  const validatorsSource = validators ? new ImportSource(sourceImportPath(validators.module, output)) : undefined;
  const validatorNames = validators && validatorsSource
    ? new Map([...new Set([...validators.exports.values(), ...validators.fastExports.values(), ...[...validators.passExports.values()].flatMap(({ structure, predicates }) => [structure, predicates])])].sort().map((name) => [name, validatorsSource.name(name)] as const))
    : new Map<string, Code>();
  // Wire stringify functions of sibling codecs this module writes, imported from the companion of each.
  const siblingWires = new Map<string, Code>();
  const siblingWireSources: ImportSource[] = [];
  for (const node of schemaGraph.nodes.values()) {
    const sibling = node.siblingCodec ? findByCodecName(graph.siblings, node.name) : undefined;
    if (!sibling) continue;
    const wireSource = new ImportSource(sourceImportPath(companionOfSpecification(sibling), output));
    siblingWires.set(node.codecId, wireSource.name(wireStringifyExportName(node.codecId)));
    siblingWireSources.push(wireSource);
  }
  const codecRuntime = emitCodecRuntimeCode(
    schemaGraph,
    {
      validationLevel: profile.validation,
      nestedImportedSerde: context.sdkNodes.find,
      ...(validators ? {
        validatorName: (id: string) => {
          const name = validators.exports.get(id);
          if (name === undefined) throw new Error(`The generated validators module has no validator for ${JSON.stringify(id)}.`);
          return validatorNames.get(name) ?? identifier(name);
        },
        fastCheckName: (id: string) => {
          const name = validators.fastExports.get(id);
          return name === undefined ? undefined : validatorNames.get(name) ?? identifier(name);
        },
        passCheckNames: (id: string) => {
          const names = validators.passExports.get(id);
          return names === undefined ? undefined : { structure: validatorNames.get(names.structure) ?? identifier(names.structure), predicates: validatorNames.get(names.predicates) ?? identifier(names.predicates) };
        },
      } : {}),
      // Type analysis flattens object intersections, so golem-model has no declared bases.
      modelBases: { basesOf: () => [] },
      serde: serdeResolver(context),
      nestedConstruct,
      modelClassName: (node) => localNames.has(node.name) ? `${node.name}BaseModel` : undefined,
      nestedBase,
      siblingWireName: (codecId) => siblingWires.get(codecId) ?? identifier(wireStringifyExportName(codecId)),
      wireType: (node) => Object.hasOwn(definitions, node.name) || localNames.has(node.name) ? modelType(context, node.name, 'JSON') : undefined,
      fieldsType: (node) => Object.hasOwn(definitions, node.name) || localNames.has(node.name) ? modelType(context, node.name, 'Fields') : undefined,
      // A derived projection (an Omit, Pick or alias of a model) is not a model the user declared; other files reach it by codec id.
      privateCodec: (node) => Object.hasOwn(definitions, node.name) && !localNames.has(node.name),
      ...(siblingWireCodecIds ? { siblingWireCodecIds } : {}),
      ...(siblingRecursion ? { siblingRecursion } : {}),
      exportWireStringify: true,
    },
  );
  return {
    sources: [...(validatorsSource ? [validatorsSource] : []), ...siblingWireSources, ...context.sdkNodes.sources],
    lines: [
      codecRuntime,
    ],
  };
}

/** The order of the names in each import line of a model file. */
const IMPORT_OPTIONS: ImportOptions = {
  typeNames: 'inline',
  modules: ['model', 'conversion', 'serde', 'mobx-validation', 'temporal'],
  order: MODEL_IMPORT_ORDER,
};

/** Writes the model file of one source: one section after another, in the order of the file. */
export function emitSource(
  source: string,
  output: string,
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
  profile: GolemProfile,
  graph: SourceModelGraph,
  preparedSchemaGraph?: SchemaGraph,
  siblingCodecs: SiblingCodecOptions = {},
  appOutputs: AppOutputs = {},
): string | undefined {
  const context = buildEmitContext(source, output, checker, specifications, profile, graph, preparedSchemaGraph, siblingCodecs, appOutputs);
  const projections = buildProjections(context);
  const emissions = buildFieldEmissions(context, modelResolvers(context, projections.helpers));
  const codecs = emitCodecSection(context);
  const pieces: Piece[] = [
    ...emitSerdeFunctions(context),
    ...emitProjectionTypes(context, projections),
    ...emitObjectHelperExports(context, projections.helpers),
    ...emitClassModels(context, emissions),
    ...codecs.lines,
    ...context.sdkNodes.typeAliases((descriptor, mode) => typeOf(context, descriptor, mode)),
  ];
  // What the file calls decides its imports and which helpers it defines: a helper stands where its definition goes.
  const calls = join(pieces.filter(isCode), code`\n`);
  const runtimeLines = runtimeLinesOf(calls, IMPORT_OPTIONS);
  const otherSources = [...codecs.sources, ...context.imports.classSources, ...context.imports.sources];
  const lines: readonly Code[] = [
    blockComment(`Generated by @exprtlabs/golem-model ${PACKAGE_VERSION}. Do not edit.`),
    ...fileImports(calls, codecs.sources, { quote: '"', elsewhere: otherSources }),
    ...runtimeLines('model', 'conversion'),
    ...fileImports(calls, context.imports.classSources, { quote: '"', elsewhere: otherSources }),
    ...runtimeLines('serde', 'temporal', 'mobx-validation'),
    ...context.imports.siblingCompanions,
    ...fileImports(calls, context.imports.sources, { quote: '"', elsewhere: otherSources }),
    BLANK,
    ...placeHelpers(calls, pieces, MODULE_CONSTANT_HELPERS),
  ];
  return render(code`${join(lines, code`\n`)}\n`);
}
