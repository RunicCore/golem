import * as ts from '@exprtlabs/golem/ts';
import { resolveSymbol } from '@exprtlabs/golem/type-analysis';
import {
  isTypeScriptLibFile,
  resolveValueSymbol,
  singleReturnExpression,
  unwrapExpression,
} from '../evaluation/static-value.js';
import { evaluateRouteExpression } from '../evaluation/evaluate.js';
import type { DecoratorInfo, NestAnalysisContext, TypeReference } from './types.js';

export function isDecorator(info: DecoratorInfo, name: string, packageName?: string): boolean {
  return info.name === name && (packageName === undefined || info.packageName === packageName);
}

export function hasDecorator(
  decorators: readonly DecoratorInfo[],
  name: string,
  packageName?: string,
): DecoratorInfo | undefined {
  return decorators.find(item => isDecorator(item, name, packageName));
}

export function hasAnyDecorator(
  decorators: readonly DecoratorInfo[],
  names: readonly string[],
  packageName?: string,
): readonly DecoratorInfo[] {
  return decorators.filter(item => names.some(name => isDecorator(item, name, packageName)));
}

function isUserValueDeclaration(declaration: ts.Node | undefined): boolean {
  const file = declaration?.getSourceFile?.();
  return file !== undefined && file.isDeclarationFile === false;
}

export function isTypeScriptBuiltinConstructor(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  name: string,
): boolean {
  const value = unwrapExpression(expression);
  if (!ts.isIdentifier(value) || value.text !== name) return false;
  const symbol = resolveValueSymbol(checker, value);
  if (!symbol || symbol.getName() !== name) return false;
  const declarations = symbol.declarations ?? [];
  if (isUserValueDeclaration(symbol.valueDeclaration) || declarations.some(isUserValueDeclaration)) {
    return false;
  }
  // TS 7 may expose global constructors without resolvable lib .d.ts handles.
  if (declarations.length === 0) return true;
  return declarations.some(declaration => isTypeScriptLibFile(declaration.getSourceFile().fileName));
}

export function typeReference(
  checker: ts.TypeChecker,
  node: ts.Node,
  typeNode?: ts.TypeNode,
  resolvedType?: ts.Type,
): TypeReference {
  const type = resolvedType ?? (typeNode ? checker.getTypeFromTypeNode(typeNode) : checker.getTypeAtLocation(node));
  const symbol = type.aliasSymbol ?? type.getSymbol?.();
  const declaration = symbol?.declarations?.[0];
  return {
    type,
    ...(typeNode ? { node: typeNode } : {}),
    ...(declaration ? { declaration } : {}),
    sourceNode: node,
    sourceFile: node.getSourceFile(),
  };
}

function typeReferenceFromExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): TypeReference | undefined {
  const unwrapped = unwrapExpression(expression);
  if (
    ts.isArrowFunction(unwrapped)
    || ts.isFunctionExpression(unwrapped)
  ) {
    const returnedExpression = singleReturnExpression(unwrapped);
    // Nest Swagger commonly uses `type: () => Model`. Resolve the returned
    // class identifier as an instance type instead of retaining the
    // constructor type produced by the function signature.
    if (returnedExpression) {
      const returned = typeReferenceFromExpression(checker, returnedExpression);
      if (returned) return returned;
    }
    const signature = checker.getSignaturesOfType(
      checker.getTypeAtLocation(unwrapped),
      ts.SignatureKind.Call,
    )[0];
    const returnType = signature?.getReturnType();
    if (!returnType) return undefined;
    const declaration = returnType.aliasSymbol?.declarations?.[0] ?? returnType.getSymbol?.()?.declarations?.[0];
    return {
      type: returnType,
      ...(declaration ? { declaration } : {}),
      sourceNode: expression,
      sourceFile: expression.getSourceFile(),
    };
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return undefined;
  }
  if (ts.isIdentifier(unwrapped)) {
    if (unwrapped.text === 'String' && isTypeScriptBuiltinConstructor(checker, unwrapped, 'String')) {
      return { type: checker.getStringType(), sourceNode: expression, sourceFile: expression.getSourceFile() };
    }
    if (unwrapped.text === 'Number' && isTypeScriptBuiltinConstructor(checker, unwrapped, 'Number')) {
      return { type: checker.getNumberType(), sourceNode: expression, sourceFile: expression.getSourceFile() };
    }
    if (unwrapped.text === 'Boolean' && isTypeScriptBuiltinConstructor(checker, unwrapped, 'Boolean')) {
      return { type: checker.getBooleanType(), sourceNode: expression, sourceFile: expression.getSourceFile() };
    }
    const symbol = resolveValueSymbol(checker, unwrapped);
    if (symbol && (symbol.flags & ts.SymbolFlags.Class) !== 0) {
      const instanceType = checker.getDeclaredTypeOfSymbol(symbol);
      return {
        type: instanceType,
        ...(symbol.declarations?.[0] ? { declaration: symbol.declarations[0] } : {}),
        sourceNode: expression,
        sourceFile: expression.getSourceFile(),
      };
    }
  }
  return {
    ...typeReference(checker, expression),
  };
}

