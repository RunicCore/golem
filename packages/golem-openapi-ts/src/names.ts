import { decodeUriFragment, unescapeJsonPointerToken } from '@exprtlabs/golem/internal/schema';
import { bindingName, camelIdentifier, identifier, RESERVED_BINDING_NAMES } from '@exprtlabs/golem/internal/generator-support';
import { code, identifier as identifierPart, join, literal, type Code } from '@exprtlabs/golem/internal/emitter';

/**
 * An operation name is both an exported function and a generated client
 * class member, so it also avoids the members every client class owns.
 */
const RESERVED_OPERATION_NAMES: ReadonlySet<string> = new Set([
  ...RESERVED_BINDING_NAMES,
  'constructor',
  'runtime',
]);

/**
 * Client operation name. A reserved word or client member name receives the
 * shared allocator's deterministic suffix.
 */
export function operationName(
  operation: { readonly operationId?: unknown },
  method: string,
  route: string,
): { readonly name: string; readonly requested: string } {
  const requested = typeof operation.operationId === 'string' && operation.operationId.length > 0
    ? camelIdentifier(operation.operationId, 'Operation')
    : camelIdentifier(`${method} ${route}`, 'Operation');
  return { name: bindingName(requested, RESERVED_OPERATION_NAMES), requested };
}

/** A file-private union of client operation names, for emitted files that type a name without importing it. */
export function operationNameType(typeName: string, operations: readonly { readonly name: string }[]): Code {
  return code`type ${identifierPart(typeName)} = ${join(operations.map((operation) => literal(operation.name)), code` | `)};`;
}

/** An inbound operation with an `operationId` is named by it alone; without one, its name holds the operation that it comes from. */
export function inboundNameHoldsSource(operation: { readonly operationId?: unknown }): boolean {
  return !operation.operationId;
}

export function inboundOperationName(
  sourceKind: string,
  sourceName: string,
  operation: { readonly operationId?: unknown },
  method: string,
  route: string,
): string {
  const base = identifier(operation.operationId || `${method} ${route}`, 'Operation');
  return camelIdentifier(
    inboundNameHoldsSource(operation) ? `${sourceKind} ${sourceName} ${base}` : `${sourceKind} ${base}`,
    'InboundOperation',
  );
}

export function refName(ref: string): string | null {
  const prefix = '#/components/schemas/';
  return ref.startsWith(prefix) ? identifier(unescapeJsonPointerToken(decodeUriFragment(ref.slice(prefix.length)))) : null;
}
