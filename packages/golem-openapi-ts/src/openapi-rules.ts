import {
  asRecord,
  entriesWithoutExtensions,
  isJsonObject,
  jsonPointerJoin as pointerJoin,
  objectEntries,
  openApiLine,
  type JsonObject,
  type OpenApiLine,
} from './json.js';
import { parameterIdentity } from '@exprtlabs/golem/internal/generator-support';
import { followReference, resolveFragmentPointer, schemaReference, type ScopedSchema } from '@exprtlabs/golem/internal/schema';
import { followLocalRefs, overrideParameters, visitOperationSites, type OperationSite } from './normalize.js';
import type { OpenApiProblem } from './openapi-validator.js';
import { isMappingComponentName } from './reference-loader.js';
import { collectCanonicalResources, findDuplicateSchemaIds, lookupCanonicalResource, resolveSchemaTarget, visitOpenApiSchemaTree } from './schema-projection.js';

const TEMPLATE = /\{([^{}]*)\}/g;

interface ResolvedParameter {
  readonly name: string;
  readonly in: string;
  readonly pointer: string;
}

function resolvedParameters(document: unknown, list: unknown, listPointer: string): ResolvedParameter[] {
  if (!Array.isArray(list)) return [];
  const parameters: ResolvedParameter[] = [];
  list.forEach((raw, index) => {
    const parameter = followLocalRefs(document, raw, `${listPointer}/${index}`).value;
    if (isJsonObject(parameter) && typeof parameter.name === 'string' && typeof parameter.in === 'string') {
      parameters.push({ name: parameter.name, in: parameter.in, pointer: `${listPointer}/${index}` });
    }
  });
  return parameters;
}