/** Mark references resolved to an authored IModel so Swagger metadata cannot
 * replace its authoritative wire contract later in operation assembly. */
export function authoritativeTypeReference(
  context: NestAnalysisContext,
  reference: TypeReference | undefined,
): TypeReference | undefined {
  if (!reference || !context.contractAnalysis) return reference;
  const node = reference.sourceNode ?? reference.declaration ?? reference.sourceFile;
  const descriptor = context.contractAnalysis.describe(reference.type, node, reference.node);
  const fromReference = (): string | undefined => {
    const own = context.contractAnalysis!.modelCodecId(reference.type, node, reference.node);
    if (own) return own;
    if (descriptor.kind !== 'reference') return undefined;
    const spec = context.contractAnalysis!.specFor(descriptor.name);
    if (!spec) return undefined;
    return context.contractAnalysis!.codecId(descriptor.name)
      ?? context.contractAnalysis!.codecId(spec.name);
  };
  const fromAlias = (): string | undefined => {
    const alias = reference.type.aliasSymbol?.getName() ?? reference.type.getSymbol?.()?.getName();
    if (!alias) return undefined;
    const spec = context.contractAnalysis!.specFor(alias);
    if (!spec) return context.contractAnalysis!.codecId(alias);
    return context.contractAnalysis!.codecId(spec.name) ?? context.contractAnalysis!.codecId(alias);
  };
  const codecId = fromReference() ?? fromAlias();
  if (!codecId) return reference;
  return { ...reference, modelContractName: codecId };
}

/**
 * The method's call signature as seen from the analysed controller. An
 * inherited method from a generic base (`CrudController<User>`) is
 * instantiated with the derived class's type arguments instead of `T`.
 */
export function controllerMethodSignature(
  checker: ts.TypeChecker,
  method: ts.MethodDeclaration,
  controllerClass: ts.ClassDeclaration,
): ts.Signature | undefined {
  const declared = checker.getSignatureFromDeclaration(method);
  if (method.parent === controllerClass || !ts.isIdentifier(method.name)) return declared;
  const member = checker.getPropertyOfType(checker.getTypeAtLocation(controllerClass), method.name.text);
  if (!member) return declared;
  const signatures = checker.getSignaturesOfType(
    checker.getTypeOfSymbolAtLocation(member, controllerClass),
    ts.SignatureKind.Call,
  );
  return signatures.find(signature => signature.declaration === method)
    ?? (signatures.length === 1 ? signatures[0] : declared);
}

/** The type of a controller method parameter, instantiated for the analysed controller. */
export function controllerParameterType(
  checker: ts.TypeChecker,
  signature: ts.Signature | undefined,
  parameter: ts.ParameterDeclaration,
  index: number,
  controllerClass: ts.ClassDeclaration,
): ts.Type {
  const declared = parameter.type ? checker.getTypeFromTypeNode(parameter.type) : checker.getTypeAtLocation(parameter);
  const symbol = signature?.parameters[index];
  return symbol ? checker.getTypeOfSymbolAtLocation(symbol, controllerClass) : declared;
}

function isAsyncWrapper(type: ts.Type): boolean {
  const symbol = type.getSymbol?.();
  const name = symbol?.getName();
  if (name === 'Promise') return true;
  if (name !== 'Observable') return false;
  return (symbol?.declarations ?? []).some(declaration => /[\\/]rxjs[\\/]/.test(declaration.getSourceFile().fileName));
}

