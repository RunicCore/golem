import type { ModelConversionDescriptor } from '../model-source-emitter.js';
import type { SerdeBinding, ValidationBinding } from './tags.js';
import { compareText } from '../generator-api.js';
import { canonicalConstraintKey } from '../schema.js';
import type { ConstraintSchemaValue, ModelConstraint } from '../schema.js';

type Rich = {
  readonly constraints?: ModelConversionDescriptor["constraints"];
  readonly validations?: readonly (ValidationBinding | string)[];
  readonly serde?: SerdeBinding & { readonly wireDescriptor?: ModelConversionDescriptor };
};

function isDescriptor(value: ConstraintSchemaValue): value is ModelConversionDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'kind') === 'string';
}

function rewriteConstraint(
  constraint: ModelConstraint,
  rewrite: (descriptor: ModelConversionDescriptor) => ModelConversionDescriptor,
): ModelConstraint {
  const project = (value: ConstraintSchemaValue): ConstraintSchemaValue =>
    isDescriptor(value) ? rewrite(value) : value;
  switch (constraint.kind) {
    case 'contains':
    case 'propertyNames':
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'items':
    case 'unevaluatedItems':
    case 'not':
    case 'patternProperties':
      return { ...constraint, schema: project(constraint.schema) };
    case 'dependentSchemas':
      return {
        ...constraint,
        value: Object.fromEntries(Object.entries(constraint.value).map(([name, value]) => [name, project(value)])),
      };
    case 'oneOf':
    case 'allOf':
      return { ...constraint, schemas: constraint.schemas.map(project) };
    case 'ifThenElse':
      return {
        ...constraint,
        if: project(constraint.if),
        ...(constraint.then === undefined ? {} : { then: project(constraint.then) }),
        ...(constraint.else === undefined ? {} : { else: project(constraint.else) }),
      };
    default:
      return constraint;
  }
}

export type ProjectionLookup = (name: string) => ModelConversionDescriptor | undefined;

function canonicalIdentity(
  lookup: ProjectionLookup,
  descriptor: ModelConversionDescriptor,
  stack: readonly string[],
): unknown {
  const canonical = (descriptor: ModelConversionDescriptor, stack: readonly string[]): unknown => {
    const rich = descriptor as unknown as Rich;
    if (descriptor.kind === 'reference' && descriptor.projection) {
      const cycle = stack.indexOf(descriptor.name);
      if (cycle >= 0) return { cycle };
      const target = lookup(descriptor.name);
      return target ? canonical(target, [...stack, descriptor.name]) : descriptor;
    }
    let structure: unknown = descriptor;
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
      default: {
        structure = Object.fromEntries(Object.entries(descriptor).filter(([key]) => !['validations', 'serde', 'constraints'].includes(key)));
      }
    }
    return {
      structure,
      // Constraint payloads can carry nested descriptors with executable
      // validation bindings.  Keep their user schema data intact, but use
      // the descriptor-aware key so compiler/checker objects never enter the
      // projection identity JSON.
      constraints: rich.constraints?.map(canonicalConstraintKey).sort(),
      validations: rich.validations?.map(binding => typeof binding === 'string' ? binding : binding.id),
      serde: rich.serde ? { id: rich.serde.id, wire: rich.serde.wireDescriptor ? canonical(rich.serde.wireDescriptor, stack) : undefined } : undefined,
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
    const key = projectionIdentity(lookup, name, definitions[name]!);
    const representative = representatives.get(key) ?? name;
    representatives.set(key, representative);
    redirect.set(name, representative);
  }
  const rewrite = (descriptor: ModelConversionDescriptor): ModelConversionDescriptor => {
    const rich = descriptor as unknown as Rich;
    let result = descriptor;
    if (descriptor.kind === 'reference' && descriptor.projection) result = { ...descriptor, name: redirect.get(descriptor.name) ?? descriptor.name };
    else if (descriptor.kind === 'object') result = { ...descriptor, properties: Object.fromEntries(Object.entries(descriptor.properties).map(([key, value]) => [key, rewrite(value)])), additionalProperties: typeof descriptor.additionalProperties === 'object' ? rewrite(descriptor.additionalProperties) : descriptor.additionalProperties };
    else if (descriptor.kind === 'array') result = { ...descriptor, item: rewrite(descriptor.item) };
    else if (descriptor.kind === 'tuple') result = { ...descriptor, items: descriptor.items.map(rewrite), ...(descriptor.rest ? { rest: { ...descriptor.rest, item: rewrite(descriptor.rest.item) } } : {}) };
    else if (descriptor.kind === 'union' || descriptor.kind === 'intersection') result = { ...descriptor, variants: descriptor.variants.map(rewrite) };
    if (rich.serde?.wireDescriptor) result = { ...result, serde: { ...rich.serde, wireDescriptor: rewrite(rich.serde.wireDescriptor) } } as unknown as ModelConversionDescriptor;
    if (rich.constraints?.length) {
      result = {
        ...result,
        constraints: rich.constraints.map((constraint) => rewriteConstraint(constraint, rewrite)),
      } as ModelConversionDescriptor;
    }
    return result;
  };
  return Object.fromEntries(Object.entries(definitions).filter(([name]) => !redirect.has(name) || redirect.get(name) === name).map(([name, descriptor]) => [name, rewrite(descriptor)]));
}
