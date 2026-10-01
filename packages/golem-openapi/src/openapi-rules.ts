import {
  asRecord,
  isJsonObject,
  jsonPointerJoin as pointerJoin,
  objectEntries,
  openApiLine,
  resolveJsonPointer,
  type JsonObject,
} from './json.js';
import type { OpenApiProblem } from './openapi-validator.js';
import { isMappingComponentName } from './reference-loader.js';
import { collectCanonicalResources, lookupCanonicalResource, visitOpenApiSchemaTree } from './schema-projection.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'] as const;
const TEMPLATE = /\{([^{}]*)\}/g;

/**
 * A `$ref` fragment (the part after `#`) is a URI fragment and may be
 * percent-encoded (e.g. `#/components/schemas/A%20B`); `resolveJsonPointer`
 * itself only understands plain RFC 6901 tokens (no percent-decoding), so
 * every fragment is decoded once, here, before it reaches the resolver. A
 * fragment without percent-encoding decodes to itself.
 */
function decodeRefFragment(pointer: string): string {
  try {
    return decodeURIComponent(pointer);
  } catch {
    return pointer;
  }
}

/** Follow in-document Reference Objects; the pointer is where the value actually lives. */
function resolveWithPointer(document: unknown, value: unknown, pointer: string): { readonly value: unknown; readonly pointer: string } {
  let current = value;
  let currentPointer = pointer;
  for (let depth = 0; depth < 32; depth += 1) {
    if (!isJsonObject(current) || typeof current.$ref !== 'string' || !current.$ref.startsWith('#/')) break;
    const targetPointer = decodeRefFragment(current.$ref.slice(1));
    const next = resolveJsonPointer(document, targetPointer);
    if (next === undefined) break;
    current = next;
    currentPointer = targetPointer;
  }
  return { value: current, pointer: currentPointer };
}

interface OperationEntry {
  readonly pointer: string;
  readonly method: string;
  readonly operation: JsonObject;
  readonly pathItem: JsonObject;
  readonly pathItemPointer: string;
  /** The `paths` key for path operations; null for webhooks and callbacks. */
  readonly route: string | null;
}

function collectPathItemOperations(
  document: unknown,
  rawPathItem: unknown,
  writtenPointer: string,
  route: string | null,
  out: OperationEntry[],
  visited: Set<string>,
): void {
  const { value: pathItem, pointer: pathItemPointer } = resolveWithPointer(document, rawPathItem, writtenPointer);
  if (!isJsonObject(pathItem)) return;
  const visitKey = `${pathItemPointer}\u0000${route ?? ''}`;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);
  const add = (method: string, rawOperation: unknown, pointer: string): void => {
    if (!isJsonObject(rawOperation)) return;
    out.push({ pointer, method, operation: rawOperation, pathItem, pathItemPointer, route });
    for (const [name, rawCallback] of objectEntries(rawOperation.callbacks)) {
      const callbackPointer = pointerJoin(pointerJoin(pointer, 'callbacks'), name);
      const callback = resolveWithPointer(document, rawCallback, callbackPointer);
      for (const [expression, item] of objectEntries(callback.value)) {
        collectPathItemOperations(document, item, pointerJoin(callback.pointer, expression), null, out, visited);
      }
    }
  };
  for (const method of HTTP_METHODS) {
    if (pathItem[method] !== undefined) add(method, pathItem[method], pointerJoin(pathItemPointer, method));
  }
  for (const [method, operation] of objectEntries(pathItem.additionalOperations)) {
    add(method, operation, pointerJoin(pointerJoin(pathItemPointer, 'additionalOperations'), method));
  }
}

function collectRuleOperations(document: unknown): OperationEntry[] {
  const out: OperationEntry[] = [];
  const visited = new Set<string>();
  const root = asRecord(document);
  for (const [route, item] of objectEntries(root.paths)) {
    if (route.startsWith('x-')) continue;
    collectPathItemOperations(document, item, pointerJoin('/paths', route), route, out, visited);
  }
  for (const [name, item] of objectEntries(root.webhooks)) {
    if (name.startsWith('x-')) continue;
    collectPathItemOperations(document, item, pointerJoin('/webhooks', name), null, out, visited);
  }
  return out;
}

interface ResolvedParameter {
  readonly name: string;
  readonly location: string;
  readonly pointer: string;
}

