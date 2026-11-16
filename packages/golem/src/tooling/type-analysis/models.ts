import { displayPath, invalidValidationLevelMessage, validationRank } from '../generator-core.js';
import type { GolemProfile } from '../generator-core.js';
import { diagnostic, modelDeclarationKind } from './symbols.js';
import * as ts from '../typescript-ns.js';
import { findBuiltinClass } from './builtin-class.js';
import { descriptorBuilder, isErrorAny } from './types.js';
import type { WrittenFunctions } from './tags.js';

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
  /** Override of the generation-profile validation level, never above it; undefined inherits. */
  readonly validation?: GolemProfile['validation'];
  /** The generated companion of the model's file, when it is not beside the file: a shared file's, in the models output. */
  readonly companionFile?: string;
}

/** What a caller that reads controller DTOs tells the analysis about the metadata of a DTO field. */
export interface DtoRule {
  /** Whether the property carries metadata that states its schema itself, so a Map or Set field needs no model. */
  readonly statesSchema: (checker: ts.TypeChecker, property: ts.Symbol) => boolean;
  /** The error for a Map or Set in a DTO. `decoratable` is true for a class field, which metadata can reach. */
  readonly mapOrSetError: (sourceFile: ts.SourceFile, node: ts.Node, where: string, collection: string, decoratable: boolean) => Error;
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
  /** A controller DTO class field: no model converts it, so a union in it needs no tag and a method is no field. */
  readonly dto?: boolean;
  /** The rule of the caller that reads DTOs. Without it, no decorator counts as metadata that states a schema, and a Map or Set stops with RUNM1004. */
  readonly dtoRule?: DtoRule;
  /** Nested TypeScript-shaped JSON Schema values are metadata, not model fields. */
  readonly schemaData?: boolean;
  /** The field being described, for a diagnostic; absent at the root of a model. */
  readonly field?: string;
  /** The functions that the tags of the fields around this one write: what the checker read of a tag in a generic type names. */
  readonly writtenFunctions?: WrittenFunctions;
}

/** A descriptor kind (or a type's kind) as the phrase the RUNM1052 message uses: "an array", "a Date", "any". */
export function describeRootKind(kind: string): string {
  if (kind === 'any' || kind === 'unknown') return kind;
  return `${/^[aeio]/.test(kind) ? 'an' : 'a'} ${kind}`;
}

/** RUNM1052: the one message for a root that is no object, whether the type or its descriptor shows it. */
export function nonObjectRootDiagnostic(
  sourceFile: ts.SourceFile,
  declaration: ts.TypeAliasDeclaration,
  declarationKind: 'IModel' | 'IObject',
  found: string,
): Error {
  return diagnostic(sourceFile, declaration, '1052', `The ${declarationKind} fields type must be an object type, but ${declaration.name.text} has ${found}. Declare the fields in an object type, and put the value in a field of a model.`);
}

/** What a fields type is when it is no object type, as the RUNM1052 phrase; undefined for an object type. */
function nonObjectKind(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (type.isUnion()) return describeRootKind('union');
  if (type.isIntersection()) {
    const member = type.types.map((item) => nonObjectKind(checker, item)).find((kind) => kind !== undefined);
    return member && `an intersection with ${member}`;
  }
  if (checker.isTupleType(type)) return describeRootKind('tuple');
  if (checker.isArrayType(type)) return describeRootKind('array');
  const builtin = findBuiltinClass(type);
  if (builtin !== undefined) return describeRootKind(builtin.qualifiedName);
  if ((type.flags & ts.TypeFlags.Any) !== 0) return describeRootKind('any');
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return describeRootKind('unknown');
  if ((type.flags & ts.TypeFlags.Object) === 0) return checker.typeToString(type) === 'object' ? 'the object keyword' : describeRootKind('scalar');
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return describeRootKind('function');
  return undefined;
}

export interface CollectedSpecifications {
  readonly checker: ts.TypeChecker;
  readonly specifications: readonly ModelSpecification[];
}


/**
 * The declared type of a model option as its members without `undefined`, so `exact?: false` reads as `false`. Empty when the model
 * does not set the option. Every option reader starts here, so no reader sees the `undefined` that an optional property adds.
 */
