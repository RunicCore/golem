// The only door to TypeScript: picks the backend for the project's installed TypeScript.
// Add a name to the value list below when golem code starts using it through this seam.
import { resolveTypeScript } from './typescript-version.js';
import type * as Seven from './typescript-ts7.js';

const selected = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? process.cwd());
// The TypeScript 6 backend implements the same surface as the TypeScript 7 one; this is the only place its module is cast to that shape.
const backend: typeof Seven = selected.major === 7
  ? await import('./typescript-ts7.js')
  : (await import('./typescript-ts6.js')) as unknown as typeof Seven;

export const typescriptVersion = selected.version;
export const {
  API,
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
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLike,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
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
  resolveModuleName,
  sys,
  typeParameterDefault,
  typeReferenceTarget,
} = backend;

// A value export shadows the type meaning of its name, so enum-like and class names are re-exported as types too.
export type API = Seven.API;
export type ElementFlags = Seven.ElementFlags;
export type IndexKind = Seven.IndexKind;
export type ModuleKind = Seven.ModuleKind;
export type ModuleResolutionKind = Seven.ModuleResolutionKind;
export type NodeBuilderFlags = Seven.NodeBuilderFlags;
export type NodeFlags = Seven.NodeFlags;
export type ObjectFlags = Seven.ObjectFlags;
export type ProgramSession = Seven.ProgramSession;
export type ScriptTarget = Seven.ScriptTarget;
export type SignatureKind = Seven.SignatureKind;
export type SymbolFlags = Seven.SymbolFlags;
export type SyntaxKind = Seven.SyntaxKind;
export type TypeFlags = Seven.TypeFlags;
export type * from './typescript-ts7.js';
