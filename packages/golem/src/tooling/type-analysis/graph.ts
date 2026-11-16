import { assertNever } from '../../assert-never.js';
import type { ModelConversionDescriptor } from '../model-source-emitter.js';
import { compareText } from '../generator-core.js';
import { canonicalConstraintKey, mapConstraintSchemaValues, serdeWireDescriptor, serdeWithWire, validationBindingId } from '../schema.js';
import type { ConstraintSchemaValue, ModelConstraint } from '../schema.js';

function isDescriptor(value: ConstraintSchemaValue): value is ModelConversionDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'kind') === 'string';
}

function rewriteConstraint(
  constraint: ModelConstraint,
  rewrite: (descriptor: ModelConversionDescriptor) => ModelConversionDescriptor,
): ModelConstraint {
  return mapConstraintSchemaValues(constraint, (value) => isDescriptor(value) ? rewrite(value) : value);
}

export type ProjectionLookup = (name: string) => ModelConversionDescriptor | undefined;

function canonicalIdentity(
  lookup: ProjectionLookup,
  descriptor: ModelConversionDescriptor,
  stack: readonly string[],
): unknown {
  const canonical = (descriptor: ModelConversionDescriptor, stack: readonly string[]): unknown => {
    if (descriptor.kind === 'reference' && descriptor.projection) {
      const cycle = stack.indexOf(descriptor.name);
      if (cycle >= 0) return { cycle };
      const target = lookup(descriptor.name);
      return target ? canonical(target, [...stack, descriptor.name]) : descriptor;
    }
    let structure: unknown;
    switch (descriptor.kind) {
      case 'object': structure = {
        kind: descriptor.kind, projection: descriptor.projection,
        properties: Object.fromEntries(Object.entries(descriptor.properties).sort(([a], [b]) => compareText(a, b)).map(([key, value]) => [key, canonical(value, stack)])),
        required: [...descriptor.required].sort(), readonlyProperties: [...(descriptor.readonlyProperties ?? [])].sort(),
        additionalProperties: typeof descriptor.additionalProperties === 'object' ? canonical(descriptor.additionalProperties, stack) : descriptor.additionalProperties,
      }; break;
      case 'array': structure = { kind: descriptor.kind, isReadonly: descriptor.isReadonly, item: canonical(descriptor.item, stack) }; break;
      case 'tuple': structure = { kind: descriptor.kind, isReadonly: descriptor.isReadonly, items: descriptor.items.map(item => canonical(item, stack)), optionalFrom: descriptor.optionalFrom, rest: descriptor.rest ? { index: descriptor.rest.index, item: canonical(descriptor.rest.item, stack) } : undefined }; break;
      case 'union':
      case 'intersection': structure = { kind: descriptor.kind, variants: descriptor.variants.map(item => canonical(item, stack)) }; break;
      case 'any': case 'unknown': case 'never': case 'string': case 'number': case 'boolean': case 'bigint': case 'null': case 'undefined':
      case 'class-value': case 'literal': case 'reference': case 'generated-model':
        structure = Object.fromEntries(Object.entries(descriptor).filter(([key]) => !['validations', 'serde', 'constraints'].includes(key)));
        break;
      default: return assertNever(descriptor);
    }
    const wire = serdeWireDescriptor(descriptor.serde);
    return {
      structure,
      // Constraint payloads can carry nested descriptors with executable
      // validation bindings.  Keep their user schema data intact, but use
      // the descriptor-aware key so compiler/checker objects never enter the
      // projection identity JSON.
      constraints: descriptor.constraints?.map(canonicalConstraintKey).sort(),
      validations: descriptor.validations?.map(validationBindingId).sort(),
      serde: descriptor.serde ? { id: descriptor.serde.id, wire: wire ? canonical(wire, stack) : undefined } : undefined,
    };
  };
  return canonical(descriptor, stack);
}

/**
 * Identity of a descriptor under conversion, validation and policy semantics. Projection
 * references resolve through `lookup`; `name` is the projection being compared, so a
 * self-reference reads as a cycle.
 */
export function projectionIdentity(lookup: ProjectionLookup, name: string, descriptor: ModelConversionDescriptor): string {
  return JSON.stringify(canonicalIdentity(lookup, descriptor, [name]));
}

/** Deduplicate projected shapes using conversion, identity and policy semantics. */
export function deduplicateProjections(
  definitions: Readonly<Record<string, ModelConversionDescriptor>>,
  projectionNames: ReadonlySet<string>,
): Record<string, ModelConversionDescriptor> {
  const names = Object.keys(definitions).filter(name => projectionNames.has(name)).sort();
  const lookup: ProjectionLookup = name => definitions[name];
  const representatives = new Map<string, string>();
  const redirect = new Map<string, string>();
  for (const name of names) {
    const key = projectionIdentity(lookup, name, definitions[name]);
    const representative = representatives.get(key) ?? name;
    representatives.set(key, representative);
    redirect.set(name, representative);
  }
  const rewrite = (descriptor: ModelConversionDescriptor): ModelConversionDescriptor => {
    let result = descriptor;
    if (descriptor.kind === 'reference' && descriptor.projection) result = { ...descriptor, name: redirect.get(descriptor.name) ?? descriptor.name };
    else if (descriptor.kind === 'object') result = { ...descriptor, properties: Object.fromEntries(Object.entries(descriptor.properties).map(([key, value]) => [key, rewrite(value)])), additionalProperties: typeof descriptor.additionalProperties === 'object' ? rewrite(descriptor.additionalProperties) : descriptor.additionalProperties };
    else if (descriptor.kind === 'array') result = { ...descriptor, item: rewrite(descriptor.item) };
    else if (descriptor.kind === 'tuple') result = { ...descriptor, items: descriptor.items.map(rewrite), ...(descriptor.rest ? { rest: { ...descriptor.rest, item: rewrite(descriptor.rest.item) } } : {}) };
    else if (descriptor.kind === 'union' || descriptor.kind === 'intersection') result = { ...descriptor, variants: descriptor.variants.map(rewrite) };
    const wire = serdeWireDescriptor(descriptor.serde);
    if (descriptor.serde && wire) result = { ...result, serde: serdeWithWire(descriptor.serde, rewrite(wire)) };
    if (descriptor.constraints?.length) {
      result = {
        ...result,
        constraints: descriptor.constraints.map((constraint) => rewriteConstraint(constraint, rewrite)),
      };
    }
    return result;
  };
  return Object.fromEntries(Object.entries(definitions).filter(([name]) => !redirect.has(name) || redirect.get(name) === name).map(([name, descriptor]) => [name, rewrite(descriptor)]));
}
