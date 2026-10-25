import * as path from 'node:path';
import * as ts from '../typescript-ns.js';
import { collectSpecifications, type ModelSpecification, type TypeAnalysisContext } from './models.js';
import { descriptorBuilder, type ModelConversionDescriptor } from './types.js';
import { byRealPath, companionFilename, includedModelSources, isGeneratedCompanion, typeScriptErrorAt, type ModelBoundary } from './project.js';
import { pascalIdentifier } from './projection-names.js';
import { fieldProvenance } from './projections.js';
import { canonicalDescriptorKey } from '../schema.js';
import { deduplicateProjections } from './graph.js';
import { linkedClassNames, modelSpecificationForClass } from './symbols.js';
import { manifestModelOfSymbol, type ManifestIndex } from './provenance.js';
import { codecPublicId, createSchemaGraph, internDescriptors } from '../schema-graph.js';

export interface ContractAnalysis {
  readonly specifications: readonly ModelSpecification[];
  readonly definitions: Readonly<Record<string, ModelConversionDescriptor>>;
  /** Short name or hashed id → runtime codec id. */
  readonly codecIds: Readonly<Record<string, string>>;
  describe(type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): ModelConversionDescriptor;
  codecId(name: string): string | undefined;
  /** Whether a controller type is a model of the project. It reads the type without leaving a projection name behind. */
  isModel(type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): boolean;
  /** Codec id of the model a controller type is, even when other models share its component name. */
  modelCodecId(type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): string | undefined;
  /** Resolve a unique short name or a hashed codec id to its model spec. */
  specFor(name: string): ModelSpecification | undefined;
}

/** Shared source interpretation for controller contracts; it never loads application modules. */
export function createContractAnalysis(
  program: ts.Program,
  options: {
    readonly root: string;
    readonly allowAny?: boolean;
    readonly exact?: boolean;
    /** The models job of the app: a shared model's generated file is where that job writes it. Without it every generated file is beside its model file. */
    readonly boundary?: ModelBoundary;
    /** The model manifests of the program, as the models job reads them: a model a manifest lists has the codec id of its manifest entry. */
    readonly manifests?: ManifestIndex;
  },
): ContractAnalysis {
  const checker = program.getTypeChecker();
  const ownSources = program.getSourceFiles().filter(source => !source.isDeclarationFile
    && !source.fileName.replace(/\\/g, '/').includes('/node_modules/')
    && !isGeneratedCompanion(source.fileName)).map(source => source.fileName);
  // With the models job known, a model file of an installed package or a declaration file is a shared model file of the app, as it is for that job.
  const sharedSources = options.boundary === undefined ? [] : includedModelSources(
    program.getSourceFiles().filter(source => !program.isSourceFileDefaultLibrary(source)).map(source => source.fileName),
    options.boundary.suffixes,
  );
  // A file has one name: TypeScript's own spelling and the normalized one of a shared file are the same file.
  const sources = byRealPath([...ownSources, ...sharedSources]);
  const { specifications } = collectSpecifications(program, sources, options.exact, options.boundary && ((file) => companionFilename(options.boundary, file)));
  const emptyManifests: ManifestIndex = {
    byId: new Map(), byProvenance: new Map(), files: [], localFiles: [], validationSchemaClosure: [], runtimeExports: () => new Set(), externalModelForType: () => undefined,
  };
  // A model with exactly one linked class is named by that class, any other model by its alias.
  const baseNames = new Map(specifications.map((specification) => {
    const linked = linkedClassNames(checker, specification, specifications);
    return [specification, linked.length === 1 ? linked[0]! : specification.name] as const;
  }));
  // OpenAPI describes the full contract even when runtime validation is omitted.
  // The document describes an SDK model by its type; only the codec ids see it as the manifest reference the models job hashes.
  const buildDescribe = (nameFor?: (specification: ModelSpecification) => string, manifests: ManifestIndex = emptyManifests) => descriptorBuilder(checker, specifications, manifests, true, options.allowAny ?? false, options.root, false, nameFor, undefined, undefined, (node) => typeScriptErrorAt(program, node), file => program.isSourceFileDefaultLibrary(file));
  const describeAll = (builder: ReturnType<typeof buildDescribe>): Map<ModelSpecification, ModelConversionDescriptor> => new Map(
    specifications.map((specification) => [specification, builder(specification.fieldsType, specification, undefined, specification.fieldsNode)] as const),
  );
  const baseName = (specification: ModelSpecification): string => baseNames.get(specification) ?? specification.name;
  let describe = buildDescribe(baseName);
  let described = describeAll(describe);
  // Models whose names are equal but whose schemas differ are qualified by where they are declared.
  const componentNames = qualifiedComponentNames(specifications, described, baseName, options.root);
  const componentName = (specification: ModelSpecification): string => componentNames.get(specification) ?? baseName(specification);
  if (specifications.some((specification) => componentName(specification) !== baseName(specification))) {
    describe = buildDescribe(componentName);
    described = describeAll(describe);
  }
  // Codec ids hash descriptors named by alias and nesting an SDK model by its manifest, as the generated companions do; the document uses component names.
  const describeForIds = buildDescribe(undefined, options.manifests);
  const describedForIds = describeAll(describeForIds);
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
  for (const specification of specifications) {
    const descriptor = described.get(specification);
    const idDescriptor = describedForIds.get(specification);
    if (!descriptor || !idDescriptor) continue;
    const node = internGraph.nodeFor(idDescriptor, specification.name, specification.emitClass);
    // An SDK model keeps the id its manifest gives it, which is the id a build rewrite stamps; the document still describes its type.
    const alias = checker.getSymbolAtLocation(specification.declaration.name);
    const publicId = (alias && options.manifests && manifestModelOfSymbol(options.manifests.byProvenance, alias)?.codecId)
      || node?.codecId || codecPublicId(specification.name, idDescriptor, undefined, { source: 'typescript', constructs: specification.emitClass });
    codecBySpec.set(specification, publicId);
    const name = componentName(specification);
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
    return sameFields ? candidate : !type.isUnion() ? modelSpecificationForClass(checker, type, specifications) : undefined;
  };

  const describeController = (type: ts.Type, node: ts.Node, typeNode?: ts.TypeNode): ModelConversionDescriptor => {
    const syntax = typeNode ?? (ts.isTypeNode(node) ? node : undefined);
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
    return describe(type, context, undefined, syntax);
  };

  const analysis: ContractAnalysis = {
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
      const intact = intactModel(type, node, typeNode);
      if (intact) {
        return { kind: 'reference', name: componentName(intact) };
      }
      const descriptor = describeController(type, node, typeNode);
      return syncProjections(descriptor) ?? descriptor;
    },
    isModel(type, node, typeNode) {
      if (intactModel(type, node, typeNode)) return true;
      const descriptor = describe.isolated(() => describeController(type, node, typeNode));
      return descriptor.kind === 'reference' && analysis.specFor(descriptor.name) !== undefined;
    },
  };
  return analysis;
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

