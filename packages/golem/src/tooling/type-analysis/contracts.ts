import * as ts from '../typescript-ns.js';
import { collectSpecifications, type ModelSpecification, type TypeAnalysisContext } from './models.js';
import { descriptorBuilder, type ModelConversionDescriptor } from './types.js';
import { pascalIdentifier } from './projection-names.js';
import { fieldProvenance } from './projections.js';
import { deduplicateProjections } from './graph.js';
import { exportedConcreteClass, modelSpecificationForClass } from './symbols.js';
import type { ManifestIndex } from './provenance.js';
import { codecPublicId, createSchemaGraph, internDescriptors } from '../schema-graph.js';

export interface ContractAnalysis {
  readonly specifications: readonly ModelSpecification[];
  readonly definitions: Readonly<Record<string, ModelConversionDescriptor>>;
  /** Short name or hashed id → runtime codec id. */
  readonly codecIds: Readonly<Record<string, string>>;
  describe(type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): ModelConversionDescriptor;
  codecId(name: string): string | undefined;
  /** Codec id of the model a controller type is, even when other models share its component name. */
  modelCodecId(type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): string | undefined;
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
  // A model with a class is named by that class, any other model by its alias.
  const componentNames = new Map(specifications.map((specification) => [
    specification,
    exportedConcreteClass(checker, specification, specifications, program.getCompilerOptions()) ?? specification.name,
  ] as const));
  const componentName = (specification: ModelSpecification): string => componentNames.get(specification) ?? specification.name;
  // OpenAPI describes the full contract even when runtime validation is omitted.
  const buildDescribe = (nameFor?: (specification: ModelSpecification) => string) => descriptorBuilder(checker, specifications, emptyManifests, true, options.allowAny ?? false, options.root, program.getCompilerOptions(), false, nameFor);
  // Codec ids hash descriptors named by alias, as the generated companions do; the document uses component names.
  const describeForIds = buildDescribe();
  const describe = buildDescribe(componentName);
  const described = new Map<ModelSpecification, ModelConversionDescriptor>();
  const describedForIds = new Map<ModelSpecification, ModelConversionDescriptor>();
  for (const specification of specifications) {
    described.set(specification, describe(specification.fieldsType, specification, undefined, specification.fieldsNode));
    describedForIds.set(specification, describeForIds(specification.fieldsType, specification, undefined, specification.fieldsNode));
  }
  const internGraph = createSchemaGraph();
  internDescriptors(internGraph, [
    ...specifications.flatMap((specification) => {
      const descriptor = describedForIds.get(specification);
      return descriptor ? [{ name: specification.name, descriptor, emitClass: specification.emitClass }] : [];
    }),
    ...[...describeForIds.projections].map(([name, descriptor]) => ({ name, descriptor, emitClass: false })),
  ]);
  const definitions: Record<string, ModelConversionDescriptor> = {};
  const codecIds: Record<string, string> = {};
  const codecBySpec = new Map<ModelSpecification, string>();
  const owners = new Map<string, ModelSpecification>();
  for (const specification of specifications) {
    const descriptor = described.get(specification);
    const idDescriptor = describedForIds.get(specification);
    if (!descriptor || !idDescriptor) continue;
    const node = internGraph.nodeFor(idDescriptor, specification.name, specification.emitClass);
    const publicId = node?.codecId ?? codecPublicId(specification.name, idDescriptor, undefined, { source: 'typescript', constructs: specification.emitClass });
    codecBySpec.set(specification, publicId);
    const name = componentName(specification);
    const other = owners.get(name);
    if (other !== undefined && JSON.stringify(described.get(other)) !== JSON.stringify(descriptor)) {
      throw new Error(
        `Models ${other.sourceFile.fileName} (${other.aliasName}) and ${specification.sourceFile.fileName} (${specification.aliasName}) `
        + `both map to the OpenAPI component name "${name}" with different schemas. Rename one of them or its class.`,
      );
    }
    owners.set(name, specification);
    codecIds[publicId] = publicId;
    codecIds[name] = publicId;
    codecIds[specification.name] = publicId;
    definitions[name] = descriptor;
  }
  const syncProjections = (root?: ModelConversionDescriptor): ModelConversionDescriptor | undefined => {
    const graph = deduplicateProjections({
      ...definitions, ...Object.fromEntries(describe.projections),
      ...(root ? { __ControllerResult: root } : {}),
    }, new Set(describe.projections.keys()));
    const result = graph.__ControllerResult;
    delete graph.__ControllerResult;
    for (const name of Object.keys(definitions)) delete definitions[name];
    Object.assign(definitions, graph);
    return result;
  };
  syncProjections();

