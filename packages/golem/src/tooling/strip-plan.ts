/**
 * The strip plan of a model: the data `strip` reads to remove the keys that a closed object does not declare from a wire
 * or model value. A plan is a constant of the generated module, so a call that does not strip reads none of it. The plan follows
 * the keys that the wire and the model share; a TSerde field, which has two shapes, is marked so that only a decode strips it. An inline object, array or tuple has its plan inside its parent's, and a named model is reached by its plan
 * function, so a model that holds itself has a plan, and another module's model by the plan that module exports. A union of objects with no tag has no plan, so it keeps exact matching.
 */

import type { DiscriminatorValue, ModelTypeDescriptor } from '../model-registry.js';
import { aliased, code, identifier, join, literal, type Code } from './code.js';
import { rtType } from './rt.js';
import { patternSchemas, serdeWireDescriptor, type SchemaGraph, type SchemaNode } from './schema-graph.js';
import { restHoldsInstance, variantPick, type ObjectTypeDescriptor, type VariantPick } from './union-conversion.js';

/** The type of a plan, which a generated module imports under this name. */
export const STRIP_PLAN = aliased(rtType.serde.StripPlan, '__GolemStripPlan');

/** What the plan builder asks of the emitter that owns the descriptors. */
export interface StripPlanEnv {
  readonly graph: SchemaGraph;
  /** The merged object of an object, an intersection of objects or a reference to one. */
  readonly resolveObject: (descriptor: ModelTypeDescriptor) => ObjectTypeDescriptor | undefined;
  /** The node a reference descriptor names. */
  readonly nodeOf: (descriptor: ModelTypeDescriptor) => SchemaNode | undefined;
  /** The type of the values of a map object or of its `additionalProperties`. */
  readonly extraValues: (descriptor: ObjectTypeDescriptor) => ModelTypeDescriptor | undefined;
  /** Whether the codec of the node is another module's. */
  readonly external: (node: SchemaNode) => boolean;
  /** The class the variant is picked by in the direction, when the generated writer of that direction picks by one; undefined when it has none. */
  readonly classOf: (descriptor: ModelTypeDescriptor, direction: VariantPick['direction']) => Code | undefined;
  /** The name this module imports the plan of another module's node under; undefined when that module offers none, so the node is left as it is. */
  readonly importedPlan: (node: SchemaNode) => Code | undefined;
  /** The name of the constant that holds the plan of a node this module emits. */
  readonly planName: (node: SchemaNode) => string;
}

/** The plans of one module, by node: the plan of a node is built once, and a node being built that is met again is assumed to have one. */
export class StripPlans {
  private readonly built = new Map<string, Code | undefined>();
  private readonly building = new Set<string>();

  public constructor(private readonly env: StripPlanEnv) {}

  /** The plan of the node, or undefined when the node holds no closed object to strip. */
  public ofNode(node: SchemaNode): Code | undefined {
    if (this.built.has(node.id)) return this.built.get(node.id);
    this.building.add(node.id);
    const plan = this.ofDescriptor(node.descriptor);
    this.building.delete(node.id);
    this.built.set(node.id, plan);
    return plan;
  }

  /** The reference to the plan of the node, for the plan of a parent. */
  private nodeRef(node: SchemaNode): Code | undefined {
    if (this.env.external(node)) return this.env.importedPlan(node);
    if (!this.building.has(node.id) && this.ofNode(node) === undefined) return undefined;
    return identifier(this.env.planName(node));
  }

  private ofDescriptor(descriptor: ModelTypeDescriptor): Code | undefined {
    const wire = serdeWireDescriptor(descriptor);
    if (wire !== undefined && wire !== descriptor) {
      // A TSerde value has the shape of its wire in a decode and its own shape in an encode, so the plan serves the decode only.
      const inner = this.ofDescriptor(wire);
      return inner === undefined ? undefined : code`{ kind: 'serde', wire: ${inner} }`;
    }
    switch (descriptor.kind) {
      case 'object': return this.ofObject(descriptor);
      case 'intersection': {
        const merged = this.env.resolveObject(descriptor);
        return merged === undefined ? undefined : this.ofObject(merged);
      }
      case 'array': {
        const items = this.ofDescriptor(descriptor.item);
        return items === undefined ? undefined : code`{ kind: 'sequence', prefix: [], items: ${items}, suffix: [] }`;
      }
      case 'tuple': return this.ofTuple(descriptor);
      case 'union': return this.ofUnion(descriptor);
      case 'reference':
      case 'generated-model': {
        const node = this.env.nodeOf(descriptor);
        return node === undefined ? undefined : this.nodeRef(node);
      }
      case 'any':
      case 'unknown':
      case 'never':
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
      case 'null':
      case 'undefined':
      case 'class-value':
      case 'literal': return undefined;
      default: return assertNever(descriptor);
    }
  }