function readOptionMembers(checker: ts.TypeChecker, optionsNode: ts.TypeNode | undefined, name: string): readonly ts.Type[] {
  if (!optionsNode) return [];
  const property = checker.getTypeFromTypeNode(optionsNode).getProperty(name);
  if (!property) return [];
  const type = checker.getTypeOfSymbolAtLocation(property, optionsNode);
  return (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & ts.TypeFlags.Undefined) === 0);
}

/** The members of an option type as one text, such as `false | true`, for the RUNM1089 message. */
function describeMembers(checker: ts.TypeChecker, members: readonly ts.Type[]): string {
  return members.map((member) => checker.typeToString(member)).join(' | ');
}

/** The value of `true` or `false` as a type; undefined for any other type. */
function booleanLiteralValue(checker: ts.TypeChecker, type: ts.Type): boolean | undefined {
  return (type.flags & ts.TypeFlags.BooleanLiteral) === 0 ? undefined : checker.typeToString(type) === 'true';
}

/** The `exact` or `allowAny` option of a model: `true` or `false`; undefined when the model does not set it. A wide `boolean` or any other type stops with RUNM1089. */
function readBooleanOption(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  declaration: ts.TypeAliasDeclaration,
  optionsNode: ts.TypeNode | undefined,
  name: 'exact' | 'allowAny',
): boolean | undefined {
  const members = readOptionMembers(checker, optionsNode, name);
  const [only] = members;
  if (only === undefined) return undefined;
  const value = members.length === 1 ? booleanLiteralValue(checker, only) : undefined;
  if (value !== undefined) return value;
  throw diagnostic(sourceFile, declaration, '1089', `The ${name} option of ${declaration.name.text} must be true or false. It is ${describeMembers(checker, members)}.`);
}

/** The `validation` option of a model: `true`, `false` or `'sanity'`; undefined when the model does not set it. Any other value stops with RUNM1089. */
function readValidationOption(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  declaration: ts.TypeAliasDeclaration,
  optionsNode: ts.TypeNode | undefined,
): GolemProfile['validation'] | undefined {
  const members = readOptionMembers(checker, optionsNode, 'validation');
  const [only] = members;
  if (only === undefined) return undefined;
  if (members.length === 1) {
    const value = booleanLiteralValue(checker, only);
    if (value !== undefined) return value;
    if (ts.isStringLiteralType(only) && only.value === 'sanity') return 'sanity';
  }
  throw diagnostic(sourceFile, declaration, '1089', `${invalidValidationLevelMessage(`The validation option of ${declaration.name.text}`)} It is ${describeMembers(checker, members)}.`);
}

const levelText = (level: GolemProfile['validation']): string => level === 'sanity' ? `'sanity'` : String(level);

/**
 * RUNM1089: a model may lower the validation level of its project, never raise it. The order is `false` < `'sanity'` < `true`, so a
 * model at `'sanity'` in a project at `false`, and a model at `true` in a project at `'sanity'` or `false`, stop generation.
 */
export function assertModelLevelsWithinProject(specifications: readonly ModelSpecification[], project: GolemProfile['validation']): void {
  for (const { validation, sourceFile, declaration, name } of specifications) {
    if (validation === undefined || validationRank(validation) <= validationRank(project)) continue;
    throw diagnostic(sourceFile, declaration, '1089',
      `${name} sets validation ${levelText(validation)}, which is above the project level ${levelText(project)}. A model may lower the level of its project, never raise it. Set the model to ${levelText(project)} or lower, or raise validation in golem.yaml.`);
  }
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
    if (!sourceFile) throw new Error(`Could not load model source: ${displayPath(filename)}`);
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
      if (isErrorAny(fieldsType)) {
        throw diagnostic(sourceFile, statement, '1058', `The fields type of ${statement.name.text} could not be resolved. Fix its declaration or import.`);
      }
      const found = nonObjectKind(checker, fieldsType);
      if (found) throw nonObjectRootDiagnostic(sourceFile, statement, declarationKind, found);
      specifications.push({
        sourceFile,
        declaration: statement,
        name: statement.name.text,
        fieldsNode,
        fieldsType,
        exact: readBooleanOption(checker, sourceFile, statement, optionsNode, 'exact') ?? exact,
        allowAny: readBooleanOption(checker, sourceFile, statement, optionsNode, 'allowAny'),
        emitClass: declarationKind === 'IModel',
        validation: readValidationOption(checker, sourceFile, statement, optionsNode),
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