  const intactModel = (type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): ModelSpecification | undefined => {
    const syntax = typeNode ?? (ts.isTypeNode(node) ? node : undefined);
    const provenance = fieldProvenance(checker, syntax, specifications);
    const candidate = !provenance.projection && !type.isUnion() && provenance.models.length === 1 ? provenance.models[0] : undefined;
    const sameFields = candidate && checker.isTypeAssignableTo(type, candidate.fieldsType)
      && checker.isTypeAssignableTo(candidate.fieldsType, type)
      && checker.getPropertiesOfType(type).length === checker.getPropertiesOfType(candidate.fieldsType).length;
    return sameFields ? candidate : !type.isUnion() ? modelSpecificationForClass(checker, type, specifications, program.getCompilerOptions()) : undefined;
  };

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
        item.name === name || componentName(item) === name || codecBySpec.get(item) === name || (hashed !== undefined && codecBySpec.get(item) === hashed)
      ));
      if (matches.length === 1) return matches[0];
      if (hashed) return specifications.find((item) => codecBySpec.get(item) === hashed);
      return undefined;
    },
    modelCodecId(type, node, typeNode) {
      const intact = intactModel(type, node, typeNode);
      return intact ? codecBySpec.get(intact) : undefined;
    },
    describe(type, node, typeNode) {
      const syntax = typeNode ?? (ts.isTypeNode(node) ? node : undefined);
      const intact = intactModel(type, node, typeNode);
      if (intact) {
        return { kind: 'reference', name: componentName(intact) };
      }
      const location = syntax ?? checker.typeToTypeNode(type, node, ts.NodeBuilderFlags.NoTruncation);
      if (!location) throw new Error('The controller field has no representable TypeScript type. Add an explicit type annotation.');
      // Actual source nodes carry diagnostics. The checker-generated node is
      // only a root marker when inferred controller returns lack an annotation.
      const context: TypeAnalysisContext = {
        sourceFile: node.getSourceFile(), declaration: node,
        name: type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ?? 'controller field',
        ownerName: controllerOwnerName(node),
        fieldsNode: location, fieldsType: type,
        exact: false, allowAny: undefined, dto: true,
      };
      const descriptor = describe(type, context, undefined, syntax);
      return syncProjections(descriptor) ?? descriptor;
    },
  };
}

/** `PaymentsCreateBody` for the body of `PaymentsController.create`; `PaymentsCreateResponse` for what it returns. */
function controllerOwnerName(node: ts.Node): string {
  let method: ts.Node | undefined = node;
  while (method && !ts.isMethodDeclaration(method)) method = method.parent;
  const methodPart = method && ts.isMethodDeclaration(method) && ts.isIdentifier(method.name)
    ? pascalIdentifier(method.name.text) ?? ''
    : '';
  let role = 'Response';
  if (ts.isParameter(node)) {
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
    const decorated = decorators
      .map(decorator => ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression)
      .filter(ts.isIdentifier)
      .map(identifier => identifier.text)
      .find(name => name === 'Body' || name === 'Query');
    role = decorated ?? (ts.isIdentifier(node.name) ? pascalIdentifier(node.name.text) ?? 'Input' : 'Input');
  }
  const controller = method?.parent && ts.isClassDeclaration(method.parent) ? method.parent.name?.text : undefined;
  const controllerPart = controller ? pascalIdentifier(controller.replace(/(?<=.)Controller$/, '')) ?? '' : '';
  return `${controllerPart}${methodPart || 'Controller'}${role}`;
}
