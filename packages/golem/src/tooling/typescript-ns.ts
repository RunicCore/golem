// The only door to TypeScript: picks the backend for the project's installed TypeScript.
// Add a name to the value list below when golem code starts using it through this seam.
import { relative } from 'node:path';
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
  JsxEmit,
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
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext,
  getDecorators,
  getLeadingCommentRanges,
  getModifiers,
  getPreEmitDiagnostics,
  getTrailingCommentRanges,
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
  isExpressionStatement,
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
  isModuleBlock,
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
  sys,
  typeParameterDefault,
  typeReferenceTarget,
} = backend;

const ERROR_CATEGORY = 1;
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';

/**
 * The line `tsc --pretty` prints after the diagnostics, and nothing when no diagnostic is an error: `Found 3 errors in 2 files.` and
 * a table of the errors in each file. `tsc` prints no summary in its plain form. The text is the one both compilers print (English).
 * A file prints relative to the host's current directory, followed by the line of its first error.
 */
export function formatErrorSummary(diagnostics: readonly Golem.Diagnostic[], host: { getCurrentDirectory(): string; getNewLine(): string }): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.category === ERROR_CATEGORY);
  if (errors.length === 0) return '';
  const newLine = host.getNewLine();
  const reference = (error: Golem.Diagnostic): string => `${relative(host.getCurrentDirectory(), error.fileName!).split('\\').join('/')}${GREY}:${error.startPosition!.line + 1}${RESET}`;
  const inFiles = errors.filter((error) => error.fileName !== undefined && error.startPosition !== undefined);
  const files = [...new Set(inFiles.map((error) => error.fileName))];
  const first = inFiles[0];
  let headline: string;
  if (errors.length === 1) headline = first === undefined ? 'Found 1 error.' : `Found 1 error in ${reference(first)}`;
  else if (files.length === 0) headline = `Found ${errors.length} errors.`;
  else if (files.length === 1) headline = `Found ${errors.length} errors in the same file, starting at: ${reference(first!)}`;
  else headline = `Found ${errors.length} errors in ${files.length} files.`;
  const table = files.length > 1
    ? ['Errors  Files', ...files.map((file) => {
      const count = inFiles.filter((error) => error.fileName === file).length;
      return `${String(count).padStart(6)}  ${reference(inFiles.find((error) => error.fileName === file)!)}`;
    })].join('\n') + '\n'
    : '';
  return `${newLine}${headline}${newLine}${newLine}${table}`;
}

// A value export shadows the type meaning of its name, so enum-like and class names are re-exported as types too.
export type ElementFlags = Golem.ElementFlags;
export type IndexKind = Golem.IndexKind;
export type JsxEmit = Golem.JsxEmit;
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
