/**
 * The one rule for following a chain of `$ref` objects. Each reader of a document decides what one hop is (a local
 * pointer, an anchor, a component, a model by name); this rule decides how far a chain goes and what a miss is.
 */

/** The most hops one chain may take; a chain that has not reached a target by then refers back to itself. */
export const MAX_REFERENCE_HOPS = 32;

/** The `$ref` of a schema object, or undefined when the value is not an object with a string `$ref`. */
export function schemaReference(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const reference: unknown = Reflect.get(value, '$ref');
  return typeof reference === 'string' ? reference : undefined;
}

/** The `$ref` of a schema object, else its `$dynamicRef`: the reference that a reader resolves. */
export function schemaReferenceOrDynamic(value: unknown): string | undefined {
  const reference = schemaReference(value);
  if (reference !== undefined) return reference;
  if (typeof value !== 'object' || value === null) return undefined;
  const dynamic: unknown = Reflect.get(value, '$dynamicRef');
  return typeof dynamic === 'string' ? dynamic : undefined;
}

/** Where a chain ended: the first value that is not a reference, and the last `$ref` that led to it (undefined when `start` is the target). */
export interface FollowedReference<T> {
  readonly target: T;
  readonly reference: string | undefined;
}

/**
 * Follows `start` through its references to the first value that `referenceOf` reads no reference from. `resolve` takes
 * one hop and gets the value that led to it (a hop may depend on the scope that value carries).
 * Undefined when a hop names nothing or the chain is longer than {@link MAX_REFERENCE_HOPS}: the caller handles the miss.
 */
export function followReference<T>(
  start: T,
  referenceOf: (value: T) => string | undefined,
  resolve: (reference: string, from: T) => T | undefined,
): FollowedReference<T> | undefined {
  let target = start;
  let reference: string | undefined;
  for (let hops = 0; hops < MAX_REFERENCE_HOPS; hops += 1) {
    const next = referenceOf(target);
    if (next === undefined) return { target, reference };
    const resolved = resolve(next, target);
    if (resolved === undefined) return undefined;
    target = resolved;
    reference = next;
  }
  return referenceOf(target) === undefined ? { target, reference } : undefined;
}
