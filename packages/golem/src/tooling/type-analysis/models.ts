import { diagnostic, modelDeclarationKind } from './symbols.js';
import * as ts from '../typescript-ns.js';
import { descriptorBuilder } from './types.js';

export interface ModelSpecification {
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.TypeAliasDeclaration;
  readonly name: string;
  readonly fieldsNode: ts.TypeNode;
  readonly fieldsType: ts.Type;
  readonly exact: boolean;
  /** Undefined means the model did not override the profile policy. */
  readonly allowAny: boolean | undefined;
  /** IModel emits a class; IObject emits codecs only. */
  readonly emitClass: boolean;
  /** Override of the generation-profile validation flag; undefined inherits. */
  readonly validation?: boolean;
}

/** Analysis context for a field contract, including controller DTOs. */
export interface TypeAnalysisContext {
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.Node;
  readonly name: string;
  /** PascalCase owner for derived projection names when `name` is not one (controller contexts). */
  readonly ownerName?: string;
  readonly fieldsNode: ts.TypeNode;
  readonly fieldsType: ts.Type;
  readonly exact: boolean;
  readonly allowAny: boolean | undefined;
  readonly dto?: boolean;
  /** Nested TypeScript-shaped JSON Schema values are metadata, not model fields. */
  readonly schemaData?: boolean;
}

export interface CollectedSpecifications {
  readonly checker: ts.TypeChecker;
  readonly specifications: readonly ModelSpecification[];
}


function readOptionalBooleanOption(
  checker: ts.TypeChecker,
  optionsNode: ts.TypeNode | undefined,
  name: string,
): boolean | undefined {
  if (!optionsNode) return undefined;
  const optionsType = checker.getTypeFromTypeNode(optionsNode);
  const property = optionsType.getProperty(name);
  if (!property) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(property, optionsNode);
  if ((type.flags & ts.TypeFlags.BooleanLiteral) === 0) return undefined;
  return checker.typeToString(type) === 'true';
}

/** `exact` is the `golem.yaml` default for a model whose own `exact` option is absent. */
export function collectSpecifications(
  program: ts.Program,
  sources: readonly string[],
  exact = true,
): CollectedSpecifications {
  const checker = program.getTypeChecker();
  const specifications: ModelSpecification[] = [];
  for (const filename of sources) {
    const sourceFile = program.getSourceFile(filename);
    if (!sourceFile) throw new Error(`Could not load model source: ${filename}`);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isTypeAliasDeclaration(statement)
        || !ts.isTypeReferenceNode(statement.type)
      ) continue;
      const declarationKind = modelDeclarationKind(checker, statement.type);
      if (!declarationKind) continue;
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        throw diagnostic(sourceFile, statement, '1002', 'IModel and IObject type aliases must be exported.');
      }
      if (statement.typeParameters?.length) throw diagnostic(sourceFile, statement, '1057', 'IModel declarations must have concrete fields. Put generic wrappers outside IModel and instantiate them in a named model declaration.');
      const fieldsNode = statement.type.typeArguments?.[0];
      if (!fieldsNode) throw diagnostic(sourceFile, statement, '1001', 'IModel requires a fields type.');
      const optionsNode = statement.type.typeArguments?.[1];
      const fieldsType = checker.getTypeFromTypeNode(fieldsNode);
      if (fieldsType.isUnion()) {
        throw diagnostic(sourceFile, statement, '1052', 'Root IModel unions are unsupported. Put the union in a named model field, or declare separate models.');
      }
      specifications.push({
        sourceFile,
        declaration: statement,
        name: statement.name.text,
        fieldsNode,
        fieldsType,
        exact: readOptionalBooleanOption(checker, optionsNode, 'exact') ?? exact,
        allowAny: readOptionalBooleanOption(checker, optionsNode, 'allowAny'),
        emitClass: declarationKind === 'IModel',
        validation: readOptionalBooleanOption(checker, optionsNode, 'validation'),
      });
    }
  }
  const names = new Map<string, ModelSpecification>();
  for (const specification of specifications) {
    const key = `${specification.sourceFile.fileName}\0${specification.name}`;
    const previous = names.get(key);
    if (previous) {
      throw diagnostic(
        specification.sourceFile,
        specification.declaration,
        '1005',
        `Generated model name "${specification.name}" is already declared in this model source.`,
      );
    }
    names.set(key, specification);
  }
  return { checker, specifications };
}

export { descriptorBuilder };