/** The first type argument node when `node` spells the wrapper `type` itself (not an alias of it). */
function wrapperArgumentNode(checker: ts.TypeChecker, type: ts.Type, node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (!node || !ts.isTypeReferenceNode(node)) return undefined;
  const named = resolveSymbol(checker, checker.getSymbolAtLocation(node.typeName));
  return named !== undefined && named === type.getSymbol?.() ? node.typeArguments?.[0] : undefined;
}

/**
 * Remove `Promise<T>` and rxjs `Observable<T>` wrappers from a controller
 * return type; Nest sends the resolved or last emitted value. The type
 * argument node is kept only when the syntax spells the same wrapper, so an
 * alias such as `type Page<T> = Promise<T[]>` falls back to the type.
 */
export function unwrapAsyncType(
  checker: ts.TypeChecker,
  type: ts.Type,
  node?: ts.TypeNode,
): { readonly type: ts.Type; readonly node?: ts.TypeNode } {
  let current = type;
  let currentNode = node;
  while (isAsyncWrapper(current)) {
    const argument = checker.getTypeArguments(current as ts.TypeReference)[0];
    if (!argument) break;
    currentNode = wrapperArgumentNode(checker, current, currentNode);
    current = argument;
  }
  return { type: current, ...(currentNode ? { node: currentNode } : {}) };
}

/**
 * Class-like declarations a base type contributes. A mixin base
 * (`extends Timestamped(Base)`) is an intersection of the mixin's class
 * expression and `Base`; the mixin class extends `Base`, so declared classes
 * come before class expressions.
 */
export function baseClassDeclarations(type: ts.Type): readonly ts.ClassLikeDeclaration[] {
  const members = type.isIntersection() ? type.types : [type];
  const declarations = members.flatMap(member => (member.getSymbol()?.declarations ?? []).filter(ts.isClassLike));
  return [...declarations.filter(ts.isClassDeclaration), ...declarations.filter(declaration => !ts.isClassDeclaration(declaration))];
}

/**
 * The controller and its base classes, base first, including bases reached
 * through mixins. Class-level decorator metadata is read along this chain, as
 * `Reflect.getMetadata` walks the constructor prototype chain in Nest.
 */
export function classHierarchyBaseToDerived(
  checker: ts.TypeChecker,
  classDeclaration: ts.ClassLikeDeclaration,
): readonly ts.ClassLikeDeclaration[] {
  const ordered: ts.ClassLikeDeclaration[] = [];
  const visit = (declaration: ts.ClassLikeDeclaration, path: ReadonlySet<ts.ClassLikeDeclaration>): void => {
    if (path.has(declaration) || ordered.includes(declaration)) return;
    const nextPath = new Set(path).add(declaration);
    const classType = checker.getTypeAtLocation(declaration);
    for (const baseType of checker.getBaseTypes(classType as ts.InterfaceType) ?? []) {
      for (const base of baseClassDeclarations(baseType)) visit(base, nextPath);
    }
    ordered.push(declaration);
  };
  visit(classDeclaration, new Set());
  return ordered;
}

export function containsUndefined(type: ts.Type): boolean {
  return type.isUnion() && type.types.some(item => (item.flags & ts.TypeFlags.Undefined) !== 0);
}

export function isPrimitive(type: ts.Type): boolean {
  return (type.flags & (
    ts.TypeFlags.StringLike
    | ts.TypeFlags.NumberLike
    | ts.TypeFlags.BooleanLike
  )) !== 0;
}

function arrayElementType(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  if (checker.isArrayType(type) || checker.isTupleType(type)) return checker.getTypeArguments(type as ts.TypeReference)[0];
  return undefined;
}

export function isFlatParameterType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) {
    const members = type.types.filter(item => (item.flags & ts.TypeFlags.Undefined) === 0);
    return members.length > 0 && members.every(member => isFlatParameterType(checker, member));
  }
  if (type.isIntersection()) {
    const valueMembers = type.types.filter(member => isFlatParameterType(checker, member));
    if (valueMembers.length === type.types.length) return true;
    const metadataMembers = type.types.filter(member => {
      if ((member.flags & ts.TypeFlags.Object) === 0) return false;
      const properties = checker.getPropertiesOfType(member);
      return properties.length > 0 && properties.every(property => /(?:serde|validation|constraint|tag)/i.test(property.name));
    });
    return valueMembers.length > 0 && valueMembers.length + metadataMembers.length === type.types.length;
  }
  const element = arrayElementType(checker, type);
  return isPrimitive(type) || (element !== undefined && isFlatParameterType(checker, element));
}

