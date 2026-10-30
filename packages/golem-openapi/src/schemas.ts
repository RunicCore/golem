import { asRecord, isJsonObject, objectEntries } from './json.js';
import { unionVariants } from './composition.js';
import { SCHEMA_ARRAY_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_SINGLE_KEYWORDS } from './schema-keywords.js';
import { identifier, sourceDigest } from '@exprtlabs/golem/internal/generator-support';
import { decodeUriFragment, escapePointerToken, unescapePointerToken } from '@exprtlabs/golem/internal/schema';
import {
  normalizeDocument,
  parameterSchema,
  resolveLocal,
  type NormalizedDocument,
  type NormalizedOperation,
} from './normalize.js';
import {
  buildRuntimeProjections,
  collectCanonicalResources,
  projectOperationSchema,
  type ResourceIndex,
} from './schema-projection.js';

/** The schema of the header parameters of an operation, checked apart from the rest of the input: none when it has no header parameter. Header names are open: a request carries headers the operation does not declare (host, content-type), and only the declared ones are checked. */
function operationHeadersSchema(operation: NormalizedOperation): unknown {
  const parameters = operation.parameters.filter((parameter) => parameter.in === 'header');
  return parameters.length
    ? {
      type: 'object',
      properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameterSchema(parameter) ?? true])),
      required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    }
    : undefined;
}

function operationInputSchema(operation: NormalizedOperation): unknown {
  // Headers are open here: the header root checks the declared ones (see `operationHeadersSchema`), and a request carries more.
  const properties: Record<string, unknown> = { header: true };
  const required: string[] = [];
  for (const location of ['path', 'query', 'cookie'] as const) {
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
    const [media] = operation.requestContent;
    properties.body = media?.schema ?? true;
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

/** The schema of each declared response header that has one, by response status and header name; a status with none is left out. */
function responseHeaderSchemas(operation: NormalizedOperation, document: unknown): Record<string, Record<string, unknown>> {
  const byStatus = operation.responses.map((response) => [response.status, Object.fromEntries(objectEntries(response.headers).flatMap(([name, header]) => {
    const schema = parameterSchema(resolveLocal(document, header));
    return schema === null ? [] : [[name, schema] as const];
  }))] as const);
  return Object.fromEntries(byStatus.filter(([, headers]) => Object.keys(headers).length > 0));
}

/** The schemas of an operation's validation root before projection, at the places its pointers name: `input`, `headers`, `responses/<status>/<media type>` and `responseHeaders/<status>/<header name>`. */
export function operationSourceSchemas(operation: NormalizedOperation, document: unknown): {
  readonly input: unknown;
  readonly headers?: unknown;
  readonly responses: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly responseHeaders: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
} {
  const headers = operationHeadersSchema(operation);
  return {
    input: operationInputSchema(operation),
    ...(headers === undefined ? {} : { headers }),
    responseHeaders: responseHeaderSchemas(operation, document),
    responses: Object.fromEntries(operation.responses.map((response) => [
      response.status,
      Object.fromEntries(response.content.map((media) => [
        media.contentType,
        media.itemSchemaPresent ? (media.itemSchema ?? false) : (media.schema ?? true),
      ])),
    ])),
  };
}

function operationRuntimeSchemas(
  document: unknown,
  operations: readonly NormalizedOperation[],
  inputResourceId: string,
  outputResourceId: string,
  resources: ResourceIndex,
): Record<string, unknown> {
  return Object.fromEntries(operations.map((operation) => {
    const source = operationSourceSchemas(operation, document);
    return [
      operation.name,
      {
        input: projectOperationSchema(source.input, document, 'input', inputResourceId, resources),
        ...(source.headers === undefined ? {} : { headers: projectOperationSchema(source.headers, document, 'input', inputResourceId, resources) }),
        responses: Object.fromEntries(Object.entries(source.responses).map(([status, content]) => [
          status,
          Object.fromEntries(Object.entries(content).map(([mediaType, schema]) => [
            mediaType,
            projectOperationSchema(schema, document, 'output', outputResourceId, resources),
          ])),
        ])),
        responseHeaders: Object.fromEntries(Object.entries(source.responseHeaders).map(([status, headers]) => [
          status,
          Object.fromEntries(Object.entries(headers).map(([name, schema]) => [
            name,
            projectOperationSchema(schema, document, 'output', outputResourceId, resources),
          ])),
        ])),
      },
    ];
  }));
}

function normalizeRuntimeSchema(schema: unknown): unknown {
  if (typeof schema === 'boolean') return schema;
  if (!isJsonObject(schema) || Array.isArray(schema)) return schema;
  const result: Record<string, unknown> = { ...schema };
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    if (isJsonObject(result[keyword])) {
      result[keyword] = Object.fromEntries(
        objectEntries(result[keyword]).map(([name, child]) => [
          name,
          normalizeRuntimeSchema(child),
        ]),
      );
    }
  }
  for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
    if (typeof result[keyword] === 'boolean') continue;
    if (isJsonObject(result[keyword])) {
      result[keyword] = normalizeRuntimeSchema(result[keyword]);
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    if (Array.isArray(result[keyword])) {
      result[keyword] = result[keyword].map((child) => normalizeRuntimeSchema(child));
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

/** The schemas of a table by response status and then by media type or header name, normalized. */
function normalizeRuntimeSchemas(table: unknown): Record<string, Record<string, unknown>> {
  return Object.fromEntries(objectEntries(table).map(([status, entries]) => [
    status,
    Object.fromEntries(objectEntries(entries).map(([key, schema]) => [key, normalizeRuntimeSchema(schema)])),
  ]));
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
            ...(record.headers === undefined ? {} : { headers: normalizeRuntimeSchema(record.headers) }),
            responses: normalizeRuntimeSchemas(responses),
            responseHeaders: normalizeRuntimeSchemas(record.responseHeaders),
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
  const rootId = `urn:golem:openapi:${identifier(asRecord(asRecord(document).info).title, 'api').toLowerCase()}:${sourceDigest(document)}:schemas`;
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
        'golem-input': projections.inputResource,
        ...(projections.outputResourceId !== projections.inputResourceId
          ? { 'golem-output': projections.outputResource } : {}),
      },
    } : {}),
  };
  registry.$schema = ir.schemaDialect;
  const normalizedRegistry = runtimeRegistry(registry);
  return {
    registry,
    normalizedRegistry,
    inputResourceId: projections?.inputResourceId ?? `${rootId}:input`,
    outputResourceId: projections?.outputResourceId ?? `${rootId}:output`,
  };
}