function resolvedParameters(document: unknown, list: unknown, listPointer: string): ResolvedParameter[] {
  if (!Array.isArray(list)) return [];
  const parameters: ResolvedParameter[] = [];
  list.forEach((raw, index) => {
    const parameter = resolveWithPointer(document, raw, `${listPointer}/${index}`).value;
    if (isJsonObject(parameter) && typeof parameter.name === 'string' && typeof parameter.in === 'string') {
      parameters.push({ name: parameter.name, location: parameter.in, pointer: `${listPointer}/${index}` });
    }
  });
  return parameters;
}

function checkUnresolvedRefs(document: unknown): OpenApiProblem[] {
  const resources = collectCanonicalResources(document);
  const problems: OpenApiProblem[] = [];
  const resolvesPointer = (pointer: string): boolean => resolveJsonPointer(document, decodeRefFragment(pointer)) !== undefined;
  const rootSchemaNames = new Set(Object.keys(asRecord(asRecord(asRecord(document).components).schemas)));
  const check = (reference: string, currentBase: string | null, walkerPointer: string, label = '$ref'): void => {
    if (reference === '#') return;
    if (reference.startsWith('#/')) {
      if (resolvesPointer(reference.slice(1))) return;
    } else if (reference.startsWith('#')) {
      return; // Plain-name anchors are resolved by the JSON Schema engine.
    } else if (currentBase !== null && lookupCanonicalResource(reference, currentBase, resources)?.hasId) {
      return;
    }
    problems.push({ ruleId: 'no-unresolved-refs', message: `Can't resolve ${label} ${reference}`, pointer: walkerPointer.slice(1) });
  };
  visitOpenApiSchemaTree(document, {
    onSchemaRef(_keyword, reference, currentBase, pointer) { check(reference, currentBase, pointer); },
    onOpenApiRef(reference, pointer) { check(reference, null, pointer); },
    onDiscriminatorMapping(keyword, reference, currentBase, ownerPointer, property) {
      if (keyword !== 'mapping' || isMappingComponentName(reference, rootSchemaNames)) return;
      check(reference, currentBase, pointerJoin(ownerPointer, property), 'discriminator mapping');
    },
  });
  return problems;
}

function checkOperationIds(operations: readonly OperationEntry[]): OpenApiProblem[] {
  const firstUse = new Map<string, string>();
  const counted = new Set<string>();
  const problems: OpenApiProblem[] = [];
  for (const entry of operations) {
    if (counted.has(entry.pointer)) continue;
    counted.add(entry.pointer);
    const id = entry.operation.operationId;
    if (typeof id !== 'string') continue;
    const earlier = firstUse.get(id);
    if (earlier === undefined) {
      firstUse.set(id, entry.pointer);
      continue;
    }
    problems.push({
      ruleId: 'operation-operationId-unique',
      message: `operationId ${JSON.stringify(id)} is used more than once`,
      pointer: `${entry.pointer}/operationId`,
      relatedPointer: `${earlier}/operationId`,
    });
  }
  return problems;
}

