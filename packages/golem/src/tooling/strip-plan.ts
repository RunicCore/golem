/**
 * The strip plan of a model: the data `strip` reads to remove the keys that a closed object does not declare from a wire
 * or model value. A plan is a constant of the generated module, so a call that does not strip reads none of it. The plan follows
 * the keys that the wire and the model share; a TSerde field, which has two shapes, is marked so that only a decode strips it. An inline object, array or tuple has its plan inside its parent's, and a named model is reached by its plan
 * function, so a model that holds itself has a plan, and another module's model by the plan that module exports. A union of objects with no tag has no plan, so it keeps exact matching.
 */

import type { ModelTypeDescriptor } from '../model-registry.js';
import { code, identifier, join, literal, type Code } from './code.js';
import { serdeWireDescriptor, type SchemaGraph, type SchemaNode } from './schema-graph.js';
import type { ObjectTypeDescriptor } from './union-conversion.js';

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
      return inner === undefined ? undefined : code`{ serde: ${inner} }`;
    }
    switch (descriptor.kind) {
      case 'object': return this.ofObject(descriptor);
      case 'intersection': {
        const merged = this.env.resolveObject(descriptor);
        return merged === undefined ? undefined : this.ofObject(merged);
      }
      case 'array': {
        const items = this.ofDescriptor(descriptor.item);
        return items === undefined ? undefined : code`{ items: ${items} }`;
      }
      case 'tuple': return this.ofTuple(descriptor);
      case 'union': return this.ofUnion(descriptor);
      case 'reference':
      case 'generated-model': {
        const node = this.env.nodeOf(descriptor);
        return node === undefined ? undefined : this.nodeRef(node);
      }
      default: return undefined;
    }
  }

  private ofObject(object: ObjectTypeDescriptor): Code | undefined {
    const extra = this.env.extraValues(object);
    const closed = object.additionalProperties === false && extra === undefined;
    const patterns = (object.constraints ?? []).flatMap((constraint) => constraint.kind === 'patternProperties' ? [constraint.pattern] : []);
    const declared = Object.keys(object.properties);
    // A field called `__proto__` cannot be a key of an object literal, so its value is left as it is.
    const fields = declared.flatMap((name) => {
      const plan = name === '__proto__' ? undefined : this.ofDescriptor(object.properties[name]!);
      return plan === undefined ? [] : [code`${literal(name)}: ${plan}`];
    });
    const values = closed || extra === undefined ? undefined : this.ofDescriptor(extra);
    if (!closed && fields.length === 0 && values === undefined) return undefined;
    const members: Code[] = [];
    if (declared.length > 0) members.push(code`keys: new Set(${literal(declared)})`);
    if (closed) members.push(code`closed: true`);
    if (patterns.length > 0) members.push(code`patterns: ${literal(patterns)}`);
    if (fields.length > 0) members.push(code`fields: { ${join(fields, code`, `)} }`);
    if (values !== undefined) members.push(code`values: ${values}`);
    return code`{ ${join(members, code`, `)} }`;
  }

  private ofTuple(tuple: Extract<ModelTypeDescriptor, { readonly kind: 'tuple' }>): Code | undefined {
    const fixed = tuple.rest === undefined ? tuple.items : tuple.items.slice(0, tuple.rest.index);
    const prefix = fixed.map((item) => this.ofDescriptor(item));
    // The items after a variadic part sit at positions the plan does not know, so such a tuple strips nothing in its rest.
    const rest = tuple.rest !== undefined && tuple.rest.index >= tuple.items.length ? this.ofDescriptor(tuple.rest.item) : undefined;
    const members: Code[] = [];
    if (prefix.some((plan) => plan !== undefined)) members.push(code`prefix: [${join(prefix.map((plan) => plan ?? code`undefined`), code`, `)}]`);
    if (rest !== undefined) members.push(code`items: ${rest}`);
    return members.length === 0 ? undefined : code`{ ${join(members, code`, `)} }`;
  }

  private ofUnion(union: Extract<ModelTypeDescriptor, { readonly kind: 'union' }>): Code | undefined {
    const present = union.variants.flatMap((variant, index) => variant.kind === 'null' || variant.kind === 'undefined' ? [] : [{ variant, index }]);
    const table = union.discriminator;
    if (table !== undefined) {
      // A tagged union picks its variant by the tag and strips that variant; a value whose tag selects none goes to the default, as decoding does.
      const entries: Code[] = [];
      let fallback: Code | undefined;
      let planned = false;
      for (const { variant, index } of present) {
        const plan = this.ofDescriptor(variant);
        planned ||= plan !== undefined;
        if (index === table.defaultVariant) fallback = plan;
        // A variant with no plan still names its tags: a value of that tag is left as it is, and not given to the default variant.
        else for (const value of table.variants[index]?.values ?? []) entries.push(code`${literal(String(value))}: ${plan ?? code`undefined`}`);
      }
      if (!planned) return undefined;
      return code`{ tag: ${literal(table.propertyName)}${entries.length > 0 ? code`, variants: { ${join(entries, code`, `)} }` : code``}${fallback ? code`, default: ${fallback}` : code``} }`;
    }
    // No tag: one object variant takes every object, so its plan is the union's. Two or more keep exact matching.
    const leaves = present.flatMap(({ variant }) => this.leaves(variant, new Set()));
    // A TSerde variant has one shape in the wire and another in the model, so the JSON type of a value does not tell which variant takes it.
    if (leaves.some((leaf) => leaf.shape === 'serde')) return undefined;
    const objects = leaves.filter((leaf) => leaf.shape === 'object');
    const arrays = leaves.filter((leaf) => leaf.shape === 'array');
    const object = objects.length === 1 ? this.ofDescriptor(objects[0]!.descriptor) : undefined;
    const array = arrays.length === 1 ? this.ofDescriptor(arrays[0]!.descriptor) : undefined;
    if (object !== undefined && array !== undefined) return code`{ object: ${object}, array: ${array} }`;
    return object ?? array;
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
        if (descriptor.discriminator !== undefined) return [{ descriptor, shape: 'object' }];
        return descriptor.variants.flatMap((variant) => variant.kind === 'null' || variant.kind === 'undefined' ? [] : this.leaves(variant, seen));
      case 'reference':
      case 'generated-model': {
        const node = this.env.nodeOf(descriptor);
        if (node === undefined) return [{ descriptor, shape: 'other' }];
        if (this.env.external(node)) return [{ descriptor, shape: 'object' }];
        if (seen.has(node.id)) return [];
        seen.add(node.id);
        const target = node.descriptor;
        if (target.kind === 'array' || target.kind === 'tuple') return [{ descriptor, shape: 'array' }];
        if (target.kind === 'object' || target.kind === 'intersection' || (target.kind === 'union' && target.discriminator !== undefined)) return [{ descriptor, shape: 'object' }];
        return target.kind === 'union' ? this.leaves(target, seen) : [{ descriptor, shape: 'other' }];
      }
      default: return [{ descriptor, shape: 'other' }];
    }
  }
}
