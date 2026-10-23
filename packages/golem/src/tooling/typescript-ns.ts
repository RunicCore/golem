// The only door to TypeScript: picks the backend for the project's installed TypeScript.
// Add a name to the value list below when golem code starts using it through this seam.
import { selectedTypeScript } from './typescript-selection.js';
import { assertGolemLoadsTypeScript } from './typescript-version.js';
import type * as Golem from './typescript-types.js';

const selected = selectedTypeScript();
if (selected.major === 7) assertGolemLoadsTypeScript(selected);
// The single boundary between TypeScript's own types and golem's: both backend modules are cast here to the
// golem-owned shape in typescript-types.ts, so no published declaration names a TypeScript package.
const backend = (selected.major === 7
  ? await import('./typescript-ts7.js')
  : await import('./typescript-ts6.js')) as unknown as Golem.TypeScriptBackend;

export const typescriptVersion = selected.version;
export const {
  CheckFlags,
  ElementFlags,
  IndexKind,
  ModuleKind,
  ModuleResolutionKind,
  NodeBuilderFlags,
  NodeFlags,
  ObjectFlags,
  ProgramSession,
  ScriptTarget,
  SignatureKind,
  SymbolFlags,
  SyntaxKind,
  TypeFlags,
  canHaveDecorators,
  canHaveModifiers,
  createCompilerHost,
  createProgramFromSources,
  findConfigFile,
  forEachChild,
  formatDiagnosticsWithColorAndContext,
  getDecorators,
  getModifiers,
  getPreEmitDiagnostics,
  isArrayLiteralExpression,
  isArrayTypeNode,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassLike,
  isComputedPropertyName,
  isConditionalTypeNode,
  isDecorator,
  isElementAccessExpression,
  isEmptyStatement,
  isEnumDeclaration,
  isEnumMember,
  isExportAssignment,
  isExportDeclaration,
  isExportSpecifier,
  isExpression,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLike,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isImportTypeNode,
  isIndexSignatureDeclaration,
  isIndexedAccessTypeNode,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isMappedTypeNode,
  isMethodDeclaration,
  isMethodSignature,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamedTupleMember,
  isNamespaceExport,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isOptionalTypeNode,
  isParameter,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignature,
  isQualifiedName,
  isRestTypeNode,
  isReturnStatement,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isStringLiteralLike,
  isTemplateExpression,
  isTemplateLiteralTypeNode,
  isTupleTypeNode,
  isTypeAliasDeclaration,
  isTypeAssertionExpression,
  isTypeLiteralNode,
  isTypeNode,
  isTypeOperatorNode,
  isTypeParameterDeclaration,
  isTypeQueryNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  resolveImport,
  sys,
  typeParameterDefault,
  typeReferenceTarget,
} = backend;

// A value export shadows the type meaning of its name, so enum-like and class names are re-exported as types too.
export type ElementFlags = Golem.ElementFlags;
export type IndexKind = Golem.IndexKind;
export type ModuleKind = Golem.ModuleKind;
export type ModuleResolutionKind = Golem.ModuleResolutionKind;
export type NodeBuilderFlags = Golem.NodeBuilderFlags;
export type NodeFlags = Golem.NodeFlags;
export type ObjectFlags = Golem.ObjectFlags;
export type ProgramSession = Golem.ProgramSession;
export type ScriptTarget = Golem.ScriptTarget;
export type SignatureKind = Golem.SignatureKind;
export type SymbolFlags = Golem.SymbolFlags;
export type SyntaxKind = Golem.SyntaxKind;
export type TypeFlags = Golem.TypeFlags;
export type * from './typescript-types.js';
