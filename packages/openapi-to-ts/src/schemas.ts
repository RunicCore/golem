import { asRecord, isJsonObject, jsonLiteral, objectEntries } from './json.js';
import { identifier } from '@exprtlabs/codegen/generator-api';
import { sourceDigest } from '@exprtlabs/codegen/manifest';
import { escapePointerToken, unescapePointerToken } from '@exprtlabs/codegen/schema';
import {
  normalizeDocument,
  parameterSchema,
  type NormalizedDocument,
  type NormalizedOperation,
  type OpenApiSchema,
} from './normalize.js';
import { generatedBanner } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  buildRuntimeProjections,
  collectCanonicalResources,
  projectOperationSchema,
  type ResourceIndex,
} from './schema-projection.js';

function operationInputSchema(operation: NormalizedOperation): unknown {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const location of ['path', 'query', 'header', 'cookie'] as const) {
    const parameters = operation.parameters.filter((parameter) => parameter.in === location);
    if (!parameters.length) continue;
    const groupRequired = location === 'path' || parameters.some((parameter) => parameter.required);
    properties[location] = {
      type: 'object',
      properties: Object.fromEntries(
        parameters.map((parameter) => [parameter.name, parameterSchema(parameter) ?? true]),
      ),
      required: parameters
        .filter((parameter) => parameter.required || location === 'path')
        .map((parameter) => parameter.name),
      additionalProperties: false,
    };
    if (groupRequired) required.push(location);
  }
  const queryString = operation.parameters.find((parameter) => parameter.in === 'querystring');
  if (queryString) {
    properties.querystring = parameterSchema(queryString) ?? true;
    if (queryString.required) required.push('querystring');
  }
  if (operation.requestContent.length === 1) {
    properties.body = operation.requestContent[0]?.schema ?? true;
    if (operation.requestBody && operation.requestBody.required) required.push('body');
  } else if (operation.requestContent.length > 1) {
    properties.body = {
      oneOf: operation.requestContent.map((media) => ({
        type: 'object',
        properties: {
          contentType: { const: media.contentType },
          value: media.schema ?? true,
        },
        required: ['contentType', 'value'],
        additionalProperties: false,
      })),
    };
    if (operation.requestBody && operation.requestBody.required) required.push('body');
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function operationRuntimeSchemas(
  document: unknown,
  operations: readonly NormalizedOperation[],
  inputResourceId: string,
  outputResourceId: string,
  resources: ResourceIndex,
): Record<string, unknown> {
  return Object.fromEntries(operations.map((operation) => [
    operation.name,
    {
      input: projectOperationSchema(operationInputSchema(operation), document, 'input', inputResourceId, resources),
      responses: Object.fromEntries(operation.responses.map((response) => [
        response.status,
        Object.fromEntries(response.content.map((media) => [
          media.contentType,
          projectOperationSchema(
            media.itemSchemaPresent ? (media.itemSchema ?? false) : (media.schema ?? true),
            document,
            'output',
            outputResourceId,
            resources,
          ),
        ])),
      ])),
    },
  ]));
}

function normalizeRuntimeSchemaRecursive(schema: unknown): unknown {
  if (typeof schema === 'boolean') return schema;
  if (!isJsonObject(schema) || Array.isArray(schema)) return schema;
  const result: Record<string, unknown> = { ...schema };
  const mapKeywords = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
  const singleKeywords = [
    'items',
    'additionalProperties',
    'additionalItems',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'propertyNames',
    'unevaluatedProperties',
    'unevaluatedItems',
    'contentSchema',
  ];
  const arrayKeywords = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
  for (const keyword of mapKeywords) {
    if (isJsonObject(result[keyword])) {
      result[keyword] = Object.fromEntries(
        objectEntries(result[keyword]).map(([name, child]) => [
          name,
          normalizeRuntimeSchemaRecursive(child),
        ]),
      );
    }
  }
  for (const keyword of singleKeywords) {
    if (typeof result[keyword] === 'boolean') continue;
    if (isJsonObject(result[keyword])) {
      result[keyword] = normalizeRuntimeSchemaRecursive(result[keyword]);
    }
  }
  for (const keyword of arrayKeywords) {
    if (Array.isArray(result[keyword])) {
      result[keyword] = result[keyword].map((child) => normalizeRuntimeSchemaRecursive(child));
    }
  }
  if (result.format === 'binary') {
    if (result.type === 'string') {
      result.type = ['string', 'object'];
    } else if (Array.isArray(result.type) && result.type.includes('string') && !result.type.includes('object')) {
      result.type = result.type.flatMap((type) => (type === 'string' ? ['string', 'object'] : [type]));
    }
  }
  return result;
}

export function normalizeRuntimeSchema(schema: unknown): unknown {
  return normalizeRuntimeSchemaRecursive(schema);
}

function runtimeRegistry(registry: Record<string, unknown>): Record<string, unknown> {
  const components = asRecord(registry.components);
  const operations = asRecord(registry.operations);
  const defs = asRecord(registry.$defs);
  return {
    ...registry,
    components: {
      schemas: Object.fromEntries(
        objectEntries(components.schemas).map(([name, schema]) => [
          name,
          normalizeRuntimeSchema(schema),
        ]),
      ),
    },
    operations: Object.fromEntries(
      objectEntries(operations).map(([name, operation]) => {
        const record = asRecord(operation);
        const responses = asRecord(record.responses);
        return [
          name,
          {
            input: normalizeRuntimeSchema(record.input),
            responses: Object.fromEntries(
              objectEntries(responses).map(([status, content]) => [
                status,
                Object.fromEntries(
                  objectEntries(content).map(([contentType, schema]) => [
                    contentType,
                    normalizeRuntimeSchema(schema),
                  ]),
                ),
              ]),
            ),
          },
        ];
      }),
    ),
    ...(Object.keys(defs).length ? {
      $defs: Object.fromEntries(
        objectEntries(defs).map(([name, resource]) => {
          const record = asRecord(resource);
          const components = asRecord(record.components);
          const nestedDefs = asRecord(record.$defs);
          return [
            name,
            {
              ...record,
              ...(Object.keys(nestedDefs).length ? {
                $defs: Object.fromEntries(
                  objectEntries(nestedDefs).map(([defName, nested]) => [
                    defName,
                    normalizeRuntimeSchema(nested),
                  ]),
                ),
              } : {}),
              components: {
                schemas: Object.fromEntries(
                  objectEntries(components.schemas).map(([schemaName, schema]) => [
                    schemaName,
                    normalizeRuntimeSchema(schema),
                  ]),
                ),
              },
            },
          ];
        }),
      ),
    } : {}),
  };
}

export function buildSchemaData(document: unknown, preparedIr?: NormalizedDocument) {
  const ir = preparedIr ?? normalizeDocument(document);
  const operations = [...ir.operations, ...ir.inboundOperations];
  const rootId = `urn:runic:openapi:${identifier(asRecord(asRecord(document).info).title, 'api').toLowerCase()}:${sourceDigest(document)}:schemas`;
  const resources = collectCanonicalResources(document);
  const projections = operations.length
    ? buildRuntimeProjections(document, ir, rootId, resources)
    : null;
  const registry: Record<string, unknown> = {
    $id: rootId,
    components: { schemas: ir.schemas },
    operations: operationRuntimeSchemas(
      document,
      operations,
      projections?.inputResourceId ?? `${rootId}:input`,
      projections?.outputResourceId ?? `${rootId}:output`,
      resources,
    ),
    ...(projections ? {
      $defs: {
        'runic-input': projections.inputResource,
        ...(projections.outputResourceId !== projections.inputResourceId
          ? { 'runic-output': projections.outputResource } : {}),
      },
    } : {}),
  };
  registry.$schema = ir.schemaDialect;
  const normalizedRegistry = runtimeRegistry(registry);
  const schemaNames = Object.keys(ir.schemas);
  const operationNames = operations.map((operation) => operation.name);
  const responseSchemaEntries = operations.flatMap((operation) =>
    operation.responses.flatMap((response) =>
      response.content.map((media) => [operation.name, response.status, media.contentType])
    )
  );
  return {
    registry,
    normalizedRegistry,
    schemaNames,
    operationNames,
    responseSchemaEntries,
    schemaDialect: ir.schemaDialect,
    inputResourceId: projections?.inputResourceId ?? `${rootId}:input`,
    outputResourceId: projections?.outputResourceId ?? `${rootId}:output`,
  };
}

export interface OpenApiOperationValidationSchemaBundle {
  readonly operationRootId: string;
  readonly operationSchema: object | boolean;
  readonly inputReference: string;
  readonly responseReferences: readonly {
    readonly status: string;
    readonly contentType: string;
    readonly reference: string;
  }[];
  /** Selected operation root and its complete canonical component/resource closure. */
  readonly schemas: Readonly<Record<string, object | boolean>>;
  /** Shared schema resources emitted once and imported only by operations that use them. */
  readonly sharedResources: readonly {
    readonly id: string;
    readonly moduleName: string;
    readonly source: string;
  }[];
}



/**
 * A name inside a registry URN. The URN parser Ajv uses (fast-uri) rejects `~`,
 * and URI normalization decodes `%7E` back to it, so `~` is written as `$7E`.
 * `encodeURIComponent` never emits `$`, so the mapping stays one-to-one; the id
 * only has to be unique and stable, and `componentNamesById` maps it back.
 */
function urnSegment(value: string): string {
  return encodeURIComponent(value).replace(/~/g, '$7E');
}

function stableResourceSuffix(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

// 19 characters of directory + stem + ".output" + "-xxxxxx" + ".ts" stay within 100.
const MAX_SCHEMA_FILE_STEM = 64;

function schemaFileStem(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_$-]/g, '_').slice(0, MAX_SCHEMA_FILE_STEM);
  return safe || 'schema';
}