function checkParameterLists(document: unknown, operations: readonly OperationEntry[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const checked = new Set<string>();
  const checkList = (list: unknown, listPointer: string): void => {
    if (checked.has(listPointer)) return;
    checked.add(listPointer);
    const seen = new Set<string>();
    for (const parameter of resolvedParameters(document, list, listPointer)) {
      const key = `${parameter.location}\u0000${parameter.name}`;
      if (seen.has(key)) {
        problems.push({
          ruleId: 'operation-parameters-unique',
          message: `parameter ${JSON.stringify(parameter.name)} in ${parameter.location} is listed more than once`,
          pointer: parameter.pointer,
        });
      }
      seen.add(key);
    }
  };
  for (const entry of operations) {
    checkList(entry.pathItem.parameters, `${entry.pathItemPointer}/parameters`);
    checkList(entry.operation.parameters, `${entry.pointer}/parameters`);
  }
  return problems;
}

function templateNames(route: string): string[] {
  return [...route.matchAll(TEMPLATE)].map((match) => match[1] ?? '');
}

/**
 * The parameter list an operation actually sees: its own `parameters` plus
 * any path-item-level `parameters` not overridden by an operation-level
 * parameter of the same name and `in` (OpenAPI 3.1/3.2 "Path Item Object").
 * Shared by `checkPathTemplates` (path-parameter coverage) and
 * `checkQuerystring` (the 3.2 `querystring`/`query` exclusivity rules).
 */
function effectiveParameters(document: unknown, entry: OperationEntry): ResolvedParameter[] {
  const own = resolvedParameters(document, entry.operation.parameters, `${entry.pointer}/parameters`);
  const overridden = new Set(own.map((parameter) => `${parameter.location}\u0000${parameter.name}`));
  return [
    ...resolvedParameters(document, entry.pathItem.parameters, `${entry.pathItemPointer}/parameters`)
      .filter((parameter) => !overridden.has(`${parameter.location}\u0000${parameter.name}`)),
    ...own,
  ];
}

function checkPathTemplates(document: unknown, operations: readonly OperationEntry[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const shapes = new Map<string, string>();
  for (const [route] of objectEntries(asRecord(document).paths)) {
    const pointer = pointerJoin('/paths', route);
    if (templateNames(route).includes('')) {
      problems.push({ ruleId: 'path-declaration-must-exist', message: `path ${route} declares an empty parameter {}`, pointer });
    }
    const shape = route.replace(TEMPLATE, '{}');
    const earlier = shapes.get(shape);
    if (earlier === undefined) {
      shapes.set(shape, route);
    } else {
      problems.push({ ruleId: 'no-identical-paths', message: `paths ${earlier} and ${route} differ only in parameter names`, pointer });
    }
  }
  for (const entry of operations) {
    if (entry.route === null) continue;
    const templates = new Set(templateNames(entry.route).filter(Boolean));
    const declared = new Map<string, string>();
    for (const parameter of effectiveParameters(document, entry)) {
      if (parameter.location === 'path') declared.set(parameter.name, parameter.pointer);
    }
    for (const name of templates) {
      if (!declared.has(name)) {
        problems.push({
          ruleId: 'path-parameters-defined',
          message: `path parameter ${JSON.stringify(name)} of ${entry.route} is not defined for ${entry.method.toUpperCase()}`,
          pointer: entry.pointer,
        });
      }
    }
    for (const [name, pointer] of declared) {
      if (!templates.has(name)) {
        problems.push({
          ruleId: 'path-parameters-defined',
          message: `path parameter ${JSON.stringify(name)} is not used in ${entry.route}`,
          pointer,
        });
      }
    }
  }
  return problems;
}

function checkTags(document: unknown, line: '3.1' | '3.2'): OpenApiProblem[] {
  const tags = asRecord(document).tags;
  if (!Array.isArray(tags)) return [];
  const problems: OpenApiProblem[] = [];
  const byName = new Map<string, JsonObject>();
  tags.forEach((tag, index) => {
    if (!isJsonObject(tag) || typeof tag.name !== 'string') return;
    if (byName.has(tag.name)) {
      problems.push({ ruleId: 'no-duplicated-tag-names', message: `tag ${JSON.stringify(tag.name)} is declared more than once`, pointer: `/tags/${index}/name` });
    } else {
      byName.set(tag.name, tag);
    }
  });
  if (line !== '3.2') return problems;
  tags.forEach((tag, index) => {
    if (!isJsonObject(tag) || typeof tag.parent !== 'string') return;
    const pointer = `/tags/${index}/parent`;
    if (!byName.has(tag.parent)) {
      problems.push({ ruleId: 'spec-no-invalid-tag-parents', message: `tag parent ${JSON.stringify(tag.parent)} is not declared`, pointer });
      return;
    }
    const chain = new Set<string>(typeof tag.name === 'string' ? [tag.name] : []);
    for (let parent: unknown = tag.parent; typeof parent === 'string'; parent = byName.get(parent)?.parent) {
      if (chain.has(parent)) {
        problems.push({ ruleId: 'spec-no-invalid-tag-parents', message: `tag ${JSON.stringify(tag.name)} has a circular parent chain`, pointer });
        return;
      }
      chain.add(parent);
    }
  });
  return problems;
}

function checkServers(document: unknown, operations: readonly OperationEntry[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const checked = new Set<string>();
  const check = (servers: unknown, pointer: string): void => {
    if (!Array.isArray(servers) || checked.has(pointer)) return;
    checked.add(pointer);
    servers.forEach((server, index) => {
      if (!isJsonObject(server) || typeof server.url !== 'string') return;
      const variables = asRecord(server.variables);
      for (const name of templateNames(server.url)) {
        if (Object.hasOwn(variables, name)) continue;
        problems.push({
          ruleId: 'no-undefined-server-variable',
          message: `server variable ${JSON.stringify(name)} is not defined in variables`,
          pointer: `${pointer}/${index}/url`,
        });
      }
    });
  };
  check(asRecord(document).servers, '/servers');
  for (const entry of operations) {
    check(entry.pathItem.servers, `${entry.pathItemPointer}/servers`);
    check(entry.operation.servers, `${entry.pointer}/servers`);
  }
  return problems;
}

function checkQuerystring(document: unknown, operations: readonly OperationEntry[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  for (const entry of operations) {
    const effective = effectiveParameters(document, entry);
    const querystring = effective.filter((parameter) => parameter.location === 'querystring');
    const query = effective.filter((parameter) => parameter.location === 'query');
    const second = querystring[1];
    if (second) {
      problems.push({ ruleId: 'spec-querystring-parameters', message: 'an operation can have at most one querystring parameter', pointer: second.pointer });
    }
    const firstQuery = query[0];
    if (querystring.length > 0 && firstQuery) {
      problems.push({ ruleId: 'spec-querystring-parameters', message: 'query parameters cannot be combined with a querystring parameter', pointer: firstQuery.pointer });
    }
  }
  return problems;
}

function checkDiscriminatorDefaults(document: unknown): OpenApiProblem[] {
  const resources = collectCanonicalResources(document);
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  const problems: OpenApiProblem[] = [];
  /** Resolve one `$ref` hop, or return `schema` unchanged when it isn't a Reference Object. */
  const resolveOnce = (schema: unknown, base: string): unknown => {
    if (!isJsonObject(schema) || typeof schema.$ref !== 'string') return schema;
    if (schema.$ref.startsWith('#/')) return resolveJsonPointer(document, decodeRefFragment(schema.$ref.slice(1)));
    return lookupCanonicalResource(schema.$ref, base, resources)?.schema;
  };
  /**
   * Follow a `$ref` chain to its non-`$ref` target (bounded, cycle-safe): a
   * schema like `Alias: { $ref: '#/components/schemas/Cat' }` used from a
   * `oneOf` must resolve through `Alias` to `Cat` itself before `requires`
   * inspects `required`/`allOf`/`oneOf`/`anyOf`, not stop at the first hop.
   */
  const resolveSchema = (schema: unknown, base: string): unknown => {
    let current = schema;
    const seen = new Set<unknown>();
    for (let depth = 0; depth < 32; depth += 1) {
      if (!isJsonObject(current) || typeof current.$ref !== 'string') return current;
      if (seen.has(current)) return undefined; // circular $ref chain
      seen.add(current);
      const next = resolveOnce(current, base);
      if (next === undefined) return undefined; // unresolved $ref
      current = next;
    }
    return undefined; // chain too deep to be a real document
  };
  const requires = (schema: unknown, property: string, base: string, visiting: Set<unknown>): boolean => {
    const resolved = resolveSchema(schema, base);
    if (!isJsonObject(resolved) || visiting.has(resolved)) return true;
    visiting.add(resolved);
    if (Array.isArray(resolved.required) && resolved.required.includes(property)) return true;
    if (Array.isArray(resolved.allOf) && resolved.allOf.some((item) => requires(item, property, base, visiting))) return true;
    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const list = resolved[keyword];
      if (Array.isArray(list) && list.length > 0 && list.every((item) => requires(item, property, base, visiting))) return true;
    }
    return false;
  };
  visitOpenApiSchemaTree(document, {
    onSchema(schema, currentBase, walkerPointer) {
      if (!isJsonObject(schema)) return;
      const discriminator = schema.discriminator;
      if (!isJsonObject(discriminator) || typeof discriminator.propertyName !== 'string') return;
      const pointer = `${walkerPointer.slice(1)}/discriminator`;
      const defaultMapping = discriminator.defaultMapping;
      if (defaultMapping === undefined) {
        if (!requires(schema, discriminator.propertyName, currentBase, new Set())) {
          problems.push({
            ruleId: 'spec-discriminator-defaultMapping',
            message: `discriminator property ${JSON.stringify(discriminator.propertyName)} is optional, so defaultMapping is required`,
            pointer,
          });
        }
        return;
      }
      if (typeof defaultMapping !== 'string') return;
      if (Object.hasOwn(schemas, defaultMapping) || resolveSchema({ $ref: defaultMapping }, currentBase) !== undefined) return;
      problems.push({
        ruleId: 'spec-discriminator-defaultMapping',
        message: `defaultMapping ${JSON.stringify(defaultMapping)} does not point to a schema`,
        pointer: `${pointer}/defaultMapping`,
      });
    },
  });
  return problems;
}

export function checkOpenApiRules(document: unknown): OpenApiProblem[] {
  const line = openApiLine(document);
  const operations = collectRuleOperations(document);
  return [
    ...checkUnresolvedRefs(document),
    ...checkOperationIds(operations),
    ...checkParameterLists(document, operations),
    ...checkPathTemplates(document, operations),
    ...checkTags(document, line),
    ...checkServers(document, operations),
    ...(line === '3.2' ? [...checkQuerystring(document, operations), ...checkDiscriminatorDefaults(document)] : []),
  ];
}