/**
 * Component names for the models of one project. Models that share a name and a schema share one
 * component. Models that share a name but not a schema are qualified: `<directory>.<Name>`, where
 * `<directory>` is the shortest trailing run of the declaring file's directory segments, relative
 * to `root`, that tells the different directories apart, joined with `.`. Models of one directory
 * that clash add the file name without `.model.ts` or `.ts`: `<directory>.<file>.<Name>`. Characters
 * other than letters, digits and underscores in a segment become `_`.
 */
function qualifiedComponentNames(
  specifications: readonly ModelSpecification[],
  described: ReadonlyMap<ModelSpecification, ModelConversionDescriptor>,
  baseName: (specification: ModelSpecification) => string,
  root: string,
): Map<ModelSpecification, string> {
  const names = new Map<ModelSpecification, string>();
  const groups = new Map<string, ModelSpecification[]>();
  for (const specification of specifications) {
    const name = baseName(specification);
    groups.set(name, [...(groups.get(name) ?? []), specification]);
  }
  const clean = (segment: string): string => segment.replace(/[^A-Za-z0-9_]/g, '_');
  const place = (specification: ModelSpecification): { readonly directory: readonly string[]; readonly stem: string } => {
    const relative = path.relative(root, specification.sourceFile.fileName).split(path.sep);
    const file = relative.pop() ?? '';
    return { directory: relative.filter((segment) => segment !== '' && segment !== '..').map(clean), stem: clean(file.replace(/\.model\.ts$|\.ts$/, '')) };
  };
  for (const [name, members] of groups) {
    const representatives = new Map<string, ModelSpecification>();
    for (const member of members) {
      const schema = canonicalDescriptorKey(described.get(member));
      if (!representatives.has(schema)) representatives.set(schema, member);
    }
    if (representatives.size === 1) continue;
    const reps = [...representatives.values()];
    const places = reps.map(place);
    const directories = new Set(places.map((item) => item.directory.join('/')));
    const longest = Math.max(0, ...places.map((item) => item.directory.length));
    let run = 1;
    const tail = (item: { readonly directory: readonly string[] }): string => item.directory.slice(-run).join('/');
    while (run < longest && new Set(places.map(tail)).size < directories.size) run += 1;
    reps.forEach((rep, index) => {
      const item = places[index]!;
      const shared = places.some((other, otherIndex) => otherIndex !== index && other.directory.join('/') === item.directory.join('/'));
      const qualified = [...item.directory.slice(-run), ...(shared ? [item.stem] : []), name].join('.');
      for (const member of members) {
        if (canonicalDescriptorKey(described.get(member)) === canonicalDescriptorKey(described.get(rep))) names.set(member, qualified);
      }
    });
  }
  return names;
}
