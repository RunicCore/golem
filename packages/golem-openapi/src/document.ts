import { readFileSync } from 'node:fs';
import path from 'node:path';
import { asRecord, isJsonObject, objectEntries } from './json.js';
import { assertSupportedModelFieldName } from '@exprtlabs/golem/internal/schema';
import { componentOrigin, LocatedError, type OriginLocator } from './origin.js';
import { normalizeDocument, resolveLocalPointer, type NormalizedDocument, type NormalizedOperation } from './normalize.js';
import { displayPath, GolemDiagnosticSeverity, parseYamlFile, type GolemDiagnostic } from '@exprtlabs/golem/generator-api';
import {
  collectCanonicalResources,
  lookupCanonicalResource,
  schemaDocumentBase,
  visitOpenApiSchemaTree,
} from './schema-projection.js';

interface RemoteRef {
  readonly ref: string;
  readonly pointer: string;
}

function validateDocumentHeader(document: unknown): asserts document is Record<string, unknown> {
  if (!isJsonObject(document)) throw new Error('document root must be an object');
  const version = String(document.openapi ?? '');
  if (/^3\.0(?:\.\d+)?$/.test(version)) {
    throw new Error('OpenAPI 3.0 is not supported; convert the document to OpenAPI 3.1 or 3.2');
  }
  if (!/^3\.(1|2)(?:\.\d+)?$/.test(version)) {
    throw new Error(`unsupported OpenAPI version "${version}"; expected 3.1 or 3.2`);
  }
  if (document.paths === undefined && document.components === undefined && document.webhooks === undefined) {
    throw new Error('document must contain at least one of paths, components, or webhooks');
  }
}

function validateDeclaredSchemaFields(document: unknown, locate?: OriginLocator): void {
  visitOpenApiSchemaTree(document, {
    onSchema(schema, _currentBase, pointer) {
      if (!isJsonObject(schema)) return;
      for (const name of objectEntries(schema.properties).map(([fieldName]) => fieldName)) {
        try {
          assertSupportedModelFieldName(name);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new TypeError(`${detail} (at ${locate && pointer.startsWith('#') ? locate(pointer.slice(1)) : pointer || '<schema>'})`);
        }
      }
    },
  });
}

function validateNormalizedOperationFields(normalized: NormalizedDocument): void {
  for (const operation of [...normalized.operations, ...normalized.inboundOperations]) {
    for (const parameter of operation.parameters) {
      if (parameter.in === 'path' || parameter.in === 'query'
        || parameter.in === 'header' || parameter.in === 'cookie') {
        try {
          assertSupportedModelFieldName(parameter.name);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new TypeError(`${detail} (in ${parameter.in} parameters for operation ${JSON.stringify(operation.name)})`);
        }
      }
    }
  }
}

/**
 * Checks that hold before external references are bundled. Operation-level
 * checks need resolved parameters and run on the bundled document.
 */
export function validateSourceDocument(document: unknown): void {
  validateDocumentHeader(document);
  validateDeclaredSchemaFields(document);
}

/** Validate one normalized view and return it so generation can reuse its analysis. */
export function normalizeAndValidate(document: unknown, locate?: OriginLocator): NormalizedDocument {
  validateDocumentHeader(document);
  validateDeclaredSchemaFields(document, locate);
  const normalized = normalizeDocument(document);
  validateNormalizedOperationFields(normalized);
  return normalized;
}

export function validate(document: unknown, preparedIr?: NormalizedDocument, locate?: OriginLocator): void {
  validateDocumentHeader(document);
  validateDeclaredSchemaFields(document, locate);
  validateNormalizedOperationFields(preparedIr ?? normalizeDocument(document));
}

/**
 * List the http(s) `$ref`/`$dynamicRef` values in one document that no JSON
 * Schema `$id` in that document declares. It inspects only the given
 * document, never the files it references, and ignores discriminator mapping
 * values. Generation does not use it: the reference loader classifies remote
 * references. It can therefore report a ref to an `$id` declared in another
 * file, which the loader resolves without fetching.
 */
