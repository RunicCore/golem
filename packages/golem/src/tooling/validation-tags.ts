/** Structural shell of generated tag validators. */
import type { ModelConstraint, ModelTypeDescriptor } from '../model-registry.js';

interface ValidationTagSchemaOptions {
  readonly definitions?: Readonly<Record<string, ModelTypeDescriptor>>;
}

/**
 * Return the JSON-safe structural shell used by a generated tag validator.
 * Nested field types are intentionally unconstrained here: the structural
 * visitor validates them at their own descriptor, while object property names
 * and array/object context remain available to sibling JSON Schema keywords.
 */
function tagSchemaShell(
  descriptor: ModelTypeDescriptor,
  definitions: Readonly<Record<string, ModelTypeDescriptor>> | undefined,
  activeReferences: ReadonlySet<string> = new Set(),
): ModelTypeDescriptor {
  switch (descriptor.kind) {
    case 'reference': {
      const referenced = definitions?.[descriptor.name];
      if (referenced && !activeReferences.has(descriptor.name)) {
        return tagSchemaShell(referenced, definitions, new Set([...activeReferences, descriptor.name]));
      }
      return { kind: 'any' };
    }
    case 'object':
      return {
        kind: 'object',
        properties: Object.fromEntries(Object.keys(descriptor.properties).sort().map((name) => [name, { kind: 'any' as const }])),
        required: [],
        additionalProperties: descriptor.additionalProperties === false ? false : true,
      };
    case 'array':
    case 'tuple':
      return { kind: 'array', item: { kind: 'any' } };
    case 'union':
    case 'intersection': {
      const members = descriptor.variants.map((variant) => tagSchemaShell(variant, definitions, activeReferences));
      if (members.some((member) => member.kind === 'object')) {
        const properties: Record<string, ModelTypeDescriptor> = Object.create(null);
        let additionalProperties = true;
        for (const member of members) {
          if (member.kind !== 'object') continue;
          Object.keys(member.properties).forEach((name) => { properties[name] = { kind: 'any' }; });
          if (member.additionalProperties === false) additionalProperties = false;
        }
        return { kind: 'object', properties, required: [], additionalProperties };
      }
      if (members.some((member) => member.kind === 'array')) return { kind: 'array', item: { kind: 'any' } };
      return { kind: 'any' };
    }
    default:
      return { kind: 'any' };
  }
}

export function validationTagSchemaDescriptor(
  descriptor: ModelTypeDescriptor,
  constraints: readonly ModelConstraint[],
  options: ValidationTagSchemaOptions = {},
): ModelTypeDescriptor {
  const shell = tagSchemaShell(descriptor, options.definitions);
  return constraints.length ? { ...shell, constraints } : shell;
}