  private ofObject(object: ObjectTypeDescriptor): Code | undefined {
    const extra = this.env.extraValues(object);
    const closed = object.additionalProperties === false && extra === undefined;
    const patterns = patternSchemas(object).map(({ pattern, schema }) => ({ pattern, plan: schema === undefined ? undefined : this.ofDescriptor(schema) }));
    const declared = Object.keys(object.properties);
    // A field called `__proto__` is a computed key: written as a plain key of an object literal it would set the prototype of the object, and the walk reads an own property only.
    const fields = declared.flatMap((name) => {
      const plan = this.ofDescriptor(object.properties[name]!);
      return plan === undefined ? [] : [name === '__proto__' ? code`[${literal(name)}]: ${plan}` : code`${literal(name)}: ${plan}`];
    });
    const values = closed || extra === undefined ? undefined : this.ofDescriptor(extra);
    if (!closed && fields.length === 0 && values === undefined && patterns.every((entry) => entry.plan === undefined)) return undefined;
    const patternList = join(patterns.map((entry) => code`{ pattern: ${literal(entry.pattern)}, plan: ${entry.plan ?? code`undefined`} }`), code`, `);
    return code`{ kind: 'object', keys: new Set(${literal(declared)}), closed: ${literal(closed)}, patterns: [${patternList}], fields: { ${join(fields, code`, `)} }, values: ${values ?? code`undefined`} }`;
  }

  private ofTuple(tuple: Extract<ModelTypeDescriptor, { readonly kind: 'tuple' }>): Code | undefined {
    // The items before the rest are the prefix and the items after it are the suffix, which the walk counts from the end of the array as the codec does.
    const restIndex = tuple.rest?.index ?? tuple.items.length;
    const prefix = tuple.items.slice(0, restIndex).map((item) => this.ofDescriptor(item));
    const suffix = tuple.rest === undefined ? [] : tuple.items.slice(restIndex).map((item) => this.ofDescriptor(item));
    const rest = tuple.rest === undefined ? undefined : this.ofDescriptor(tuple.rest.item);
    if (rest === undefined && !prefix.some((plan) => plan !== undefined) && !suffix.some((plan) => plan !== undefined)) return undefined;
    // The walk finds a position by the length of each list, so a list is complete, with `undefined` for an item that holds nothing to strip.
    const list = (plans: readonly (Code | undefined)[]) => code`[${join(plans.map((plan) => plan ?? code`undefined`), code`, `)}]`;
    return code`{ kind: 'sequence', prefix: ${list(prefix)}, items: ${rest ?? code`undefined`}, suffix: ${list(suffix)} }`;
  }

  private ofUnion(union: Extract<ModelTypeDescriptor, { readonly kind: 'union' }>): Code | undefined {
    const present = union.variants.flatMap((variant, index) => variant.kind === 'null' || variant.kind === 'undefined' ? [] : [{ variant, index }]);
    const table = union.discriminator;
    if (table !== undefined) {
      // A tagged union picks its variant by the tag and strips that variant; a value whose tag selects none goes to the default, as decoding does.
      const branches: { readonly variant: ModelTypeDescriptor; readonly values: readonly DiscriminatorValue[]; readonly plan: Code | undefined }[] = [];
      let fallback: { readonly variant: ModelTypeDescriptor; readonly plan: Code | undefined } | undefined;
      // A variant with no tag value and no default role takes its values by JSON type, as decoding does: one array there is the array of the union.
      const rest: ModelTypeDescriptor[] = [];
      const byType: { readonly descriptor: ModelTypeDescriptor; readonly shape: 'object' | 'array' | 'other' | 'serde' }[] = [];
      for (const { variant, index } of present) {
        const values = table.variants[index]?.values ?? [];
        if (values.length === 0 && index !== table.defaultVariant) {
          rest.push(variant);
          byType.push(...this.leaves(variant, new Set()));
          continue;
        }
        const plan = this.ofDescriptor(variant);
        if (index === table.defaultVariant) fallback = { variant, plan };
        // A variant with no plan still names its tags: a value of that tag is left as it is, and not given to the default variant.
        else branches.push({ variant, values, plan });
      }
      const planned = fallback?.plan !== undefined || branches.some((branch) => branch.plan !== undefined);
      const arrays = byType.filter((leaf) => leaf.shape === 'array');
      // A TSerde variant has one shape in the wire and another in the model, so the JSON type of a value does not tell which variant takes it.
      const array = arrays.length === 1 && !byType.some((leaf) => leaf.shape === 'serde') ? this.ofDescriptor(arrays[0]!.descriptor) : undefined;
      // The pick of each direction is built by the function that the writers of the union use, with the class that the codec of that direction tests, so strip and the codec choose the variant by one rule.
      const pick = (direction: VariantPick['direction']): Code => variantPick({
        property: table.propertyName,
        direction,
        branches: branches.map(({ variant, values }) => ({ values, className: this.env.classOf(variant, direction) })),
        hasRest: rest.length > 0,
        restIsInstance: restHoldsInstance(rest),
        fallback: fallback === undefined ? undefined : { className: this.env.classOf(fallback.variant, direction) },
      });
      // The plan of each branch in the order of the pick, and the plan of the default after them.
      const variants = [...branches, ...(fallback === undefined ? [] : [fallback])].map(({ plan }) => plan ?? code`undefined`);
      const objects = !planned ? undefined : code`{ kind: 'tagged', encode: ${pick('encode')}, decode: ${pick('decode')}, variants: [${join(variants, code`, `)}] }`;
      if (array === undefined) return objects;
      return code`{ kind: 'json-type', object: ${objects ?? code`undefined`}, array: ${array} }`;
    }
    // No tag: one object variant takes every object, so its plan is the union's. Two or more keep exact matching.
    const leaves = present.flatMap(({ variant }) => this.leaves(variant, new Set()));
    // A TSerde variant has one shape in the wire and another in the model, so the JSON type of a value does not tell which variant takes it.
    if (leaves.some((leaf) => leaf.shape === 'serde')) return undefined;
    const objects = leaves.filter((leaf) => leaf.shape === 'object');
    const arrays = leaves.filter((leaf) => leaf.shape === 'array');
    const object = objects.length === 1 ? this.ofDescriptor(objects[0]!.descriptor) : undefined;
    const array = arrays.length === 1 ? this.ofDescriptor(arrays[0]!.descriptor) : undefined;
    if (object !== undefined && array !== undefined) return code`{ kind: 'json-type', object: ${object}, array: ${array} }`;
    // Two arrays make exact matching, so an array is left as it is: the object plan may be a tagged union's, which holds an array plan of its own.
    if (object !== undefined && arrays.length > 1) return code`{ kind: 'json-type', object: ${object}, array: undefined }`;
    return object ?? array;
  }