export function findRemoteRefs(
  document: unknown,
  resources = collectCanonicalResources(document),
): RemoteRef[] {
  const base = schemaDocumentBase(document);
  const found: RemoteRef[] = [];
  const consider = (reference: string, pointer: string, currentBase: string): void => {
    if (!/^https?:\/\//i.test(reference)) return;
    if (lookupCanonicalResource(reference, currentBase, resources)?.hasId) return;
    found.push({ ref: reference, pointer });
  };
  visitOpenApiSchemaTree(document, {
    onSchemaRef(_keyword, reference, currentBase, pointer) {
      consider(reference, pointer, currentBase);
    },
    onOpenApiRef(reference, pointer) {
      consider(reference, pointer, base);
    },
  });
  return found;
}

export function parseSourceDocument(filename: string): unknown {
  const source = readFileSync(filename, 'utf8');
  if (path.extname(filename).toLowerCase() !== '.json') return parseYamlFile(source, filename);
  try {
    return JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${displayPath(filename)}: ${detail}`, { cause: error });
  }
}

export function expandOas32MediaTypes(document: unknown): unknown {
  const root = asRecord(document);
  if (!String(root.openapi ?? '').startsWith('3.2')) return document;
  const components = asRecord(root.components);
  if (components.mediaTypes === undefined) return document;

  const projected = structuredClone(document);

  const expand = (value: unknown, insideMediaType = false, resolving = new Set<string>()): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => expand(item, insideMediaType, resolving));
    }
    if (!isJsonObject(value)) return value;

    const ref = typeof value.$ref === 'string' ? value.$ref : undefined;
    const mediaTypeRef = ref !== undefined && ref.startsWith('#/components/mediaTypes/');
    if (ref && (insideMediaType || mediaTypeRef) && !resolving.has(ref)) {
      const target = resolveLocalPointer(projected, ref);
      if (target !== undefined) {
        const nextResolving = new Set(resolving).add(ref);
        const siblings = Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== '$ref'),
        );
        return expand({ ...structuredClone(target), ...siblings }, true, nextResolving);
      }
    }

    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      expand(child, insideMediaType || Boolean(mediaTypeRef), resolving),
    ]));
  };

  const visitContent = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visitContent);
      return;
    }
    if (!isJsonObject(value)) return;
    if (isJsonObject(value.content)) {
      Reflect.set(value, 'content', Object.fromEntries(Object.entries(value.content)
        .map(([name, mediaType]) => [name, expand(mediaType)])));
    }
    Object.values(value).forEach(visitContent);
  };
  visitContent(projected);
  return projected;
}

/** A schema that holds both `oneOf` and `anyOf` (the value satisfies one variant of each). */
function holdsBothUnions(schema: unknown): schema is Record<string, unknown> {
  return isJsonObject(schema) && schema.oneOf !== undefined && schema.anyOf !== undefined;
}

/**
 * A schema that holds both `oneOf` and `anyOf` becomes an `allOf` of its own `allOf` members and the two unions, so every reader
 * of the generated types and conversion sees one union keyword at a time, as the validator reads both. The discriminator stays
 * with the `oneOf`. The caller's document is never changed; a document with no such schema is returned as it is.
 */
export function normalizeSchemaUnions(document: unknown): unknown {
  let found = false;
  visitOpenApiSchemaTree(document, { onSchema(schema) { found ||= holdsBothUnions(schema); } });
  if (!found) return document;
  const normalized = structuredClone(document);
  visitOpenApiSchemaTree(normalized, {
    onSchema(schema) {
      if (!holdsBothUnions(schema)) return;
      const { oneOf, anyOf, discriminator, allOf } = schema;
      delete schema.oneOf;
      delete schema.anyOf;
      delete schema.discriminator;
      schema.allOf = [
        ...(Array.isArray(allOf) ? allOf : []),
        { oneOf, ...(discriminator === undefined ? {} : { discriminator }) },
        { anyOf },
      ];
    },
  });
  return normalized;
}

export function unsupportedHttpAuthSchemes(document: unknown): void {
  const schemes = asRecord(asRecord(asRecord(document).components).securitySchemes);
  for (const [name, rawScheme] of objectEntries(schemes)) {
    const scheme = asRecord(rawScheme);
    if (typeof scheme.$ref === 'string') continue;
    if (scheme.type !== 'http') continue;
    const httpScheme = String(scheme.scheme ?? '').toLowerCase();
    if (httpScheme === 'basic' || httpScheme === 'bearer') continue;
    const named = `security scheme ${JSON.stringify(name)}`;
    throw new LocatedError(
      `unsupported HTTP authentication scheme ${JSON.stringify(String(scheme.scheme ?? ''))} in ${named}`,
      [componentOrigin('securitySchemes', name, named)],
    );
  }
}

/**
 * Browsers forbid scripts from setting the Cookie header, so a cookie parameter
 * or cookie API key only reaches the server from Node or a same-origin cookie.
 */
export function browserCookieDiagnostics(
  document: unknown,
  operations: readonly NormalizedOperation[],
): GolemDiagnostic[] {
  const diagnostics: GolemDiagnostic[] = [];
  const warn = (message: string): void => {
    diagnostics.push({ code: 'OPENAPI_BROWSER_COOKIE', severity: GolemDiagnosticSeverity.Warning, message });
  };
  for (const operation of operations) {
    for (const parameter of operation.parameters) {
      if (parameter.in === 'cookie') {
        warn(`operation ${operation.name} cookie parameter ${JSON.stringify(parameter.name)} is sent as a Cookie header, which browsers do not allow scripts to set`);
      }
    }
  }
  const schemes = asRecord(asRecord(asRecord(document).components).securitySchemes);
  const used = new Set(operations.flatMap((operation) => operation.security.flatMap((requirement) => Object.keys(requirement))));
  for (const [name, rawScheme] of objectEntries(schemes)) {
    const scheme = asRecord(rawScheme);
    if (used.has(name) && scheme.type === 'apiKey' && scheme.in === 'cookie') {
      warn(`security scheme ${JSON.stringify(name)} is an API key in a cookie, which browsers do not allow scripts to set`);
    }
  }
  return diagnostics;
}