/**
 * Names validation-schema files `<Component>.<direction>.ts`. A short id suffix
 * is added only when two names collide on a case-insensitive file system. The
 * suffix hashes the id without the document digest, so editing the document
 * does not rename files.
 */
export function validationSchemaModuleNames(
  entries: readonly { readonly id: string; readonly name: string; readonly direction: SchemaDirection }[],
  rootId: string,
): ReadonlyMap<string, string> {
  const base = entries.map(item => ({ ...item, file: `${schemaFileStem(item.name)}.${item.direction}` }));
  const counts = new Map<string, number>();
  for (const item of base) counts.set(item.file.toLowerCase(), (counts.get(item.file.toLowerCase()) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const item of base) {
    const stableId = item.id.startsWith(rootId) ? item.id.slice(rootId.length) : item.id;
    const collides = (counts.get(item.file.toLowerCase()) ?? 0) > 1;
    names.set(item.id, `validation-schemas/${item.file}${collides ? `-${stableResourceSuffix(stableId).slice(0, 6)}` : ''}.ts`);
  }
  return names;
}

const schemaMapKeywords = new Set([
  '$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies',
]);
const schemaValueKeywords = new Set([
  'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
  'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);
const schemaArrayKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function mapSchemaPositions(
  value: unknown,
  rewrite: (schema: Record<string, unknown>) => void,
  active = new WeakMap<object, unknown>(),
): unknown {
  if (!isJsonObject(value)) return value;
  const previous = active.get(value);
  if (previous !== undefined) return previous;
  const result = Object.create(null) as Record<string, unknown>;
  active.set(value, result);
  for (const [keyword, item] of objectEntries(value)) {
    if (schemaMapKeywords.has(keyword) && isJsonObject(item)) {
      const children = Object.create(null) as Record<string, unknown>;
      for (const [name, child] of objectEntries(item)) {
        children[name] = Array.isArray(child) || isJsonObject(child) || typeof child === 'boolean'
          ? mapSchemaPositions(child, rewrite, active)
          : child;
      }
      result[keyword] = children;
    } else if (schemaValueKeywords.has(keyword)) {
      result[keyword] = Array.isArray(item)
        ? item.map((child) => mapSchemaPositions(child, rewrite, active))
        : isJsonObject(item) || typeof item === 'boolean' ? mapSchemaPositions(item, rewrite, active) : item;
    } else if (schemaArrayKeywords.has(keyword) && Array.isArray(item)) {
      result[keyword] = item.map((child) => mapSchemaPositions(child, rewrite, active));
    } else {
      result[keyword] = item;
    }
  }
  rewrite(result);
  active.delete(value);
  return result;
}

function visitSchemaPositions(
  value: unknown,
  visit: (schema: unknown) => void,
  active = new WeakSet<object>(),
): void {
  if (!isJsonObject(value) || active.has(value)) return;
  active.add(value);
  visit(value);
  const descend = (child: unknown): void => {
    if (isJsonObject(child)) visitSchemaPositions(child, visit, active);
    else if (Array.isArray(child)) {
      for (const item of child) if (isJsonObject(item)) visitSchemaPositions(item, visit, active);
    }
  };
  for (const [keyword, item] of objectEntries(value)) {
    if (schemaMapKeywords.has(keyword) && isJsonObject(item)) {
      for (const [, child] of objectEntries(item)) descend(child);
    } else if (schemaValueKeywords.has(keyword)) {
      descend(item);
    } else if (schemaArrayKeywords.has(keyword) && Array.isArray(item)) {
      for (const child of item) descend(child);
    }
  }
  active.delete(value);
}

function mapSchemaResource(value: unknown, visit: (schema: unknown) => unknown): unknown {
  if (!isJsonObject(value)) return value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [keyword, item] of objectEntries(value)) {
    if (keyword === 'components' && isJsonObject(item) && isJsonObject(item.schemas)) {
      const components = Object.create(null) as Record<string, unknown>;
      for (const [componentKey, componentValue] of objectEntries(item)) {
        if (componentKey === 'schemas' && isJsonObject(componentValue)) {
          const schemas = Object.create(null) as Record<string, unknown>;
          for (const [name, schema] of objectEntries(componentValue)) schemas[name] = visit(schema);
          components.schemas = schemas;
        } else {
          components[componentKey] = componentValue;
        }
      }
      result[keyword] = components;
    } else if (keyword === '$defs' && isJsonObject(item)) {
      const definitions = Object.create(null) as Record<string, unknown>;
      for (const [name, schema] of objectEntries(item)) definitions[name] = visit(schema);
      result[keyword] = definitions;
    } else {
      result[keyword] = item;
    }
  }
  return result;
}

function operationRootSchema(value: unknown, id: string): object | boolean {
  if (typeof value === 'boolean') return value ? { $id: id } : { $id: id, not: true };
  if (!isJsonObject(value)) throw new TypeError('Generated operation validation schema must be an object.');
  const root = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of objectEntries(value)) root[key] = child;
  root.$id = id;
  return root;
}

type SchemaDirection = 'input' | 'output';

interface DirectionalResource {
  readonly raw: unknown;
  readonly direction: SchemaDirection;
  readonly sourceId: string;
  readonly scopedId: string;
}

interface OperationValidationSchemaIndex {
  readonly data: ReturnType<typeof buildSchemaData>;
  readonly rootId: string;
  readonly directionalComponents: Readonly<Record<SchemaDirection, Readonly<Record<string, unknown>>>>;
  readonly inputProjectionId: string;
  readonly outputProjectionId: string;
  readonly componentById: Map<string, object | boolean>;
  readonly componentNamesById: Map<string, { readonly name: string; readonly direction: SchemaDirection }>;
  readonly moduleNames: ReadonlyMap<string, string>;
  readonly resourceById: Map<string, DirectionalResource>;
  readonly resourceIdsBySource: Map<string, string>;
  readonly rewrittenResources: Map<string, object | boolean>;
  readonly moduleSources: Map<string, { readonly moduleName: string; readonly source: string }>;
}

function resourceBaseId(value: string): string {
  const fragment = value.indexOf('#');
  return fragment < 0 ? value : value.slice(0, fragment);
}

function createOperationValidationSchemaIndex(
  document: unknown,
  preparedData?: ReturnType<typeof buildSchemaData>,
): OperationValidationSchemaIndex {
  const data = preparedData ?? buildSchemaData(document);
  const rootId = String(data.registry.$id);
  const projectionDefinitions = asRecord(data.normalizedRegistry.$defs);
  const inputProjection = asRecord(projectionDefinitions['runic-input']);
  const outputProjection = data.outputResourceId === data.inputResourceId
    ? inputProjection
    : asRecord(projectionDefinitions['runic-output']);
  const directionalResources = {
    input: asRecord(inputProjection.$defs),
    output: asRecord(outputProjection.$defs),
  };
  const resourceById = new Map<string, DirectionalResource>();
  const resourceIdsBySource = new Map<string, string>();
  for (const direction of ['input', 'output'] as const) {
    for (const [, raw] of objectEntries(directionalResources[direction])) {
      const sourceId = asRecord(raw).$id;
      if (typeof sourceId !== 'string') continue;
      const sourceBaseId = resourceBaseId(sourceId);
      const scopedId = `${rootId}:resource:${stableResourceSuffix(`${direction}:${sourceBaseId}`)}:${direction}`;
      const resource = { raw, direction, sourceId: sourceBaseId, scopedId } as const;
      resourceById.set(scopedId, resource);
      // Register every projected resource ID before adding convenience
      // aliases. A canonical resource ID can also look like another
      // resource's directional alias (for example `urn:example:input`).
      resourceIdsBySource.set(`${direction}\0${sourceBaseId}`, scopedId);
    }
    for (const [name, raw] of objectEntries(directionalResources[direction])) {
      const sourceId = asRecord(raw).$id;
      if (typeof sourceId !== 'string') continue;
      const sourceBaseId = resourceBaseId(sourceId);
      const scopedId = resourceIdsBySource.get(`${direction}\0${sourceBaseId}`);
      if (scopedId === undefined) continue;
      // Keep canonical source IDs in the resource index too; projected schemas
      // may contain either the directional URI or the original resource URI.
      const separator = sourceBaseId.endsWith(`:${direction}`) ? sourceBaseId.length - direction.length - 1 : -1;
      const aliases = [
        ...(separator >= 0 ? [sourceBaseId.slice(0, separator)] : []),
        ...(name !== sourceBaseId ? [name] : []),
      ];
      for (const alias of aliases) {
        const key = `${direction}\0${alias}`;
        if (!resourceIdsBySource.has(key)) resourceIdsBySource.set(key, scopedId);
      }
    }
  }
  const directionalComponents = {
    input: asRecord(asRecord(inputProjection.components).schemas),
    output: asRecord(asRecord(outputProjection.components).schemas),
  };
  const componentNamesById = new Map<string, { readonly name: string; readonly direction: SchemaDirection }>();
  const componentById = new Map<string, object | boolean>();
  for (const direction of ['input', 'output'] as const) {
    for (const name of Object.keys(directionalComponents[direction])) {
      const id = componentId({ rootId }, name, direction);
      componentNamesById.set(id, { name, direction });
    }
  }
  const moduleNames = validationSchemaModuleNames(
    [...componentNamesById].map(([id, { name, direction }]) => ({ id, name, direction })), rootId);
  return {
    data,
    rootId,
    directionalComponents,
    inputProjectionId: data.inputResourceId,
    outputProjectionId: data.outputResourceId,
    componentById,
    componentNamesById,
    moduleNames,
    resourceById,
    resourceIdsBySource,
    rewrittenResources: new Map(),
    moduleSources: new Map(),
  };
}

function componentId(index: Pick<OperationValidationSchemaIndex, 'rootId'>, name: string, direction: SchemaDirection): string {
  return `${index.rootId}:component:${urnSegment(name)}:${direction}`;
}

function rewriteResourceReference(
  index: OperationValidationSchemaIndex,
  reference: string,
  direction: SchemaDirection,
  keyword?: '$ref' | '$dynamicRef',
): string {
  const fragmentIndex = reference.indexOf('#');
  const base = fragmentIndex < 0 ? reference : reference.slice(0, fragmentIndex);
  const scopedId = index.resourceIdsBySource.get(`${direction}\0${base}`);
  if (scopedId === undefined) return reference;
  if (keyword === '$ref' && fragmentIndex >= 0) {
    const fragment = reference.slice(fragmentIndex + 1);
    if (fragment && !fragment.startsWith('/')) {
      const raw = asRecord(index.resourceById.get(scopedId)?.raw);
      let anchor = fragment;
      try { anchor = decodeURIComponent(fragment); } catch { /* Preserve malformed source text for normal resolution. */ }
      if (anchor === raw.$anchor || anchor === raw.$dynamicAnchor) return scopedId;
    }
  }
  return `${scopedId}${fragmentIndex < 0 ? '' : reference.slice(fragmentIndex)}`;
}

function rewriteOperationSchemaRefs(
  index: OperationValidationSchemaIndex,
  value: unknown,
  direction: SchemaDirection,
  localComponentScope = false,
): unknown {
  const { rootId } = index;
  const projectionId = direction === 'input' ? index.inputProjectionId : index.outputProjectionId;
  const componentReference = (reference: string, documentRelative: boolean): string | undefined => {
    const prefixes = [`${projectionId}#/components/schemas/`, `${rootId}#/components/schemas/`,
      ...(documentRelative ? ['#/components/schemas/'] : [])];
    const prefix = prefixes.find(candidate => reference.startsWith(candidate));
    if (prefix === undefined) return undefined;
    const [encodedName = '', ...fragment] = reference.slice(prefix.length).split('/');
    const suffix = fragment.length ? `/${fragment.join('/')}` : '';
    return `${componentId(index, unescapePointerToken(encodedName), direction)}${suffix ? `#${suffix}` : ''}`;
  };
  return mapSchemaPositions(value, (result) => {
    for (const key of ['$ref', '$dynamicRef'] as const) {
      const child = result[key];
      if (typeof child !== 'string') continue;
      result[key] = componentReference(child, localComponentScope) ?? rewriteResourceReference(index, child, direction, key);
    }
    // Mapping values name schemas in the source document. Point each at the id its
    // branch $ref uses: a component and its own `$id` resource denote one schema.
    const discriminator = result.discriminator;
    if (isJsonObject(discriminator) && isJsonObject(discriminator.mapping)) {
      const branches = Array.isArray(result.oneOf) ? result.oneOf : Array.isArray(result.anyOf) ? result.anyOf : [];
      const branchRefs = new Set(branches.flatMap(branch => isJsonObject(branch) && typeof branch.$ref === 'string' ? [branch.$ref] : []));
      const components = index.directionalComponents[direction];
      // A component with its own `$id` is projected as a `$ref` to that resource.
      const declaredId = (name: string): string | undefined => {
        const raw = asRecord(components[name]);
        const id = typeof raw.$id === 'string' ? raw.$id
          : typeof raw.$ref === 'string' && Object.keys(raw).length === 1 ? raw.$ref : undefined;
        return id === undefined ? undefined : componentReference(id, localComponentScope) ?? rewriteResourceReference(index, id, direction, '$ref');
      };
      const mapping = Object.create(null) as Record<string, unknown>;
      for (const [tag, target] of objectEntries(discriminator.mapping)) {
        if (typeof target !== 'string') {
          mapping[tag] = target;
          continue;
        }
        // A bare name is the OpenAPI shorthand for a component reference.
        const reference = /^[^/:#]+$/.test(target) ? `#/components/schemas/${escapePointerToken(target)}` : target;
        const component = componentReference(reference, true);
        const resource = rewriteResourceReference(index, reference, direction, '$ref');
        const name = reference.startsWith('#/components/schemas/')
          ? unescapePointerToken(reference.slice('#/components/schemas/'.length).split('/')[0] ?? '')
          : undefined;
        const candidates = [
          componentReference(reference, localComponentScope) ?? resource,
          ...(component ? [component] : []),
          ...(name === undefined ? [] : [declaredId(name)]),
          ...Object.keys(components).filter(candidate => declaredId(candidate) === resource).map(candidate => componentId(index, candidate, direction)),
        ].filter((candidate): candidate is string => candidate !== undefined);
        mapping[tag] = candidates.find(candidate => branchRefs.has(candidate)) ?? candidates[0];
      }
      result.discriminator = { ...discriminator, mapping };
    }
    if (typeof result.$id === 'string') {
      result.$id = rewriteResourceReference(index, result.$id, direction);
    }
  });
}

function rewrittenResource(
  index: OperationValidationSchemaIndex,
  id: string,
): object | boolean | undefined {
  const cached = index.rewrittenResources.get(id);
  if (cached !== undefined) return cached;
  const resource = index.resourceById.get(id);
  if (!resource) return undefined;
  const rewriteRefs = (schema: unknown): unknown => rewriteOperationSchemaRefs(index, schema, resource.direction);
  const rawComponents = asRecord(asRecord(resource.raw).components);
  const rewrittenValue = isJsonObject(resource.raw) && isJsonObject(rawComponents.schemas)
    ? mapSchemaResource(resource.raw, rewriteRefs)
    : rewriteRefs(resource.raw);
  if (!isJsonObject(rewrittenValue) && typeof rewrittenValue !== 'boolean') return undefined;
  const rewritten = isJsonObject(rewrittenValue)
    ? (() => {
      const schema = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of objectEntries(rewrittenValue)) {
        if (key !== '$id') schema[key] = child;
      }
      schema.$id = resource.scopedId;
      return schema;
    })()
    : rewrittenValue;
  index.rewrittenResources.set(id, rewritten as object | boolean);
  return rewritten as object | boolean;
}

function rewrittenComponent(
  index: OperationValidationSchemaIndex,
  id: string,
): object | boolean {
  const cached = index.componentById.get(id);
  if (cached !== undefined) return cached;
  const target = index.componentNamesById.get(id);
  if (!target) throw new Error(`Missing projected OpenAPI component schema ${JSON.stringify(id)}.`);
  const raw = index.directionalComponents[target.direction][target.name];
  if (raw === undefined) throw new Error(`Missing projected OpenAPI component schema ${JSON.stringify(target.name)} (${target.direction}).`);
  const schema = operationRootSchema(
    rewriteOperationSchemaRefs(index, raw, target.direction, true),
    id,
  );
  index.componentById.set(id, schema);
  return schema;
}

function operationBundleFromIndex(
  index: OperationValidationSchemaIndex,
  operation: NormalizedOperation,
): OpenApiOperationValidationSchemaBundle {
  const { data, rootId } = index;
  const operationRootId = `${rootId}:operation:${urnSegment(operation.name)}`;
  const operationRegistryEntry = asRecord(asRecord(data.normalizedRegistry.operations)[operation.name]);
  const operationSchemas = Object.create(null) as Record<string, unknown>;
  operationSchemas.input = rewriteOperationSchemaRefs(index, operationRegistryEntry.input, 'input');
  const responseSchemas = Object.create(null) as Record<string, unknown>;
  const rawResponses = asRecord(operationRegistryEntry.responses);
  for (const [status, rawContent] of objectEntries(rawResponses)) {
    const content = Object.create(null) as Record<string, unknown>;
    for (const [mediaType, schema] of objectEntries(rawContent)) {
      content[mediaType] = rewriteOperationSchemaRefs(index, schema, 'output');
    }
    responseSchemas[status] = content;
  }
  operationSchemas.responses = responseSchemas;
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  root.$id = operationRootId;
  if (typeof data.normalizedRegistry.$schema === 'string') root.$schema = data.normalizedRegistry.$schema;
  const operationRecords = Object.create(null) as Record<string, unknown>;
  operationRecords[operation.name] = operationSchemas;
  root.operations = operationRecords;
  const schemaRoot = root as object;

  const schemas = Object.create(null) as Record<string, object | boolean>;
  schemas[operationRootId] = schemaRoot;
  const pending: Array<{ readonly ref: string; readonly direction: SchemaDirection }> = [];
  const visitRefs = (
    value: unknown,
    direction: SchemaDirection,
    visitor: (ref: string, direction: SchemaDirection) => void,
  ): void => {
    if (isJsonObject(value) && isJsonObject(asRecord(value.components).schemas)) {
      for (const schema of Object.values(asRecord(asRecord(value.components).schemas))) visitRefs(schema, direction, visitor);
      for (const nested of Object.values(asRecord(value.$defs))) visitRefs(nested, direction, visitor);
      return;
    }
    visitSchemaPositions(value, (schema) => {
      if (!isJsonObject(schema)) return;
      for (const key of ['$ref', '$dynamicRef'] as const) {
        const ref = Reflect.get(schema, key);
        if (typeof ref === 'string') visitor(ref, direction);
      }
    });
  };
  const collectReference = (ref: string, direction: SchemaDirection): void => {
    if (ref.startsWith(`${operationRootId}#`)) return;
    const baseId = resourceBaseId(ref);
    if (index.componentNamesById.has(baseId)) {
      const target = index.componentNamesById.get(baseId);
      pending.push({ ref, direction: target?.direction ?? direction });
      return;
    }
    pending.push({ ref, direction });
  };
  visitRefs(operationSchemas.input, 'input', collectReference);
  for (const content of Object.values(responseSchemas)) {
    for (const schema of Object.values(asRecord(content))) visitRefs(schema, 'output', collectReference);
  }
  const visited = new Set<string>();
  const moduleById = new Map<string, string>();
  while (pending.length) {
    const item = pending.pop();
    if (!item) continue;
    const baseId = resourceBaseId(item.ref);
    if (visited.has(baseId)) continue;
    visited.add(baseId);
    if (item.ref.startsWith('#')) continue;
    let schema = index.componentById.get(baseId) ?? rewrittenResource(index, baseId);
    if (schema === undefined && index.componentNamesById.has(baseId)) {
      schema = rewrittenComponent(index, baseId);
    }
    if (schema === undefined) {
      throw new Error(`Unresolved OpenAPI validation schema reference ${JSON.stringify(item.ref)}.`);
    }
    schemas[baseId] = schema;
    const moduleName = index.moduleNames.get(baseId)
      ?? `validation-schemas/resource-${stableResourceSuffix(baseId.startsWith(index.rootId) ? baseId.slice(index.rootId.length) : baseId).slice(0, 12)}.ts`;
    moduleById.set(baseId, moduleName);
    let module = index.moduleSources.get(baseId);
    if (!module) {
      const schemaJson = JSON.stringify(schema);
      if (schemaJson === undefined) throw new TypeError(`OpenAPI schema resource ${JSON.stringify(baseId)} is not serializable.`);
      module = {
        moduleName,
        source: `${generatedBanner()}\nexport const schemaId = ${JSON.stringify(baseId)} as const;\nexport const schema = JSON.parse(${JSON.stringify(schemaJson)}) as object | boolean;\n`,
      };
      index.moduleSources.set(baseId, module);
    }
    visitRefs(schema, item.direction, collectReference);
  }

  const inputReference = `${operationRootId}#/operations/${escapePointerToken(operation.name)}/input`;
  const responseReferences = operation.responses.flatMap((response) => response.content.map((media) => ({
    status: response.status,
    contentType: media.contentType,
    reference: `${operationRootId}#/operations/${escapePointerToken(operation.name)}/responses/${escapePointerToken(response.status)}/${escapePointerToken(media.contentType)}`,
  })));
  return {
    operationRootId,
    operationSchema: schemaRoot,
    inputReference,
    responseReferences,
    schemas,
    sharedResources: [...moduleById].map(([id, moduleName]) => ({
      id,
      moduleName,
      source: index.moduleSources.get(id)?.source ?? '',
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Build every operation closure against one projected/indexed schema view. The
 * directional component and external-resource rewrites are memoized across
 * operations, avoiding a document-wide schema walk for every operation.
 */
export function buildOperationValidationSchemaBundles(
  document: unknown,
  operations: readonly NormalizedOperation[],
  preparedData?: ReturnType<typeof buildSchemaData>,
): ReadonlyMap<string, OpenApiOperationValidationSchemaBundle> {
  const index = createOperationValidationSchemaIndex(document, preparedData);
  return new Map(operations.map((operation) => [operation.name, operationBundleFromIndex(index, operation)]));
}

/** Build one operation closure for consumers that do not already batch operations. */
export function buildOperationValidationSchemaBundle(
  document: unknown,
  operation: NormalizedOperation,
  preparedData?: ReturnType<typeof buildSchemaData>,
): OpenApiOperationValidationSchemaBundle {
  return buildOperationValidationSchemaBundles(document, [operation], preparedData).get(operation.name)
    ?? (() => { throw new Error(`Missing OpenAPI operation ${JSON.stringify(operation.name)}.`); })();
}

export function generateSchemas(
  document: unknown,
  profile: OpenApiGenerationProfile,
  preparedData?: ReturnType<typeof buildSchemaData>,
): string {
  requireProfile(profile);
  const { registry, normalizedRegistry, schemaNames, operationNames, responseSchemaEntries, schemaDialect } =
    preparedData ?? buildSchemaData(document);
  const registryJson = jsonLiteral(registry, 2);
  const normalizedRegistryJson = jsonLiteral(normalizedRegistry, 2);
  const normalizedRegistryIsSame = JSON.stringify(registry) === JSON.stringify(normalizedRegistry);
  if (!profile.validation) {
    return `${generatedBanner()}
/** Protocol metadata retained for generated routing and response matching. */
export const schemaDialect = ${JSON.stringify(schemaDialect)} as const;
export const schemaNames = ${JSON.stringify(schemaNames)} as const;
export type SchemaName = (typeof schemaNames)[number];
export const operationNames = ${JSON.stringify(operationNames)} as const;
export type OperationName = (typeof operationNames)[number];
export const operationResponseSchemaEntries: ReadonlyArray<
  readonly [OperationName, string, string]
> = ${JSON.stringify(responseSchemaEntries)};
`;
  }
  return `${generatedBanner()}
/** Exact component and operation schemas retained for runtime validation. */
export const schemaDialect = ${JSON.stringify(schemaDialect)} as const;
export const schemaRegistry = ${registryJson} as const;
/** JSON Schema 2020-compatible evaluation form; differs from schemaRegistry only where a binary-format string is widened to accept a Blob/File runtime value. */
export const runtimeSchemaRegistry = ${normalizedRegistryIsSame ? 'schemaRegistry' : `${normalizedRegistryJson} as const`};
export const schemaNames = ${JSON.stringify(schemaNames)} as const;
export type SchemaName = (typeof schemaNames)[number];
export const operationNames = ${JSON.stringify(operationNames)} as const;
export type OperationName = (typeof operationNames)[number];
export const operationResponseSchemaEntries: ReadonlyArray<
  readonly [OperationName, string, string]
> = ${JSON.stringify(responseSchemaEntries)};

function pointerToken(value: string): string {
  return encodeURIComponent(value.replace(/~/g, '~0').replace(/\\//g, '~1'));
}

export function schemaReference(name: SchemaName): string {
  return \`\${schemaRegistry.$id}#/components/schemas/\${pointerToken(String(name))}\`;
}

export function operationInputReference(name: OperationName): string {
  return \`\${schemaRegistry.$id}#/operations/\${pointerToken(String(name))}/input\`;
}

export function operationResponseReference(
  name: OperationName,
  status: string,
  contentType: string,
): string {
  return \`\${schemaRegistry.$id}#/operations/\${pointerToken(String(name))}/responses/\${pointerToken(status)}/\${pointerToken(contentType)}\`;
}
`;
}

export type { OpenApiSchema };
