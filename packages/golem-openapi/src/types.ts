import { isBinaryMediaType, isBuiltinTextMediaType } from './client/codecs.js';
import { asRecord, isJsonObject, objectEntries, type JsonObject } from './json.js';
import { identifier, NameScope } from '@exprtlabs/golem/generator-api';
import { code, codeKey, manifestMarkerComment, docComment, exportedName, fileImports, identifier as identifierPart, ImportSource, isEmpty, join, lineBreak, literal, nest, propertyKey, render, renderModule, sameCode, type RenderedModule, type Code, type JsonValue } from '@exprtlabs/golem/internal/emitter';
import { refName } from './names.js';
import {
  effectiveSchemaTypes,
  parameterSchema,
  resolveLocal,
  type NormalizedOperation,
  type NormalizedResponse,
  type OpenApiMediaType,
} from './normalize.js';
import { generatedBannerComment } from './package-info.js';
import { ComponentNameScope } from './origin.js';
import { projectSchema, collectCanonicalResources, nextSchemaBase, resolveSchemaTarget, schemaDocumentBase, schemaTargetIdentity, type ResolvedSchemaTarget, type ResourceIndex } from './schema-projection.js';

type TextSchemaKind = 'string' | 'unknown' | 'non-string' | 'ambiguous';

interface TextSchemaClassification {
  readonly kind: TextSchemaKind;
  readonly schemaType: string;
}

interface TextCodecRequirement {
  readonly option: 'bodyEncoders' | 'responseDecoders';
  readonly schemaType: string;
}

const NON_STRING_JSON_TYPES = new Set(['number', 'integer', 'boolean', 'object', 'array']);

interface TextSchemaEnv {
  readonly document: unknown;
  readonly resources: ResourceIndex;
  readonly currentBase: string;
  readonly visiting: Set<string>;
  readonly visitingNodes: Set<object>;
}

function unknownTextSchema(schemaType = 'unknown'): TextSchemaClassification {
  return { kind: 'unknown', schemaType };
}

