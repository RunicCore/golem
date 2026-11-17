import type { ModelTypeDescriptor } from '#golem/schema';
import { createSchemaGraph, type SchemaNode } from '#golem/schema-graph';
import type { StripPlanEnv } from '#golem/strip-plan';

/** An object that declares `properties` and no others; `required` defaults to all of them. */
export function closedObject(properties: Readonly<Record<string, ModelTypeDescriptor>>, required: readonly string[] = Object.keys(properties)): ModelTypeDescriptor {
  return { kind: 'object', properties, required, additionalProperties: false };
}

/** The node that a graph makes for the descriptor, as the generator interns it. */
export function schemaNode(name: string, descriptor: ModelTypeDescriptor): SchemaNode {
  return createSchemaGraph().intern(descriptor, name);
}

function notStubbed(member: string): () => never {
  return () => {
    throw new Error(`The test stubs no StripPlanEnv.${member}`);
  };
}

/** The environment of a strip plan, with the members a test stubs; a member it leaves out throws when the plan asks for it. */
export function stripPlanEnv(stubs: Partial<StripPlanEnv>): StripPlanEnv {
  const notUsed: StripPlanEnv = {
    resolveObject: notStubbed('resolveObject'),
    nodeOf: notStubbed('nodeOf'),
    extraValues: notStubbed('extraValues'),
    external: notStubbed('external'),
    holdsSequence: notStubbed('holdsSequence'),
    classOf: notStubbed('classOf'),
    importedPlan: notStubbed('importedPlan'),
    planName: notStubbed('planName'),
  };
  return { ...notUsed, ...stubs };
}
