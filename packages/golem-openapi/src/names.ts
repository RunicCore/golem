import { unescapePointerToken } from '@exprtlabs/golem/schema';
import { bindingName, camelIdentifier, identifier, RESERVED_BINDING_NAMES } from '@exprtlabs/golem/generator-api';

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

export function inboundOperationName(
  sourceKind: string,
  sourceName: string,
  operation: { readonly operationId?: unknown },
  method: string,
  route: string,
): string {
  const base = identifier(operation.operationId || `${method} ${route}`, 'Operation');
  return camelIdentifier(
    operation.operationId ? `${sourceKind} ${base}` : `${sourceKind} ${sourceName} ${base}`,
    'InboundOperation',
  );
}

export function refName(ref: string): string | null {
  const prefix = '#/components/schemas/';
  return ref.startsWith(prefix) ? identifier(unescapePointerToken(ref.slice(prefix.length))) : null;
}