/** Optional when marked `?`, typed with `undefined`, or given a default value (`limit = 20`). */
export function isOptionalParameter(node: ts.ParameterDeclaration, type: ts.Type): boolean {
  return Boolean(node.questionToken || node.initializer || containsUndefined(type));
}

export function parameterPropertyTypeNode(property: ts.Symbol): ts.TypeNode | undefined {
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  return declaration && (
    ts.isPropertySignature(declaration)
    || ts.isPropertyDeclaration(declaration)
    || ts.isParameter(declaration)
  ) ? declaration.type : undefined;
}

export function parameterProperties(
  context: NestAnalysisContext,
  parameter: ts.ParameterDeclaration,
  type: ts.Type,
): readonly ts.Symbol[] {
  const direct = context.checker.getPropertiesOfType(type);
  // An already generated model contributes erased wire/fields symbol brands
  // to its instance type. Ordinary DTOs should keep their
  // compiler properties and be checked by the portable flattening rules
  // below; consult the source contract only when the generated bookkeeping
  // is present or the companion is absent and no direct properties exist.
  if (direct.length > 0 && !direct.some(property => property.name.startsWith('__@'))) return direct;
  const contracts = context.contractAnalysis;
  if (contracts) {
    const descriptor = contracts.describe(type, parameter, parameter.type);
    if (descriptor.kind === 'reference') {
      const specification = contracts.specFor(descriptor.name);
      if (specification) {
        return context.checker.getPropertiesOfType(specification.fieldsType)
          .filter(property => !property.name.startsWith('__@'));
      }
    }
  }
  return direct;
}

export function isIndexSignatureType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker.getIndexInfosOfType(type).length > 0;
}

function descriptorRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function queryObjectDescriptor(
  context: NestAnalysisContext,
  parameter: ts.ParameterDeclaration,
  type: ts.Type,
): Record<string, unknown> | undefined {
  const contracts = context.contractAnalysis;
  if (!contracts) return undefined;
  const descriptor = contracts.describe(type, parameter, parameter.type);
  if (descriptor.kind === 'reference') return descriptorRecord(contracts.definitions[descriptor.name]);
  return descriptorRecord(descriptor);
}

export function hasWholeObjectContract(
  context: NestAnalysisContext,
  parameter: ts.ParameterDeclaration,
  type: ts.Type,
): boolean {
  const descriptor = queryObjectDescriptor(context, parameter, type);
  if (!descriptor) return false;
  return (
    (Array.isArray(descriptor.constraints) && descriptor.constraints.length > 0)
    || descriptor.serde !== undefined
    || (Array.isArray(descriptor.validations) && descriptor.validations.length > 0)
  );
}
/** Evaluate a route path or version expression with the analysis program's watch observer. */
export function evaluateContextExpression(
  expression: ts.Expression,
  context: NestAnalysisContext,
): Promise<string | string[]> {
  return evaluateRouteExpression(expression, context.program, { onInput: context.onInput });
}

/** Evaluate route paths and versions through the route folder, which reads literals and simple helpers. */
export async function evaluateStringValues(
  expression: ts.Expression | undefined,
  context: NestAnalysisContext,
  defaultValue: readonly string[],
): Promise<readonly string[]> {
  if (!expression) return defaultValue;
  const result = await evaluateContextExpression(unwrapExpression(expression), context);
  return typeof result === 'string' ? [result] : result;
}

export function typeExpressionFromApiOption(
  checker: ts.TypeChecker,
  value: ts.Expression | undefined,
): { readonly type?: TypeReference; readonly isArray?: boolean } {
  if (!value) return {};
  const expression = unwrapExpression(value);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const returnedExpression = singleReturnExpression(expression);
    if (returnedExpression) return typeExpressionFromApiOption(checker, returnedExpression);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    if (expression.elements.length !== 1) return {};
    const type = typeReferenceFromExpression(checker, expression.elements[0]);
    return type ? { type, isArray: true } : {};
  }
  const type = typeReferenceFromExpression(checker, expression);
  return type ? { type } : {};
}