  /**
   * The leaves of a tagged union: the union itself for its objects, then the leaves of the variants that take values by JSON type and are not objects,
   * so a union that holds the array of a tagged union is not taken to hold one array only.
   */
  private taggedLeaves(union: Extract<ModelTypeDescriptor, { readonly kind: 'union' }>, seen: Set<string>): { readonly descriptor: ModelTypeDescriptor; readonly shape: 'object' | 'array' | 'other' | 'serde' }[] {
    const table = union.discriminator!;
    const byType = union.variants.flatMap((variant, index) => (table.variants[index]?.values ?? []).length === 0 && index !== table.defaultVariant && variant.kind !== 'null' && variant.kind !== 'undefined' ? this.leaves(variant, seen) : []);
    return [{ descriptor: union, shape: 'object' }, ...byType.filter((leaf) => leaf.shape !== 'object')];
  }

  /** The variants a value of a union may take, with the unions inside it and the named unions it refers to opened, and the JSON type of each. */
  private leaves(descriptor: ModelTypeDescriptor, seen: Set<string>): { readonly descriptor: ModelTypeDescriptor; readonly shape: 'object' | 'array' | 'other' | 'serde' }[] {
    const wire = serdeWireDescriptor(descriptor);
    if (wire !== undefined && wire !== descriptor) return [{ descriptor, shape: 'serde' }];
    switch (descriptor.kind) {
      case 'object': return [{ descriptor, shape: 'object' }];
      case 'intersection': return [{ descriptor, shape: this.env.resolveObject(descriptor) === undefined ? 'other' : 'object' }];
      case 'array':
      case 'tuple': return [{ descriptor, shape: 'array' }];
      case 'union':
        if (descriptor.discriminator !== undefined) return this.taggedLeaves(descriptor, seen);
        return descriptor.variants.flatMap((variant) => variant.kind === 'null' || variant.kind === 'undefined' ? [] : this.leaves(variant, seen));
      case 'reference':
      case 'generated-model': {
        const node = this.env.nodeOf(descriptor);
        if (node === undefined) return [{ descriptor, shape: 'other' }];
        // Another module's node is read by its own descriptor when this module holds it (a recursive array alias of another group is an array, a union with no tag is its variants, a scalar is no object); only a placeholder of a model holds just its name, and a model is an object.
        if (this.env.external(node) && (node.descriptor.kind === 'reference' || node.descriptor.kind === 'generated-model')) return [{ descriptor, shape: 'object' }];
        if (seen.has(node.id)) return [];
        seen.add(node.id);
        const target = node.descriptor;
        if (target.kind === 'array' || target.kind === 'tuple') return [{ descriptor, shape: 'array' }];
        if (target.kind === 'union' && target.discriminator !== undefined) return [{ descriptor, shape: 'object' }, ...this.taggedLeaves(target, seen).slice(1)];
        if (target.kind === 'object' || target.kind === 'intersection') return [{ descriptor, shape: 'object' }];
        return target.kind === 'union' ? this.leaves(target, seen) : [{ descriptor, shape: 'other' }];
      }
      case 'any':
      case 'unknown':
      case 'never':
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
      case 'null':
      case 'undefined':
      case 'class-value':
      case 'literal': return [{ descriptor, shape: 'other' }];
      default: return assertNever(descriptor);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Internal error: unhandled descriptor ${JSON.stringify(value)}`);
}
