import { diagnostic, modelDeclarationKind } from './symbols.js';
import * as ts from '../typescript-ns.js';
import { isDateType } from './tags.js';
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
  /** The generated companion of the model's file, when it is not beside the file: a shared file's, in `models.output`. */
  readonly companionFile?: string;
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
  /** The field being described, for a diagnostic; absent at the root of a model. */
  readonly field?: string;
}

/** What a fields type is when it is no object type, as a noun phrase for the RUNM1052 message; undefined for an object type. */
function nonObjectKind(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (type.isUnion()) return 'a union';
  if (type.isIntersection()) {
    const member = type.types.map((item) => nonObjectKind(checker, item)).find((kind) => kind !== undefined);
    return member && `an intersection with ${member}`;
  }
  if (checker.isTupleType(type)) return 'a tuple';
  if (checker.isArrayType(type)) return 'an array';
  if (isDateType(checker, type)) return 'a Date';
  if ((type.flags & ts.TypeFlags.Object) === 0) return 'a scalar';
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return 'a function';
  return undefined;
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
  /** The companion path of a model file; omitted means beside the file. */
  companionOf?: (filename: string) => string,
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
      const found = nonObjectKind(checker, fieldsType);
      if (found) {
        throw diagnostic(sourceFile, statement, '1052', `The IModel fields type must be an object type, but ${statement.name.text} has ${found}. Declare the fields in an object type, and put a union, array or scalar in a named model field.`);
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
        ...(companionOf ? { companionFile: companionOf(filename) } : {}),
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