function allOfTextSchemas(
  left: TextSchemaClassification,
  right: TextSchemaClassification,
): TextSchemaClassification {
  if (left.kind === 'unknown') return right;
  if (right.kind === 'unknown') return left;
  if (left.kind === 'ambiguous' || right.kind === 'ambiguous') {
    return { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  if (left.kind === 'string' && right.kind === 'string') return left;
  if (left.kind === 'non-string' && right.kind === 'non-string') {
    return left.schemaType === right.schemaType ? left : { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  return { kind: 'ambiguous', schemaType: 'ambiguous' };
}

function anyOfTextSchemas(parts: readonly TextSchemaClassification[]): TextSchemaClassification {
  if (!parts.length) return unknownTextSchema();
  if (parts.every((part) => part.kind === 'string')) return { kind: 'string', schemaType: 'string' };
  if (parts.every((part) => part.kind === 'unknown')) return unknownTextSchema();
  if (parts.every((part) => part.kind === 'non-string')) {
    const types = new Set(parts.map((part) => part.schemaType));
    if (types.size === 1) return parts[0] ?? { kind: 'non-string', schemaType: 'ambiguous' };
  }
  return { kind: 'ambiguous', schemaType: 'ambiguous' };
}

function classifyConstValue(value: unknown): TextSchemaClassification {
  if (typeof value === 'string') return { kind: 'string', schemaType: 'string' };
  if (value === null) return { kind: 'non-string', schemaType: 'null' };
  if (typeof value === 'number') return { kind: 'non-string', schemaType: 'number' };
  if (typeof value === 'boolean') return { kind: 'non-string', schemaType: 'boolean' };
  if (Array.isArray(value)) return { kind: 'non-string', schemaType: 'array' };
  return { kind: 'non-string', schemaType: 'object' };
}

function withNullAlternative(
  classification: TextSchemaClassification,
  includesNull: boolean,
): TextSchemaClassification {
  if (!includesNull) return classification;
  if (classification.kind === 'string') return { kind: 'ambiguous', schemaType: 'string | null' };
  if (classification.kind === 'non-string' && classification.schemaType !== 'null') {
    return { kind: 'ambiguous', schemaType: `${classification.schemaType} | null` };
  }
  return classification;
}

function classifyTextSchemaLocal(schema: JsonObject): TextSchemaClassification {
  if (schema.const !== undefined) return classifyConstValue(schema.const);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return { kind: 'ambiguous', schemaType: 'never' };
    const hasNull = schema.enum.some((value) => value === null);
    const concrete = schema.enum.filter((value) => value !== null);
    if (concrete.length === 0) return { kind: 'non-string', schemaType: 'null' };
    const kinds = new Set(concrete.map((value) => typeof value));
    if (kinds.size === 1 && kinds.has('string')) {
      return withNullAlternative({ kind: 'string', schemaType: 'string' }, hasNull);
    }
    if (kinds.size === 1) {
      const [schemaType] = kinds;
      return withNullAlternative(
        { kind: 'non-string', schemaType: schemaType ?? 'ambiguous' },
        hasNull,
      );
    }
    return { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  const types = effectiveSchemaTypes(schema);
  const concrete = types.filter((type) => type !== 'null');
  const includesNull = types.includes('null');
  if (concrete.includes('string') && concrete.some((type) => type !== 'string')) {
    return { kind: 'ambiguous', schemaType: 'ambiguous' };
  }
  if (concrete.length === 1 && concrete[0] === 'string') {
    if (schema.format === 'binary') {
      return withNullAlternative({ kind: 'non-string', schemaType: 'binary' }, includesNull);
    }
    return withNullAlternative({ kind: 'string', schemaType: 'string' }, includesNull);
  }
  if (concrete.length === 1 && concrete[0] && NON_STRING_JSON_TYPES.has(concrete[0])) {
    return withNullAlternative({ kind: 'non-string', schemaType: concrete[0] }, includesNull);
  }
  if (concrete.length > 1) return { kind: 'ambiguous', schemaType: 'ambiguous' };
  if (includesNull) {
    return { kind: 'non-string', schemaType: 'null' };
  }
  if (schema.properties || schema.additionalProperties !== undefined) {
    return { kind: 'non-string', schemaType: 'object' };
  }
  if (Array.isArray(schema.prefixItems) || schema.items !== undefined) {
    return { kind: 'non-string', schemaType: 'array' };
  }
  return unknownTextSchema();
}

function classifyTextSchemaNode(
  schema: unknown,
  env: TextSchemaEnv,
): TextSchemaClassification {
  if (schema === null || schema === undefined || schema === true) return unknownTextSchema();
  if (schema === false) return { kind: 'ambiguous', schemaType: 'never' };
  if (!isJsonObject(schema)) return unknownTextSchema();
  if (env.visitingNodes.has(schema)) return { kind: 'ambiguous', schemaType: 'ambiguous' };
  env.visitingNodes.add(schema);
  try {
    const currentBase = nextSchemaBase(schema, env.currentBase, env.resources);
    const nested: TextSchemaEnv = { ...env, currentBase };
    const reference = typeof schema.$ref === 'string'
      ? schema.$ref
      : typeof schema.$dynamicRef === 'string'
        ? schema.$dynamicRef
        : undefined;
    let fromRef: TextSchemaClassification | undefined;
    if (reference !== undefined) {
      const target = resolveSchemaTarget(reference, currentBase, env.resources, env.document);
      if (!target) {
        fromRef = { kind: 'ambiguous', schemaType: 'unresolved' };
      } else {
        const identity = schemaTargetIdentity(target);
        if (env.visiting.has(identity)) {
          fromRef = { kind: 'ambiguous', schemaType: 'ambiguous' };
        } else {
          env.visiting.add(identity);
          try {
            fromRef = classifyTextSchemaNode(target.schema, { ...nested, currentBase: target.currentBase });
          } finally {
            env.visiting.delete(identity);
          }
        }
      }
    }
    const local = classifyTextSchemaLocal(schema);
    const allOf = Array.isArray(schema.allOf)
      ? schema.allOf.map((item) => classifyTextSchemaNode(item, nested))
      : [];
    const alternatives = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : undefined;
    const fromAlternatives = alternatives
      ? anyOfTextSchemas(alternatives.map((item) => classifyTextSchemaNode(item, nested)))
      : undefined;
    let result = [fromRef, local, ...allOf, fromAlternatives].reduce<TextSchemaClassification>(
      (combined, part) => (part ? allOfTextSchemas(combined, part) : combined),
      unknownTextSchema(),
    );
    if (
      result.kind === 'unknown'
      && (schema.if !== undefined || schema.then !== undefined || schema.else !== undefined)
    ) {
      result = { kind: 'ambiguous', schemaType: 'ambiguous' };
    }
    return result;
  } finally {
    env.visitingNodes.delete(schema);
  }
}

function classifyTextSchema(schema: unknown, document: unknown): TextSchemaClassification {
  return classifyTextSchemaNode(schema, {
    document,
    resources: collectCanonicalResources(document),
    currentBase: schemaDocumentBase(document),
    visiting: new Set<string>(),
    visitingNodes: new Set<object>(),
  });
}

export function textCodecRequirement(
  media: Pick<OpenApiMediaType, 'contentType' | 'schema'>,
  option: 'bodyEncoders' | 'responseDecoders',
  document: unknown,
): TextCodecRequirement | undefined {
  if (!isBuiltinTextMediaType(media.contentType)) return undefined;
  const classified = classifyTextSchema(media.schema, document);
  if (classified.kind === 'string' || classified.kind === 'unknown') return undefined;
  const direction = option === 'bodyEncoders' ? 'input' : 'output';
  return {
    option,
    schemaType: render(schemaTypeCode(media.schema, schemaContext(document, { direction })).code),
  };
}

export interface SchemaTypeContext {
  readonly direction?: 'input' | 'output';
  /** The code written before a component's type name: the namespace the type is imported under, such as `Types.`. */
  readonly qualifier?: Code;
  readonly anchors?: ReadonlyMap<string, string>;
  /** Present only when a component shadows the global `Blob` in the emitted module. */
  readonly blobType?: { readonly name: string; used: boolean };
  readonly document?: unknown;
  readonly resources?: ResourceIndex;
  readonly currentBase?: string;
  readonly inlining?: ReadonlySet<string>;
}

/** How a type binds in a larger type: a member of a union, an intersection or an array parenthesizes by it. */
export type TypeBinding = 'primary' | 'intersection' | 'union';

/** The code of a type, and how it binds. The builder that writes the type knows its binding, so no step reads the code back. */
export interface TypeCode {
  readonly code: Code;
  readonly binds: TypeBinding;
}

export function typeCode(typeText: Code, binds: TypeBinding = 'primary'): TypeCode {
  return { code: typeText, binds };
}

const UNKNOWN_TYPE = typeCode(code`unknown`);
const NEVER_TYPE = typeCode(code`never`);
const NULL_TYPE = typeCode(code`null`);

function sameType(left: TypeCode, right: TypeCode): boolean {
  return sameCode(left.code, right.code);
}

function distinctTypes(types: readonly TypeCode[]): TypeCode[] {
  const kept = new Map<string, TypeCode>();
  for (const type of types) if (!kept.has(codeKey(type.code))) kept.set(codeKey(type.code), type);
  return [...kept.values()];
}

/** Alias the global `Blob` when a component named `Blob` shadows it in the emitted module. */
function generatedBlobType(
  scope: NameScope,
  declaredNames: readonly string[],
): { readonly name: string; used: boolean } | undefined {
  if (!declaredNames.includes('Blob')) return undefined;
  const reserved = new Set(declaredNames);
  let name = '__OpenApiBlob';
  for (let suffix = 1; reserved.has(name) || scope.has(name); suffix += 1) name = `__OpenApiBlob${suffix}`;
  scope.claim(name, 'internal global Blob alias');
  return { name, used: false };
}

function blobType(context: SchemaTypeContext): TypeCode {
  const utility = context.blobType;
  if (!utility) return typeCode(code`Blob`);
  utility.used = true;
  return typeCode(identifierPart(utility.name));
}

/** A union of distinct member types. A member never needs parentheses: the types written here bind tighter than `|`. */
function unionType(types: readonly TypeCode[]): TypeCode | undefined {
  const members = distinctTypes(types);
  const [only, ...more] = members;
  if (only === undefined) return undefined;
  return more.length === 0 ? only : typeCode(join(members.map((type) => type.code), code` | `), 'union');
}

/** An intersection of distinct member types; a union member is parenthesized. */
function intersectionType(types: readonly TypeCode[]): TypeCode {
  const members = distinctTypes(types);
  const [only, ...more] = members;
  if (only === undefined) throw new Error('Internal error: an intersection has no member.');
  if (more.length === 0) return only;
  return typeCode(join(members.map((type) => type.binds === 'union' ? code`(${type.code})` : type.code), code` & `), 'intersection');
}

/** `T | null`. */
export function orNull(type: TypeCode): TypeCode {
  return typeCode(code`${type.code} | null`, 'union');
}

/** The right-hand side after `=`: one response variant per line when there are several. */
function responseUnion(variants: readonly TypeCode[]): Code {
  const [only, ...more] = variants;
  if (only === undefined) return code` never`;
  if (more.length === 0) return code` ${only.code}`;
  return join(variants.map((variant) => code`${lineBreak}  | ${nest(variant.code)}`));
}

/** `T[]` never names the global `Array`, which a component may shadow. */
export function arrayType(item: TypeCode): TypeCode {
  return typeCode(item.binds === 'primary' ? code`${item.code}[]` : code`(${item.code})[]`);
}

/** An inline index signature: a component named `Record` cannot shadow it, so no helper alias is needed. */
function recordType(valueType: TypeCode): TypeCode {
  return typeCode(code`{ [key: string]: ${valueType.code} }`);
}

function emitBlobType(output: Code[], index: number, utility: { readonly name: string; used: boolean } | undefined): void {
  // The module's own `Blob` shadows the global name, so reach it through globalThis.
  if (utility?.used) output.splice(index, 0, code`type ${identifierPart(utility.name)} = InstanceType<typeof globalThis.Blob>;`, code``);
}

/** The comment of a description: one line, and it cannot end itself. */
export function descriptionComment(description: unknown): Code {
  return docComment(String(description).replace(/\*\//g, '*\\/').replace(/\s+/g, ' '));
}

function componentAnchorTypes(document: unknown): Map<string, string> {
  const anchors = new Map<string, string>();
  const ambiguous = new Set<string>();
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  for (const [name, schema] of objectEntries(schemas)) {
    if (!isJsonObject(schema)) continue;
    for (const anchor of [schema.$anchor, schema.$dynamicAnchor]) {
      if (typeof anchor !== 'string') continue;
      const reference = `#${anchor}`;
      if (anchors.has(reference)) ambiguous.add(reference);
      else anchors.set(reference, identifier(name));
    }
  }
  for (const reference of ambiguous) anchors.delete(reference);
  return anchors;
}

export function schemaContext(
  document: unknown,
  context: SchemaTypeContext = {},
  componentName?: string,
  componentSchema?: unknown,
): SchemaTypeContext {
  const anchors = new Map(context.anchors || componentAnchorTypes(document));
  if (componentName && isJsonObject(componentSchema)) {
    if (typeof componentSchema.$anchor === 'string') {
      anchors.set(`#${componentSchema.$anchor}`, identifier(componentName));
    }
    if (typeof componentSchema.$dynamicAnchor === 'string') {
      anchors.set(`#${componentSchema.$dynamicAnchor}`, identifier(componentName));
    }
  }
  return {
    ...context,
    document,
    anchors,
    resources: context.resources ?? collectCanonicalResources(document),
    currentBase: context.currentBase ?? schemaDocumentBase(document),
  };
}

/** A public context names the qualifier as text: one or more identifiers, each followed by a dot. */
export interface PublicSchemaTypeContext extends Omit<SchemaTypeContext, 'qualifier'> {
  readonly qualifier?: string;
}

function qualifierCode(qualifier: string | undefined): Code | undefined {
  if (qualifier === undefined || qualifier === '') return undefined;
  if (!qualifier.endsWith('.')) throw new TypeError(`a qualifier is identifiers with a dot after each, got ${JSON.stringify(qualifier)}`);
  return code`${join(qualifier.slice(0, -1).split('.').map(identifierPart), code`.`)}.`;
}

/** The type of a schema as text, for callers that take no Code. */
export function schemaType(schema: unknown, context: PublicSchemaTypeContext = {}): string {
  const { qualifier, ...rest } = context;
  const qualified = qualifierCode(qualifier);
  return render(schemaTypeCode(schema, { ...rest, ...(qualified ? { qualifier: qualified } : {}) }).code);
}

export function schemaTypeCode(schema: unknown, context: SchemaTypeContext = {}): TypeCode {
  const projected = context.direction
    ? projectSchema(schema, { document: context.document ?? {}, direction: context.direction })
    : schema;
  return schemaTypeNode(projected, context);
}

/** The type of a `prefixItems` array: a union of the prefix lengths that min/max allow. `itemType` gives the type of one item schema. */
export function prefixItemsType(schema: JsonObjectLike, itemType: (item: unknown) => TypeCode): TypeCode {
  const prefix = (Array.isArray(schema.prefixItems) ? schema.prefixItems : [])
    .map(itemType);
  const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
  const max = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
  const additional = schema.items === false
    ? null
    : schema.items !== undefined && schema.items !== null
      ? itemType(schema.items)
      : UNKNOWN_TYPE;
  if (max !== undefined && max < min) return NEVER_TYPE;
  if (additional === null && min > prefix.length) return NEVER_TYPE;
  const variants: TypeCode[] = [];
  const lastExact = additional === null
    ? (max === undefined ? prefix.length : Math.min(prefix.length, max))
    : Math.min(prefix.length, max === undefined ? prefix.length : max);
  const minExact = Math.max(0, Math.min(min, prefix.length));
  const items = (count: number): Code => join(prefix.slice(0, count).map((item) => item.code), code`, `);
  for (let length = minExact; length <= lastExact; length += 1) {
    variants.push(typeCode(length === 0 ? code`[]` : code`[${items(length)}]`));
  }
  if (additional !== null && (max === undefined || max > prefix.length || min > prefix.length)) {
    variants.push(typeCode(code`[${items(prefix.length)}${prefix.length ? code`, ` : code``}...${arrayType(additional).code}]`));
  }
  return unionType(variants) ?? NEVER_TYPE;
}

function projectedResourceSchema(schema: unknown, context: SchemaTypeContext): unknown {
  if (!context.direction || context.document === undefined) return schema;
  return projectSchema(schema, {
    document: context.document,
    direction: context.direction,
    resources: context.resources,
  });
}

function cyclicSchemaRef(
  schema: unknown,
  currentBase: string,
  resources: ResourceIndex | undefined,
  inlining: ReadonlySet<string>,
  document?: unknown,
): boolean {
  if (!isJsonObject(schema) || !resources) return false;
  const reference = typeof schema.$ref === 'string'
    ? schema.$ref
    : typeof schema.$dynamicRef === 'string'
      ? schema.$dynamicRef
      : null;
  if (typeof reference !== 'string') return false;
  const target = resolveSchemaTarget(reference, nextSchemaBase(schema, currentBase, resources), resources, document);
  return Boolean(target && inlining.has(schemaTargetIdentity(target)));
}

function schemaWithoutCyclicRefs(
  schema: unknown,
  currentBase: string,
  resources: ResourceIndex | undefined,
  inlining: ReadonlySet<string>,
  document?: unknown,
): unknown {
  const cyclic: Record<string, unknown> = { ...asRecord(schema) };
  delete cyclic.$ref;
  delete cyclic.$dynamicRef;
  const dropCyclic = (value: unknown): boolean => !cyclicSchemaRef(value, currentBase, resources, inlining, document);
  if (isJsonObject(cyclic.properties)) {
    cyclic.properties = Object.fromEntries(objectEntries(cyclic.properties).filter(([, value]) => dropCyclic(value)));
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
    const children = cyclic[keyword];
    if (Array.isArray(children)) cyclic[keyword] = children.filter(dropCyclic);
  }
  if (cyclicSchemaRef(cyclic.items, currentBase, resources, inlining, document)) delete cyclic.items;
  return cyclic;
}

function inlinedTargetType(target: ResolvedSchemaTarget, context: SchemaTypeContext): TypeCode {
  const resources = context.resources;
  const identity = schemaTargetIdentity(target);
  const inner: SchemaTypeContext = {
    ...context,
    currentBase: target.currentBase,
    resources,
  };
  if (context.inlining?.has(identity)) {
    return schemaTypeNode(
      projectedResourceSchema(
        schemaWithoutCyclicRefs(target.schema, target.currentBase, resources, context.inlining, context.document),
        context,
      ),
      inner,
    );
  }
  const inlining = new Set(context.inlining);
  inlining.add(identity);
  return schemaTypeNode(projectedResourceSchema(target.schema, context), { ...inner, inlining });
}

/** The type named `name`, written after the qualifier of the context. */
function qualifiedType(context: SchemaTypeContext, name: string): TypeCode {
  return typeCode(context.qualifier ? code`${context.qualifier}${identifierPart(name)}` : identifierPart(name));
}

function referencedSchemaType(reference: string, context: SchemaTypeContext): TypeCode {
  const resources = context.resources;
  const currentBase = context.currentBase ?? '';
  if (resources) {
    const target = resolveSchemaTarget(reference, currentBase, resources, context.document);
    if (target) {
      if (target.exactComponent) return qualifiedType(context, target.exactComponent.typeName);
      return inlinedTargetType(target, context);
    }
  }
  const name = refName(reference);
  return name ? qualifiedType(context, name) : UNKNOWN_TYPE;
}

function isSchemaReference(schema: JsonObjectLike): boolean {
  return typeof schema.$ref === 'string' || typeof schema.$dynamicRef === 'string';
}

type AllOfRequirements = {
  /** Every name an inline member of the intersection requires. */
  readonly required: ReadonlySet<string>;
  /** Every name an inline member of the intersection declares as a property. */
  readonly declared: ReadonlySet<string>;
};

function allOfRequirements(schema: JsonObjectLike): AllOfRequirements {
  const required = new Set<string>();
  const declared = new Set<string>();
  const visit = (node: unknown): void => {
    if (!isJsonObject(node) || isSchemaReference(node)) return;
    for (const name of Array.isArray(node.required) ? node.required : []) required.add(String(name));
    for (const [name] of objectEntries(node.properties)) declared.add(name);
    for (const member of Array.isArray(node.allOf) ? node.allOf : []) visit(member);
  };
  visit(schema);
  return { required, declared };
}

/** Keeps the referenced type shared while requiring the given keys it declares. */
function requiredKeysType(type: TypeCode, names: readonly string[]): TypeCode {
  const operand = type.binds === 'primary' ? type.code : code`(${type.code})`;
  return typeCode(code`Required<Pick<${type.code}, Extract<${join(names.map((name) => literal(name)), code` | `)}, keyof ${operand}>>>`);
}

/** The schema's `required` names that neither its own properties nor an inline allOf member declare. */
function undeclaredRequiredNames(schema: JsonObjectLike, declaredByAllOf: ReadonlySet<string> = new Set()): string[] {
  if (!Array.isArray(schema.oneOf) && !Array.isArray(schema.anyOf)) return [];
  const own = new Set(objectEntries(schema.properties).map(([name]) => name));
  const names = Array.isArray(schema.required) ? schema.required.map(String) : [];
  return names.filter((name) => !own.has(name) && !declaredByAllOf.has(name));
}

/**
 * Applies required names inside the oneOf/anyOf branches of a schema. An inline branch gains them
 * in its `required`; a referenced branch is intersected with a `required` part so the allOf
 * machinery adds the required-key type. A branch that does not declare a name keeps its shape.
 */
function withUnionRequired(schema: JsonObjectLike, names: readonly string[]): JsonObjectLike {
  if (!names.length) return schema;
  const next: Record<string, unknown> = { ...schema };
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) next[keyword] = branches.map((branch) => withBranchRequired(branch, names));
  }
  return next;
}

function withBranchRequired(branch: unknown, names: readonly string[]): unknown {
  if (!isJsonObject(branch)) return branch;
  if (isSchemaReference(branch)) return { allOf: [branch, { required: [...names] }] };
  const declares = branch.properties !== undefined || Array.isArray(branch.allOf);
  const required = Array.isArray(branch.required) ? branch.required : [];
  return withUnionRequired(declares ? { ...branch, required: [...required, ...names] } : branch, names);
}

/**
 * The types an allOf member contributes. Every member's `required` names bind the intersection:
 * an inline member declaring the property emits it required, and a referenced member intersects
 * with a required-key part so the shared component's own type is unchanged. The names that no inline
 * member declares also apply inside the member's oneOf/anyOf branches.
 */
function allOfMemberTypes(item: unknown, requirements: AllOfRequirements, context: SchemaTypeContext): TypeCode[] {
  if (!isJsonObject(item)) return [schemaTypeNode(item, context)];
  if (isSchemaReference(item)) {
    const type = schemaTypeNode(item, context);
    const undeclared = [...requirements.required].filter((name) => !requirements.declared.has(name));
    return undeclared.length && !sameType(type, UNKNOWN_TYPE) ? [type, requiredKeysType(type, undeclared)] : [type];
  }
  const undeclared = [...requirements.required].filter((name) => !requirements.declared.has(name));
  const member = withUnionRequired(item, undeclared);
  if (requirements.required.size && (member.properties !== undefined || Array.isArray(member.allOf))) {
    return [schemaTypeNode({ ...member, required: [...requirements.required] }, context)];
  }
  return [schemaTypeNode(member, context)];
}

function schemaTypeNode(rawSchema: unknown, context: SchemaTypeContext = {}): TypeCode {
  if (rawSchema === true) return UNKNOWN_TYPE;
  if (rawSchema === false) return NEVER_TYPE;
  if (!isJsonObject(rawSchema)) return UNKNOWN_TYPE;
  const allOfNames = Array.isArray(rawSchema.allOf) && !isSchemaReference(rawSchema)
    ? allOfRequirements(rawSchema)
    : undefined;
  const requiredSchema = allOfNames?.required.size ? { ...rawSchema, required: [...allOfNames.required] } : rawSchema;
  const schema = withUnionRequired(requiredSchema, undeclaredRequiredNames(requiredSchema, allOfNames?.declared));
  const resources = context.resources ?? (context.document ? collectCanonicalResources(context.document) : undefined);
  const currentBase = nextSchemaBase(
    schema,
    context.currentBase ?? (context.document ? schemaDocumentBase(context.document) : ''),
    resources,
  );
  const inner: SchemaTypeContext = { ...context, resources, currentBase };
  if (typeof schema.$dynamicRef === 'string' || typeof schema.$ref === 'string') {
    const reference = String(schema.$dynamicRef || schema.$ref);
    const anchored = inner.anchors && inner.anchors.get(reference);
    if (anchored) return qualifiedType(inner, anchored);
  }
  if (typeof schema.$ref === 'string') {
    return referencedSchemaType(schema.$ref, inner);
  }
  if (typeof schema.$dynamicRef === 'string') {
    return referencedSchemaType(schema.$dynamicRef, inner);
  }
  if (schema.not === true) return NEVER_TYPE;
  if (schema.const !== undefined) return typeCode(literal(schema.const as JsonValue));
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return NEVER_TYPE;
    const excluded = isJsonObject(schema.not)
      ? new Set(
        schema.not.const !== undefined
          ? [JSON.stringify(schema.not.const)]
          : Array.isArray(schema.not.enum)
            ? schema.not.enum.map((value) => JSON.stringify(value))
            : [],
      )
      : new Set<string>();
    const values = schema.enum.filter((value) => !excluded.has(JSON.stringify(value)));
    return unionType(values.map((value) => typeCode(literal(value as JsonValue)))) ?? NEVER_TYPE;
  }
  const types = effectiveSchemaTypes(schema);
  const nullable = types.includes('null');
  const concrete = types.filter((type) => type !== 'null');
  const primitiveType = (type: string): TypeCode => {
    switch (type) {
    case 'string':
      return schema.format === 'binary' ? blobType(inner) : typeCode(code`string`);
    case 'integer':
    case 'number': return typeCode(code`number`);
    case 'boolean': return typeCode(code`boolean`);
    case 'array': {
      if (Array.isArray(schema.prefixItems)) return prefixItemsType(schema, (item) => schemaTypeNode(item, inner));
      return schema.items === false ? typeCode(code`[]`) : arrayType(schemaTypeNode(schema.items, inner));
    }
    case 'object': return objectType(schema, inner);
    case 'null': return NULL_TYPE;
    default:
      return UNKNOWN_TYPE;
    }
  };
  const baseParts = concrete.length
    ? concrete.map((type) => primitiveType(type))
    : nullable
      ? [NULL_TYPE]
    : schema.properties || schema.additionalProperties !== undefined
      ? [objectType(schema, inner)]
      : Array.isArray(schema.prefixItems) || schema.items
        ? [primitiveType('array')]
        : [];
  let result = unionType(baseParts);
  if (schema.oneOf || schema.anyOf) {
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
    const union = unionType(variants.map((item) => schemaTypeNode(item, inner)));
    if (union) result = result ? intersectionType([result, union]) : union;
  }
  if (Array.isArray(schema.allOf)) {
    const requirements = allOfNames ?? allOfRequirements(schema);
    const parts = schema.allOf
      .flatMap((item) => allOfMemberTypes(item, requirements, inner))
      .filter((part) => !sameType(part, UNKNOWN_TYPE));
    if (parts.length) result = intersectionType(result ? [result, ...parts] : parts);
  }
  if (!result) result = UNKNOWN_TYPE;
  return nullable && !sameType(result, UNKNOWN_TYPE) && !sameType(result, NULL_TYPE) ? orNull(result) : result;
}

/** The members of a braced type, one to a line, each line one level in. */
function bracedLines(lines: readonly Code[], closing: Code = code`}`): Code {
  return code`{${nest(join(lines.map((line) => code`${lineBreak}${line}`)))}${lineBreak}${closing}`;
}

function objectType(schema: JsonObjectLike, context: SchemaTypeContext): TypeCode {
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const properties = objectEntries(schema.properties);
  const propertyTypes = properties.map(([, value]) => schemaTypeNode(value, context));
  const members = properties.map(([name, value], index) => {
    const member = code`${propertyKey(name)}${required.has(name) ? code`` : code`?`}: ${propertyTypes[index]!.code};`;
    return isJsonObject(value) && value.description ? code`${descriptionComment(value.description)}${lineBreak}${member}` : member;
  });
  if (schema.additionalProperties) {
    const additionalType = schema.additionalProperties === true
      ? UNKNOWN_TYPE
      : schemaTypeCode(schema.additionalProperties, context);
    const optional = properties.some(([name]) => !required.has(name));
    const indexTypes = sameType(additionalType, UNKNOWN_TYPE)
      ? [UNKNOWN_TYPE]
      : distinctTypes([additionalType, ...propertyTypes, ...(optional ? [typeCode(code`undefined`)] : [])]);
    members.push(code`[key: string]: ${join(indexTypes.map((type) => type.code), code` | `)};`);
  }
  if (members.length) return typeCode(bracedLines(members));
  return schema.additionalProperties === false ? recordType(NEVER_TYPE) : recordType(UNKNOWN_TYPE);
}

type JsonObjectLike = { readonly [key: string]: unknown };

function inputType(operation: NormalizedOperation, context: SchemaTypeContext = {}): TypeCode {
  const groups: Record<string, NormalizedOperation['parameters'][number][]> = {
    path: [],
    query: [],
    header: [],
    cookie: [],
  };
  const queryString = operation.parameters.find((parameter) => parameter.in === 'querystring');
  const lines: Code[] = [];
  for (const parameter of operation.parameters) {
    if (!groups[parameter.in]) continue;
    groups[parameter.in].push(parameter);
  }
  if (queryString) {
    const schema = parameterSchema(queryString);
    lines.push(code`querystring${queryString.required ? code`` : code`?`}: ${schemaTypeCode(schema, context).code};`);
  }
  for (const [location, parameters] of Object.entries(groups)) {
    if (!parameters.length) continue;
    const requiredGroup = location === 'path' || parameters.some((parameter) => parameter.required);
    const fields = parameters.map((parameter) =>
      code`${propertyKey(parameter.name)}${parameter.required || location === 'path' ? code`` : code`?`}: ${schemaTypeCode(parameterSchema(parameter), context).code};`
    );
    lines.push(code`${identifierPart(location)}${requiredGroup ? code`` : code`?`}: ${bracedLines(fields, code`};`)}`);
  }
  if (operation.requestContent.length === 1) {
    lines.push(code`body${operation.requestBody?.required ? code`` : code`?`}: ${schemaTypeCode(operation.requestContent[0]?.schema ?? null, context).code};`);
  } else if (operation.requestContent.length > 1) {
    const variants = join(operation.requestContent.map((media) =>
      code`{ contentType: ${literal(media.contentType)}; value: ${schemaTypeCode(media.schema, context).code} }`
    ), code` | `);
    lines.push(code`body${operation.requestBody?.required ? code`` : code`?`}: ${variants};`);
  }
  return lines.length ? typeCode(bracedLines(lines)) : recordType(NEVER_TYPE);
}

function responseBodyType(response: NormalizedResponse, context: SchemaTypeContext = {}): TypeCode {
  if (!response.content || response.content.length === 0) return typeCode(code`void`);
  const types = response.content.map((media) => mediaBodyType(media, context));
  return unionType(types) ?? NEVER_TYPE;
}

function mediaBodyType(media: OpenApiMediaType, context: SchemaTypeContext = {}): TypeCode {
  if (media.itemSchemaPresent) {
    return typeCode(code`AsyncIterable<${schemaTypeCode(media.itemSchema, context).code}>`);
  }
  if (media.schema === null && isBinaryMediaType(media.contentType)) return blobType(context);
  return schemaTypeCode(media.schema, context);
}

function operationBodyType(operation: NormalizedOperation, success: boolean, context: SchemaTypeContext = {}): TypeCode {
  const responses = operation.responses.filter((response) => response.success === success);
  if (!responses.length) return UNKNOWN_TYPE;
  return unionType(responses.map((response) => responseBodyType(response, context))) ?? UNKNOWN_TYPE;
}

function responseHeadersType(document: unknown, response: NormalizedResponse, context: SchemaTypeContext = {}): TypeCode {
  const members = objectEntries(response.headers).map(([name, rawHeader]) => {
    const header = resolveLocal(document, rawHeader);
    return code`readonly ${propertyKey(name)}?: ${schemaTypeCode(parameterSchema(header), context).code}`;
  });
  return members.length ? typeCode(code`{ ${join(members, code`; `)} }`) : recordType(NEVER_TYPE);
}

function responseMatchType(status: string): Code {
  if (status === 'default') return code`'default'`;
  if (/^[1-5]XX$/i.test(status)) return code`'range'`;
  return code`'status'`;
}

function responseStatusType(status: string): Code {
  if (/^\d{3}$/.test(status)) return literal(Number(status));
  return code`number`;
}

function responseVariantTypes(document: unknown, response: NormalizedResponse, context: SchemaTypeContext = {}): TypeCode[] {
  const status = responseStatusType(response.status);
  const matched = responseMatchType(response.status);
  const headers = responseHeadersType(document, response, context).code;
  if (!response.content || response.content.length === 0) {
    return [typeCode(code`{ matched: ${matched}; status: ${status}; contentType: null; body: void; headers: ${headers} }`)];
  }
  return response.content.map((media) => {
    const body = mediaBodyType(media, context).code;
    return typeCode(code`{ matched: ${matched}; status: ${status}; contentType: ${literal(media.contentType)}; body: ${body}; headers: ${headers} }`);
  });
}

/** The file ends with its last line, not with blank lines. */
function dropTrailingBlankLines(lines: Code[]): void {
  while (lines.length > 0 && isEmpty(lines.at(-1)!)) lines.pop();
}

export function generateTypes(
  document: unknown,
  operations: readonly NormalizedOperation[],
  plan?: {
    readonly typesUsesInputSchemas: boolean;
    readonly typesUsesOutputSchemas: boolean;
  },
): RenderedModule {
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  const scope = new ComponentNameScope('types.ts');
  const useInput = plan ? plan.typesUsesInputSchemas : Object.keys(schemas).length > 0 && operations.length > 0;
  const useOutput = plan ? plan.typesUsesOutputSchemas : Object.keys(schemas).length > 0 && operations.length > 0;
  if (useInput) scope.claim('InputSchemas', 'import binding InputSchemas');
  if (useOutput) scope.claim('OutputSchemas', 'import binding OutputSchemas');
  const inputSchemas = new ImportSource('./input-schemas.js', true, { namespace: 'InputSchemas' });
  const outputSchemas = new ImportSource('./output-schemas.js', true, { namespace: 'OutputSchemas' });
  const blobTypeName = generatedBlobType(scope, objectEntries(schemas).map(([name]) => identifier(name)));
  const baseContext = schemaContext(document, { blobType: blobTypeName });
  const BLANK = code``;
  const body: Code[] = [];
  const blobTypeIndex = 0;
  for (const [name, rawSchema] of objectEntries(schemas)) {
    const schema = resolveLocal(document, rawSchema);
    const typeName = identifier(name);
    scope.claim(typeName, `component schema ${JSON.stringify(name)}`, name);
    const type = schemaTypeCode(
      schema,
      schemaContext(document, baseContext, name, schema),
    );
    const description = isJsonObject(schema) && schema.description
      ? code`${descriptionComment(schema.description)}${lineBreak}`
      : BLANK;
    body.push(code`${description}export type ${exportedName(typeName)} = ${type.code};`, BLANK);
  }
  if (Object.keys(schemas).length === 0 && operations.length === 0) body.push(code`export {};`);
  for (const operation of operations) {
    const inputContext = schemaContext(document, {
      direction: 'input',
      ...(useInput ? { qualifier: code`${inputSchemas.namespace()}.` } : {}),
      blobType: blobTypeName,
    });
    const outputContext = schemaContext(document, {
      direction: 'output',
      ...(useOutput ? { qualifier: code`${outputSchemas.namespace()}.` } : {}),
      blobType: blobTypeName,
    });
    scope.claim(`${operation.typeName}OperationInput`, `operation ${JSON.stringify(operation.name)} input type`);
    scope.claim(`${operation.typeName}OperationSuccessBody`, `operation ${JSON.stringify(operation.name)} success body`);
    scope.claim(`${operation.typeName}OperationErrorBody`, `operation ${JSON.stringify(operation.name)} error body`);
    scope.claim(`${operation.typeName}OperationHttpResponse`, `operation ${JSON.stringify(operation.name)} http response`);
    body.push(code`export type ${exportedName(`${operation.typeName}OperationInput`)} = ${inputType(operation, inputContext).code};`, BLANK);
    body.push(code`export type ${exportedName(`${operation.typeName}OperationSuccessBody`)} = ${operationBodyType(operation, true, outputContext).code};`, BLANK);
    body.push(code`export type ${exportedName(`${operation.typeName}OperationErrorBody`)} = ${operationBodyType(operation, false, outputContext).code};`, BLANK);
    body.push(
      code`export type ${exportedName(`${operation.typeName}OperationHttpResponse`)} =${responseUnion(operation.responses.flatMap((response) => responseVariantTypes(document, response, outputContext)))};`,
      BLANK,
    );
  }
  emitBlobType(body, blobTypeIndex, blobTypeName);
  dropTrailingBlankLines(body);
  const types = join(body, lineBreak);
  const output = join([
    generatedBannerComment(),
    manifestMarkerComment(),
    ...fileImports(types, [inputSchemas, outputSchemas]),
    BLANK,
    types,
  ], lineBreak);
  return renderModule(code`${output}\n`);
}

export function generateDirectionalSchemas(document: unknown, direction: 'input' | 'output'): string {
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  const scope = new ComponentNameScope(`${direction}-schemas.ts`);
  const blobTypeName = generatedBlobType(scope, objectEntries(schemas).map(([name]) => identifier(name)));
  const baseContext = schemaContext(document, { direction, blobType: blobTypeName });
  const BLANK = code``;
  const body: Code[] = [];
  for (const [name, rawSchema] of objectEntries(schemas)) {
    const schema = resolveLocal(document, rawSchema);
    const typeName = identifier(name);
    scope.claim(typeName, `component schema ${JSON.stringify(name)}`, name);
    const context = schemaContext(document, baseContext, name, schema);
    body.push(code`export type ${identifierPart(typeName)} = ${schemaTypeCode(schema, context).code};`, BLANK);
  }
  if (Object.keys(schemas).length === 0) body.push(code`export {};`);
  emitBlobType(body, 0, blobTypeName);
  dropTrailingBlankLines(body);
  return render(code`${join([
    generatedBannerComment(),
    docComment(`Component schemas projected for ${direction === 'input' ? 'request' : 'response'} data.`),
    BLANK,
    ...body,
  ], lineBreak)}\n`);
}
