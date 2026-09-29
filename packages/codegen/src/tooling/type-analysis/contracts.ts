import * as ts from '../typescript-ns.js';
import { collectSpecifications, type ModelSpecification, type TypeAnalysisContext } from './models.js';
import { descriptorBuilder, type ModelConversionDescriptor } from './types.js';
import { fieldProvenance } from './projections.js';
import { deduplicateProjections } from './graph.js';
import { modelSpecificationForClass } from './symbols.js';
import type { ManifestIndex } from './provenance.js';
import { codecPublicId, createSchemaGraph, internDescriptors } from '../schema-graph.js';

export interface ContractAnalysis {
  readonly specifications: readonly ModelSpecification[];
  readonly definitions: Readonly<Record<string, ModelConversionDescriptor>>;
  /** Short name or hashed id → runtime codec id. */
  readonly codecIds: Readonly<Record<string, string>>;
  describe(type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): ModelConversionDescriptor;
  codecId(name: string): string | undefined;
  /** Resolve a unique short name or a hashed codec id to its model spec. */
  specFor(name: string): ModelSpecification | undefined;
}

/** Shared source interpretation for controller contracts; it never loads application modules. */
export function createContractAnalysis(
  program: ts.Program,
  options: { readonly root: string; readonly allowAny?: boolean },
): ContractAnalysis {
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile
    && !source.fileName.replace(/\\/g, '/').includes('/node_modules/')
    && !source.fileName.endsWith('.generated.ts')).map(source => source.fileName);
  const { specifications } = collectSpecifications(program, sources);
  const emptyManifests: ManifestIndex = {
    byId: new Map(), byProvenance: new Map(), files: [], localFiles: [], validationSchemaClosure: [], runtimeExports: () => new Set(), externalModelForType: () => undefined,
  };
  // OpenAPI describes the full contract even when runtime validation is omitted.
  const describe = descriptorBuilder(checker, specifications, emptyManifests, true, options.allowAny ?? false, options.root, program.getCompilerOptions(), false);
  const described = new Map<ModelSpecification, ModelConversionDescriptor>();
  for (const specification of specifications) {
    described.set(specification, describe(specification.fieldsType, specification, undefined, specification.fieldsNode));
  }
  const internGraph = createSchemaGraph();
  internDescriptors(internGraph, [
    ...specifications.flatMap((specification) => {
      const descriptor = described.get(specification);
      return descriptor ? [{ name: specification.name, descriptor, emitClass: specification.emitClass }] : [];
    }),
    ...[...describe.projections].map(([name, descriptor]) => ({ name, descriptor, emitClass: false })),
  ]);
  const definitions: Record<string, ModelConversionDescriptor> = {};
  const codecIds: Record<string, string> = {};
  const codecBySpec = new Map<ModelSpecification, string>();
  const nameCounts = new Map<string, number>();
  for (const specification of specifications) {
    nameCounts.set(specification.name, (nameCounts.get(specification.name) ?? 0) + 1);
  }
  for (const specification of specifications) {
    const descriptor = described.get(specification);
    if (!descriptor) continue;
    const node = internGraph.nodeFor(descriptor, specification.name);
    const publicId = node?.codecId ?? codecPublicId(specification.name, descriptor);
    codecBySpec.set(specification, publicId);
    codecIds[publicId] = publicId;
    const collided = (nameCounts.get(specification.name) ?? 0) > 1;
    definitions[collided ? publicId : specification.name] = descriptor;
    if (!collided) codecIds[specification.name] = publicId;
  }
  const syncProjections = (root?: ModelConversionDescriptor): ModelConversionDescriptor | undefined => {
    const graph = deduplicateProjections({
      ...definitions, ...Object.fromEntries(describe.projections),
      ...(root ? { __ControllerResult: root } : {}),
    });
    const result = graph.__ControllerResult;
    delete graph.__ControllerResult;
    for (const name of Object.keys(definitions)) delete definitions[name];
    Object.assign(definitions, graph);
    return result;
  };
  syncProjections();

  return {
    specifications,
    definitions,
    codecIds,
    codecId(name) {
      return codecIds[name];
    },
    specFor(name) {
      const hashed = codecIds[name];
      const matches = specifications.filter((item) => (
        item.name === name || codecBySpec.get(item) === name || (hashed !== undefined && codecBySpec.get(item) === hashed)
      ));
      if (matches.length === 1) return matches[0];
      if (hashed) return specifications.find((item) => codecBySpec.get(item) === hashed);
      return undefined;
    },
    describe(type, node, typeNode) {
      const syntax = typeNode ?? (ts.isTypeNode(node) ? node : undefined);
      const provenance = fieldProvenance(checker, syntax, specifications);
      const candidate = !provenance.projection && !type.isUnion() && provenance.models.length === 1 ? provenance.models[0] : undefined;
      const sameFields = candidate && checker.isTypeAssignableTo(type, candidate.fieldsType)
        && checker.isTypeAssignableTo(candidate.fieldsType, type)
        && checker.getPropertiesOfType(type).length === checker.getPropertiesOfType(candidate.fieldsType).length;
      const intact = sameFields ? candidate : !type.isUnion() ? modelSpecificationForClass(checker, type, specifications, program.getCompilerOptions()) : undefined;
      if (intact) {
        const publicId = codecBySpec.get(intact);
        const collided = (nameCounts.get(intact.name) ?? 0) > 1;
        return { kind: 'reference', name: collided && publicId ? publicId : intact.name };
      }
      const location = syntax ?? checker.typeToTypeNode(type, node, ts.NodeBuilderFlags.NoTruncation);
      if (!location) throw new Error('The controller field has no representable TypeScript type. Add an explicit type annotation.');
      // Actual source nodes carry diagnostics. The checker-generated node is
      // only a root marker when inferred controller returns lack an annotation.
      const context: TypeAnalysisContext = {
        sourceFile: node.getSourceFile(), declaration: node,
        name: type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ?? 'controller field',
        fieldsNode: location, fieldsType: type,
        exact: false, allowAny: undefined, dto: true,
      };
      const descriptor = describe(type, context, undefined, syntax);
      return syncProjections(descriptor) ?? descriptor;
    },
  };
}