interface OpenApiOperationValidationSchemaBundle {
  readonly inputReference: string;
  /** The root of the header parameters, checked apart from `inputReference`; none when the operation has no header parameter. */
  readonly headersReference?: string;
  readonly responseReferences: readonly {
    readonly status: string;
    readonly contentType: string;
    readonly reference: string;
  }[];
  /** The root of each declared response header that has a schema, checked in its wire form. */
  readonly responseHeaderReferences: readonly {
    readonly status: string;
    readonly name: string;
    readonly reference: string;
  }[];
  /** Selected operation root and its complete canonical component/resource closure. */
  readonly schemas: Readonly<Record<string, object | boolean>>;
  /**
   * What `compile` validates, one root for the input and one for each response, keyed by the references above.
   * Each root names its schema inside the operation root; a reference never equals the pointer it names, so the
   * compiler reads the pointer as a reference to the operation root and not as the root itself.
   */
  readonly roots: Readonly<Record<string, object>>;
  /** The component name behind each schema of the closure that is a component, keyed like `schemas`. */
  readonly componentNames: Readonly<Record<string, string>>;
  /** The id of the operation root schema, which holds the operation's own inline schemas. */
  readonly operationRootId: string;
  readonly operationName: string;
}

/**
 * A name inside a registry URN. URN parsers reject `~`,
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

// The shared keyword tables as sets, with the legacy `dependencies` keyword added where a schema is walked.
const schemaMapKeywords = new Set([...SCHEMA_MAP_KEYWORDS, 'dependencies']);
const schemaValueKeywords = new Set(SCHEMA_SINGLE_KEYWORDS);
const schemaArrayKeywords = new Set(SCHEMA_ARRAY_KEYWORDS);

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
  readonly resourceById: Map<string, DirectionalResource>;
  readonly resourceIdsBySource: Map<string, string>;
  readonly rewrittenResources: Map<string, object | boolean>;
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
  const inputProjection = asRecord(projectionDefinitions['golem-input']);
  const outputProjection = data.outputResourceId === data.inputResourceId
    ? inputProjection
    : asRecord(projectionDefinitions['golem-output']);
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
  return {
    data,
    rootId,
    directionalComponents,
    inputProjectionId: data.inputResourceId,
    outputProjectionId: data.outputResourceId,
    componentById,
    componentNamesById,
    resourceById,
    resourceIdsBySource,
    rewrittenResources: new Map(),
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
      const anchor = decodeUriFragment(fragment);
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
      const branches = unionVariants(result) ?? [];
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
  if (operationRegistryEntry.headers !== undefined) operationSchemas.headers = rewriteOperationSchemaRefs(index, operationRegistryEntry.headers, 'input');
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
  const responseHeaderSchemas = Object.create(null) as Record<string, unknown>;
  for (const [status, headers] of objectEntries(operationRegistryEntry.responseHeaders)) {
    const rewritten = Object.create(null) as Record<string, unknown>;
    for (const [name, schema] of objectEntries(headers)) rewritten[name] = rewriteOperationSchemaRefs(index, schema, 'output');
    responseHeaderSchemas[status] = rewritten;
  }
  operationSchemas.responseHeaders = responseHeaderSchemas;
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  root.$id = operationRootId;
  if (typeof data.normalizedRegistry.$schema === 'string') root.$schema = data.normalizedRegistry.$schema;
  const operationRecords = Object.create(null) as Record<string, unknown>;
  operationRecords[operation.name] = operationSchemas;
  root.operations = operationRecords;
  const schemaRoot = root as object;

  const schemas = Object.create(null) as Record<string, object | boolean>;
  const componentNames = Object.create(null) as Record<string, string>;
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
  if (operationSchemas.headers !== undefined) visitRefs(operationSchemas.headers, 'input', collectReference);
  for (const content of Object.values(responseSchemas)) {
    for (const schema of Object.values(asRecord(content))) visitRefs(schema, 'output', collectReference);
  }
  for (const headers of Object.values(responseHeaderSchemas)) {
    for (const schema of Object.values(asRecord(headers))) visitRefs(schema, 'output', collectReference);
  }
  const visited = new Set<string>();
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
    const component = index.componentNamesById.get(baseId);
    if (component !== undefined) componentNames[baseId] = component.name;
    visitRefs(schema, item.direction, collectReference);
  }

  const pointerBase = `${operationRootId}#/operations/${escapePointerToken(operation.name)}`;
  // A root is named by its operation and slot: the validator's export name comes from it (`validate_getPayment_input`).
  const inputReference = `${operation.name}:input`;
  const roots = Object.create(null) as Record<string, object>;
  roots[inputReference] = { $ref: `${pointerBase}/input` };
  const headersReference = operationSchemas.headers === undefined ? undefined : `${operation.name}:headers`;
  if (headersReference !== undefined) roots[headersReference] = { $ref: `${pointerBase}/headers` };
  const responseReferences = operation.responses.flatMap((response) => response.content.map((media) => {
    const reference = `${operation.name}:response:${response.status}:${media.contentType}`;
    roots[reference] = { $ref: `${pointerBase}/responses/${escapePointerToken(response.status)}/${escapePointerToken(media.contentType)}` };
    return { status: response.status, contentType: media.contentType, reference };
  }));
  const responseHeaderReferences = Object.entries(responseHeaderSchemas).flatMap(([status, headers]) => Object.keys(asRecord(headers)).map((name) => {
    const reference = `${operation.name}:response-header:${status}:${name}`;
    roots[reference] = { $ref: `${pointerBase}/responseHeaders/${escapePointerToken(status)}/${escapePointerToken(name)}` };
    return { status, name, reference };
  }));
  return {
    inputReference,
    ...(headersReference === undefined ? {} : { headersReference }),
    responseReferences,
    responseHeaderReferences,
    schemas,
    roots,
    componentNames,
    operationRootId,
    operationName: operation.name,
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
  const bundle = buildOperationValidationSchemaBundles(document, [operation], preparedData).get(operation.name);
  if (!bundle) throw new Error(`Missing OpenAPI operation ${JSON.stringify(operation.name)}.`);
  return bundle;
}