function checkUnresolvedRefs(document: unknown): OpenApiProblem[] {
  const resources = collectCanonicalResources(document);
  const problems: OpenApiProblem[] = [];
  const rootSchemaNames = new Set(Object.keys(asRecord(asRecord(asRecord(document).components).schemas)));
  const check = (reference: string, currentBase: string | null, walkerPointer: string, label = '$ref'): void => {
    if (reference === '#') return;
    if (reference.startsWith('#/')) {
      if (resolveFragmentPointer(document, reference.slice(1)) !== undefined) return;
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

function checkOperationIds(operations: readonly OperationSite[]): OpenApiProblem[] {
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

function checkParameterLists(document: unknown, operations: readonly OperationSite[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const checked = new Set<string>();
  const checkList = (list: unknown, listPointer: string): void => {
    if (checked.has(listPointer)) return;
    checked.add(listPointer);
    const seen = new Set<string>();
    for (const parameter of resolvedParameters(document, list, listPointer)) {
      const key = parameterIdentity(parameter.in, parameter.name);
      if (seen.has(key)) {
        problems.push({
          ruleId: 'operation-parameters-unique',
          message: `parameter ${JSON.stringify(parameter.name)} in ${parameter.in} is listed more than once`,
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

/** Header names are case-insensitive, so one response declares each header once, in whatever case (`parameterIdentity`). */
function checkResponseHeaders(document: unknown, operations: readonly OperationSite[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const checked = new Set<string>(); // a response that several operations share is one headers object
  for (const entry of operations) {
    for (const [status, raw] of objectEntries(entry.operation.responses)) {
      const response = followLocalRefs(document, raw, pointerJoin(`${entry.pointer}/responses`, status));
      const headersPointer = pointerJoin(response.pointer, 'headers');
      if (checked.has(headersPointer)) continue;
      checked.add(headersPointer);
      const seen = new Set<string>();
      for (const [name] of objectEntries(asRecord(response.value).headers)) {
        const key = parameterIdentity('header', name);
        if (seen.has(key)) {
          problems.push({
            ruleId: 'operation-response-headers-unique',
            message: `response header ${JSON.stringify(name)} is declared more than once; header names are case-insensitive`,
            pointer: pointerJoin(headersPointer, name),
          });
        }
        seen.add(key);
      }
    }
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
function effectiveParameters(document: unknown, entry: OperationSite): ResolvedParameter[] {
  return overrideParameters(
    resolvedParameters(document, entry.pathItem.parameters, `${entry.pathItemPointer}/parameters`),
    resolvedParameters(document, entry.operation.parameters, `${entry.pointer}/parameters`),
  );
}

function checkPathTemplates(document: unknown, operations: readonly OperationSite[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const shapes = new Map<string, string>();
  for (const [route] of entriesWithoutExtensions(asRecord(document).paths)) {
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
    if (entry.kind !== 'path') continue;
    const templates = new Set(templateNames(entry.key).filter(Boolean));
    const declared = new Map<string, string>();
    for (const parameter of effectiveParameters(document, entry)) {
      if (parameter.in === 'path') declared.set(parameter.name, parameter.pointer);
    }
    for (const name of templates) {
      if (!declared.has(name)) {
        problems.push({
          ruleId: 'path-parameters-defined',
          message: `path parameter ${JSON.stringify(name)} of ${entry.key} is not defined for ${entry.method.toUpperCase()}`,
          pointer: entry.pointer,
        });
      }
    }
    for (const [name, pointer] of declared) {
      if (!templates.has(name)) {
        problems.push({
          ruleId: 'path-parameters-defined',
          message: `path parameter ${JSON.stringify(name)} is not used in ${entry.key}`,
          pointer,
        });
      }
    }
  }
  return problems;
}

function checkTags(document: unknown, line: OpenApiLine): OpenApiProblem[] {
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

function checkServers(document: unknown, operations: readonly OperationSite[], line: OpenApiLine): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const checked = new Set<string>();
  const check = (servers: unknown, pointer: string): void => {
    if (!Array.isArray(servers) || checked.has(pointer)) return;
    checked.add(pointer);
    const names = new Set<string>();
    servers.forEach((server, index) => {
      if (line === '3.2' && isJsonObject(server) && typeof server.name === 'string') {
        if (names.has(server.name)) {
          problems.push({
            ruleId: 'no-duplicated-server-names',
            message: `server name ${JSON.stringify(server.name)} is used more than once in this list`,
            pointer: `${pointer}/${index}/name`,
          });
        }
        names.add(server.name);
      }
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

/**
 * Every name in a document-level or operation-level `security` list must be a scheme in `components.securitySchemes`;
 * an undeclared name would leave the generated client without the credentials the operation asks for. A name written as
 * a URI reference (OpenAPI 3.1.1) cannot be looked up in components, so it is not checked.
 */
function checkSecurityRequirements(document: unknown, operations: readonly OperationSite[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const schemes = asRecord(asRecord(asRecord(document).components).securitySchemes);
  const checked = new Set<string>();
  const checkList = (list: unknown, listPointer: string): void => {
    if (!Array.isArray(list) || checked.has(listPointer)) return;
    checked.add(listPointer);
    list.forEach((requirement, index) => {
      for (const name of Object.keys(asRecord(requirement))) {
        if (Object.hasOwn(schemes, name) || /[:/#]/.test(name)) continue;
        problems.push({
          ruleId: 'operation-security-defined',
          message: `security requirement names ${JSON.stringify(name)}, which is not declared in components.securitySchemes`,
          pointer: pointerJoin(`${listPointer}/${index}`, name),
        });
      }
    });
  };
  checkList(asRecord(document).security, '/security');
  for (const entry of operations) checkList(entry.operation.security, `${entry.pointer}/security`);
  return problems;
}

function checkQuerystring(document: unknown, operations: readonly OperationSite[]): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  for (const entry of operations) {
    const effective = effectiveParameters(document, entry);
    const querystring = effective.filter((parameter) => parameter.in === 'querystring');
    const query = effective.filter((parameter) => parameter.in === 'query');
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
  /**
   * Follow a `$ref` chain to its non-`$ref` target, with the base that the target's own references resolve against:
   * `Alias: { $ref: '#/components/schemas/Cat' }` used from a `oneOf` must resolve through `Alias` to `Cat` itself
   * before `requires` inspects `required`/`allOf`/`oneOf`/`anyOf`. Undefined when a hop names nothing or the chain is a cycle.
   */
  const resolveSchema = (schema: unknown, base: string): ScopedSchema<string> | undefined => {
    const followed = followReference<ScopedSchema<string>>(
      { schema, scope: base },
      (scoped) => schemaReference(scoped.schema),
      (reference, from) => {
        const target = resolveSchemaTarget(reference, from.scope, resources, document);
        return target === undefined ? undefined : { schema: target.schema, scope: target.currentBase };
      },
    );
    switch (followed.kind) {
      case 'found': return followed.target;
      case 'miss':
      case 'cycle': return undefined;
    }
  };
  /**
   * `visiting` holds the schemas on the current path only, so a schema shared by two branches is judged in each.
   * `judgedFalse` keeps the schemas already found not to require the property: that result does not depend on
   * the path, so a diamond of shared members is judged once.
   */
  const requires = (schema: unknown, property: string, base: string, visiting: Set<unknown>, judgedFalse: Set<unknown>): boolean => {
    const followed = resolveSchema(schema, base);
    const resolved = followed?.schema;
    if (followed === undefined || !isJsonObject(resolved) || visiting.has(resolved)) return true;
    if (judgedFalse.has(resolved)) return false;
    if (Array.isArray(resolved.required) && resolved.required.includes(property)) return true;
    visiting.add(resolved);
    try {
      if (Array.isArray(resolved.allOf) && resolved.allOf.some((item) => requires(item, property, followed.scope, visiting, judgedFalse))) return true;
      for (const keyword of ['oneOf', 'anyOf'] as const) {
        const list = resolved[keyword];
        if (Array.isArray(list) && list.length > 0 && list.every((item) => requires(item, property, followed.scope, visiting, judgedFalse))) return true;
      }
      judgedFalse.add(resolved);
      return false;
    } finally {
      visiting.delete(resolved);
    }
  };
  visitOpenApiSchemaTree(document, {
    onSchema(schema, currentBase, walkerPointer) {
      if (!isJsonObject(schema)) return;
      const discriminator = schema.discriminator;
      if (!isJsonObject(discriminator) || typeof discriminator.propertyName !== 'string') return;
      const pointer = `${walkerPointer.slice(1)}/discriminator`;
      const defaultMapping = discriminator.defaultMapping;
      if (defaultMapping === undefined) {
        if (!requires(schema, discriminator.propertyName, currentBase, new Set(), new Set())) {
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

/**
 * A request body media type declares `schema`. `itemSchema` describes the items of a sequential response body: the
 * client sends one value, not a stream, and no body encoder or type reads a request `itemSchema`.
 */
function checkRequestItemSchemas(document: unknown, operations: readonly OperationSite[]): OpenApiProblem[] {
  return operations.flatMap((entry) => {
    const { value: body, pointer } = followLocalRefs(document, entry.operation.requestBody, `${entry.pointer}/requestBody`);
    return objectEntries(asRecord(body).content).flatMap(([contentType, media]) => isJsonObject(media) && media.itemSchema !== undefined
      ? [{
        ruleId: 'no-request-item-schema',
        message: 'itemSchema describes the items of a response stream; declare a request body with schema',
        pointer: pointerJoin(pointerJoin(pointerJoin(pointer, 'content'), contentType), 'itemSchema'),
      }]
      : []);
  });
}

/** `defaultMapping` is a 3.2 keyword of the Discriminator Object; a 3.1 document may not use it. */
function checkDiscriminatorDefaultMappingLine(document: unknown): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  visitOpenApiSchemaTree(document, {
    onSchema(schema, _currentBase, walkerPointer) {
      if (!isJsonObject(schema) || !isJsonObject(schema.discriminator) || schema.discriminator.defaultMapping === undefined) return;
      problems.push({
        ruleId: 'spec-discriminator-defaultMapping',
        message: 'defaultMapping is a keyword of OpenAPI 3.2; a 3.1 Discriminator Object has propertyName and mapping only',
        pointer: `${walkerPointer.slice(1)}/discriminator/defaultMapping`,
      });
    },
  });
  return problems;
}

/**
 * Each number in the document that JSON cannot write (`Infinity`, `-Infinity`, `NaN`), as a YAML `.inf`, `-.inf`
 * or `.nan`, or a JSON `1e999`, parses into. The meta-schemas let one through inside a keyword that takes any
 * value, such as `enum`, `const`, `default` or `example`, and type emission cannot write it as a literal.
 */
export function checkNonFiniteNumbers(document: unknown): OpenApiProblem[] {
  const problems: OpenApiProblem[] = [];
  const ancestors = new Set<object>();
  const visit = (value: unknown, pointer: string): void => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        problems.push({ ruleId: 'no-non-finite-numbers', message: `${value} is not a JSON number; use a finite number`, pointer });
      }
      return;
    }
    if (typeof value !== 'object' || value === null || ancestors.has(value)) return;
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) visit(child, pointerJoin(pointer, key));
    ancestors.delete(value);
  };
  visit(document, '');
  return problems;
}

export function checkOpenApiRules(document: unknown): OpenApiProblem[] {
  // Every other rule indexes schema resources, which needs each `$id` to be unique.
  const duplicates = findDuplicateSchemaIds(document);
  if (duplicates.length) {
    return duplicates.map((duplicate) => ({
      ruleId: 'schema-id-unique',
      message: `JSON Schema $id ${JSON.stringify(duplicate.canonical)} is declared more than once`,
      pointer: duplicate.pointer,
      relatedPointer: duplicate.firstPointer,
    }));
  }
  const line = openApiLine(document);
  const operations: OperationSite[] = [];
  const checked = new Set<string>(); // one pointer is one operation, however many parents list it; a path item shared by two routes is two
  visitOperationSites(document, line, (site) => {
    const identity = `${site.pointer}\u0000${site.kind === 'path' ? site.key : ''}`;
    if (!checked.has(identity)) {
      checked.add(identity);
      operations.push(site);
    }
    return site.pointer;
  });
  return [
    ...checkUnresolvedRefs(document),
    ...checkOperationIds(operations),
    ...checkParameterLists(document, operations),
    ...checkResponseHeaders(document, operations),
    ...checkPathTemplates(document, operations),
    ...checkTags(document, line),
    ...checkServers(document, operations, line),
    ...checkSecurityRequirements(document, operations),
    ...checkRequestItemSchemas(document, operations),
    ...(line === '3.2'
      ? [...checkQuerystring(document, operations), ...checkDiscriminatorDefaults(document)]
      : checkDiscriminatorDefaultMappingLine(document)),
  ];
}
