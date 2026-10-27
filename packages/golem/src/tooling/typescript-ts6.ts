/**
 * The TypeScript 6 backend of the seam: golem's analysis runs on the project's classic compiler API.
 *
 * The facade imports this module only for a project whose `typescript` is 6.x. The classic API is already the
 * checker-shaped surface the TypeScript 7 backend builds by hand, so most names are re-exported as they are. This
 * module adds only what the classic objects lack: the `ProgramSession` overlay and input-observation contract, and
 * wrappers that give types, symbols and signatures the members golem reads.
 */
import { channel } from 'node:diagnostics_channel';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, normalize, resolve as resolvePath } from 'node:path';
import { GOLEM_CHANNELS } from './diagnostics-channels.js';
import { displayPath } from './generator-api.js';
import { fileSignature, MISSING } from './input-watcher.js';
import { assertConfigParsed, assertNoSourceFiles, collectTscDiagnostics, configReferences, emitWanted, flagPathOptions, flagsAsConfigOptions, referencedConfigFile } from './typescript-config.js';
import type { ConfigReference, ResolveAtCurrentFolder } from './typescript-config.js';
import { selectedTypeScript } from './typescript-selection.js';
import { inNodeModules } from './type-analysis/path-identity.js';
import { assertPackageManifestsParse } from './type-analysis/package-specifier.js';
import type * as Golem from './typescript-types.js';

// The classic compiler's own objects. This build compiles against TypeScript 7, whose main export carries no classic
// declarations, so the members of the TypeScript 6 API that this backend calls are declared here.
interface ClassicType {
  readonly flags: Golem.TypeFlags;
  readonly objectFlags: Golem.ObjectFlags;
  readonly symbol?: ClassicSymbol;
  readonly aliasSymbol?: ClassicSymbol;
  readonly aliasTypeArguments?: readonly ClassicType[];
  /** Only a union or intersection type has members. */
  readonly types?: readonly ClassicType[];
  /** A type reference's generic target; a tuple target also holds `elementFlags` and `readonly`. */
  readonly target?: ClassicType;
  readonly elementFlags?: readonly Golem.ElementFlags[];
  isUnion(): boolean;
  isIntersection(): boolean;
  isClassOrInterface(): boolean;
}

interface ClassicSymbol {
  readonly flags: Golem.SymbolFlags;
  readonly name: string;
  readonly valueDeclaration?: Golem.Node;
  readonly declarations?: readonly Golem.Node[];
  /** Only a transient symbol carries links, and `checkFlags` lives there. */
  readonly links?: { readonly checkFlags?: number };
}

interface ClassicSignature {
  readonly parameters: readonly ClassicSymbol[];
  readonly declaration?: Golem.Node;
}

interface ClassicIndexInfo {
  readonly keyType: ClassicType;
  readonly type: ClassicType;
}

interface ClassicChecker {
  getTypeFromTypeNode(node: Golem.TypeNode): ClassicType | undefined;
  getTypeAtLocation(node: Golem.Node): ClassicType | undefined;
  getSymbolAtLocation(node: Golem.Node): ClassicSymbol | undefined;
  getAliasedSymbol(symbol: ClassicSymbol): ClassicSymbol;
  getTypeOfSymbolAtLocation(symbol: ClassicSymbol, location: Golem.Node): ClassicType;
  getPropertiesOfType(type: ClassicType): readonly ClassicSymbol[];
  getPropertyOfType(type: ClassicType, name: string): ClassicSymbol | undefined;
  getSignaturesOfType(type: ClassicType, kind: Golem.SignatureKind): readonly ClassicSignature[];
  getReturnTypeOfSignature(signature: ClassicSignature): ClassicType | undefined;
  getTypeArguments(type: ClassicType): readonly ClassicType[];
  isTypeAssignableTo(source: ClassicType, target: ClassicType): boolean;
  isArrayType(type: ClassicType): boolean;
  isTupleType(type: ClassicType): boolean;
  typeToString(type: ClassicType, enclosingDeclaration?: Golem.Node, flags?: number): string;
  typeToTypeNode(type: ClassicType, enclosingDeclaration?: Golem.Node, flags?: number): Golem.TypeNode | undefined;
  getAnyType(): ClassicType;
  getStringType(): ClassicType;
  getNumberType(): ClassicType;
  getBooleanType(): ClassicType;
  getUnknownType(): ClassicType;
  getExportsOfModule(symbol: ClassicSymbol): readonly ClassicSymbol[];
  tryGetMemberInModuleExports(name: string, moduleSymbol: ClassicSymbol): ClassicSymbol | undefined;
  getIndexInfosOfType(type: ClassicType): readonly ClassicIndexInfo[];
  getBaseTypes(type: ClassicType): readonly ClassicType[];
  getDeclaredTypeOfSymbol(symbol: ClassicSymbol): ClassicType;
  getConstantValue(node: Golem.Node): string | number | undefined;
  getSignatureFromDeclaration(node: Golem.Node): ClassicSignature | undefined;
}

interface ClassicProgram {
  getTypeChecker(): ClassicChecker;
  getSourceFile(filename: string): Golem.SourceFile | undefined;
  getSourceFiles(): readonly Golem.SourceFile[];
  isSourceFileFromExternalLibrary(file: Golem.SourceFile): boolean;
  isSourceFileDefaultLibrary(file: Golem.SourceFile): boolean;
  getCompilerOptions(): Golem.CompilerOptions;
  getSyntacticDiagnostics(file?: Golem.SourceFile): readonly ClassicDiagnostic[];
  getSemanticDiagnostics(file?: Golem.SourceFile): readonly ClassicDiagnostic[];
  getConfigFileParsingDiagnostics(): readonly ClassicDiagnostic[];
  getOptionsDiagnostics(): readonly ClassicDiagnostic[];
  getGlobalDiagnostics(): readonly ClassicDiagnostic[];
  getDeclarationDiagnostics(): readonly ClassicDiagnostic[];
  /** Internal to the classic compiler: the project reference that owns a source, with the declaration file its imports read. */
  getRedirectFromSourceFile(fileName: string): { readonly outputDts?: string } | undefined;
  emit(
    targetSourceFile: undefined,
    writeFile: (filename: string, text: string, writeByteOrderMark: boolean, onError: undefined, sourceFiles: readonly Golem.SourceFile[] | undefined) => void,
    cancellationToken: undefined,
    emitOnlyDtsFiles: boolean,
  ): { readonly emitSkipped: boolean; readonly diagnostics: readonly ClassicDiagnostic[] };
  getModeForUsageLocation(file: Golem.SourceFile, usage: Golem.StringLiteralLike): Golem.ModuleKind;
  /** Internal to the classic compiler: the resolution it stored for an import. */
  getResolvedModuleFromModuleSpecifier(specifier: Golem.StringLiteralLike, file: Golem.SourceFile): { readonly resolvedModule?: Golem.ResolvedModule } | undefined;
}

interface ClassicMessageChain {
  readonly messageText: string;
  readonly next?: readonly ClassicMessageChain[];
}

interface ClassicDiagnostic {
  readonly file?: Golem.SourceFile;
  readonly start?: number;
  readonly code: number;
  readonly category: number;
  readonly messageText: string | ClassicMessageChain;
}

type LanguageVersionOrOptions = number | {
  readonly languageVersion: number;
  readonly impliedNodeFormat?: number;
  readonly jsDocParsingMode?: number;
};

/** A project reference of the classic compiler: `path` is absolute and names a folder or a tsconfig file. */
interface ClassicProjectReference {
  readonly path: string;
  readonly originalPath?: string;
  readonly circular?: boolean;
}

interface ClassicHost extends Golem.CompilerHost {
  directoryExists?(directory: string): boolean;
  getCurrentDirectory(): string;
  getSourceFile(
    filename: string,
    languageVersionOrOptions: LanguageVersionOrOptions,
    onError?: (message: string) => void,
    shouldCreateNewSourceFile?: boolean,
  ): Golem.SourceFile | undefined;
}

interface ClassicSystem extends Golem.ModuleResolutionHost {
  readonly useCaseSensitiveFileNames: boolean;
  directoryExists(directory: string): boolean;
  readDirectory(root: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[];
}

interface ParsedConfigHost {
  readonly useCaseSensitiveFileNames: boolean;
  readDirectory: ClassicSystem['readDirectory'];
  fileExists(filename: string): boolean;
  readFile(filename: string): string | undefined;
  getCurrentDirectory(): string;
  onUnRecoverableConfigFileDiagnostic(diagnostic: ClassicDiagnostic): void;
}

// Names that this module implements itself; every other seam name is the classic API's own member.
type Implemented = 'ProgramSession' | 'CheckFlags' | 'sys' | 'createCompilerHost' | 'createProgramFromSources' | 'createScanner'
  | 'getPreEmitDiagnostics' | 'getTscDiagnostics' | 'typeParameterDefault' | 'typeReferenceTarget';

interface ClassicTypeScript extends Omit<Golem.TypeScriptBackend, Implemented | 'ObjectFlags' | 'SignatureKind'> {
  readonly SignatureKind: Golem.TypeScriptBackend['SignatureKind'] & { readonly Construct: Golem.SignatureKind };
  readonly ObjectFlags: Golem.TypeScriptBackend['ObjectFlags'] & {
    readonly Reference: Golem.ObjectFlags;
    readonly ClassOrInterface: Golem.ObjectFlags;
  };
  readonly sys: ClassicSystem;
  readonly LanguageVariant: { readonly Standard: number };
  createScanner(languageVersion: Golem.ScriptTarget, skipTrivia: boolean, languageVariant: number, text: string, onError?: undefined, start?: number, length?: number): Golem.Scanner;
  createCompilerHost(options?: Golem.CompilerOptions, setParentNodes?: boolean): ClassicHost;
  createProgram(init: {
    readonly rootNames: readonly string[];
    readonly options: Golem.CompilerOptions;
    readonly host: ClassicHost;
    readonly projectReferences?: readonly ClassicProjectReference[];
    readonly oldProgram?: ClassicProgram;
  }): ClassicProgram;
  createSourceFile(filename: string, text: string, languageVersionOrOptions: LanguageVersionOrOptions, setParentNodes?: boolean): Golem.SourceFile;
  transpileModule(text: string, options: { readonly fileName: string; readonly compilerOptions: Golem.CompilerOptions; readonly reportDiagnostics: boolean }): { readonly outputText: string; readonly sourceMapText?: string; readonly diagnostics?: readonly ClassicDiagnostic[] };
  getParsedCommandLineOfConfigFile(
    configFilename: string,
    optionsToExtend: Golem.CompilerOptions | undefined,
    host: ParsedConfigHost,
  ): { readonly options: Golem.CompilerOptions; readonly fileNames: string[]; readonly projectReferences?: readonly ClassicProjectReference[]; readonly errors: readonly ClassicDiagnostic[] } | undefined;
  readConfigFile(configFilename: string, readFile: (filename: string) => string | undefined): { readonly config?: unknown };
  getPreEmitDiagnostics(program: ClassicProgram): readonly ClassicDiagnostic[];
  parseJsonConfigFileContent(json: object, host: Pick<ParsedConfigHost, 'useCaseSensitiveFileNames' | 'readDirectory' | 'fileExists' | 'readFile'>, basePath: string): { readonly options: Golem.CompilerOptions };
  parseCommandLine(flags: readonly string[]): { readonly options: Golem.CompilerOptions; readonly fileNames: readonly string[]; readonly errors: readonly ClassicDiagnostic[] };
  sortAndDeduplicateDiagnostics(diagnostics: readonly ClassicDiagnostic[]): readonly ClassicDiagnostic[];
  resolveModuleName(
    moduleName: string,
    containingFile: string,
    compilerOptions: Golem.CompilerOptions,
    host: Golem.ModuleResolutionHost,
    cache?: undefined,
    redirectedReference?: undefined,
    resolutionMode?: Golem.ModuleKind,
  ): { resolvedModule?: Golem.ResolvedModule };
  flattenDiagnosticMessageText(message: string | ClassicMessageChain | undefined, newLine: string): string;
}

const selected = selectedTypeScript();
// Load the project's TypeScript by the directory the version check found; a bare `typescript` import would load golem's own.
const require = createRequire(import.meta.url);
const classic = require(selected.packageDir) as ClassicTypeScript;

export const {
  ElementFlags,
  IndexKind,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  NodeBuilderFlags,
  NodeFlags,
  ObjectFlags,
  ScriptTarget,
  SignatureKind,
  SymbolFlags,
  SyntaxKind,
  TypeFlags,
  canHaveDecorators,
  canHaveModifiers,
  createCompilerHost,
  findConfigFile,
  forEachChild,
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext,
  getDecorators,
  getLeadingCommentRanges,
  getModifiers,
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
} = classic;

/** TypeScript 7 names a type parameter's default `defaultType`; TypeScript 6 names it `default`. */
export function typeParameterDefault(parameter: Golem.TypeParameterDeclaration): Golem.TypeNode | undefined {
  // TypeScript 6's TypeParameterDeclaration declares `default`, which golem's own declaration omits.
  return (parameter as Golem.TypeParameterDeclaration & { readonly default?: Golem.TypeNode }).default;
}

/** The generic target of a type reference (e.g. the tuple target of a tuple type). */
export function typeReferenceTarget(type: Golem.Type): Golem.Type | undefined {
  // The wrapper's `target` is the wrapped generic target; golem's Type declaration omits it.
  return (type as Golem.Type & { readonly target?: Golem.Type }).target;
}

/** The classic scanner takes the language version first and the text after the variant. */
export function createScanner(skipTrivia: boolean, text: string, start?: number, length?: number): Golem.Scanner {
  return classic.createScanner(classic.ScriptTarget.ES2022, skipTrivia, classic.LanguageVariant.Standard, text, undefined, start, length);
}

/** Checker-internal `CheckFlags` bits (verified against TypeScript 6.0: Readonly = 8, Mapped = 262144). */
export const CheckFlags = { Readonly: 1 << 3, Mapped: 1 << 18 } as const;

// Types, symbols and signatures: one wrapper per classic object, so identity-keyed maps and sets in golem keep working.
const types = new WeakMap<object, Golem.Type>();
const symbols = new WeakMap<object, Golem.Symbol>();
const signatures = new WeakMap<object, Golem.Signature>();
const originalTypes = new WeakMap<object, ClassicType>();
const originalSymbols = new WeakMap<object, ClassicSymbol>();
const originalSignatures = new WeakMap<object, ClassicSignature>();

function unwrapType(type: Golem.Type): ClassicType {
  // An unwrapped type is already the classic object; golem's declaration hides its classic members.
  return originalTypes.get(type) ?? (type as unknown as ClassicType);
}

function unwrapSymbol(symbol: Golem.Symbol): ClassicSymbol {
  // An unwrapped symbol is already the classic object; golem's declaration hides its classic members.
  return originalSymbols.get(symbol) ?? (symbol as unknown as ClassicSymbol);
}

function unwrapSignature(signature: Golem.Signature): ClassicSignature {
  // An unwrapped signature is already the classic object; golem's declaration hides its classic members.
  return originalSignatures.get(signature) ?? (signature as unknown as ClassicSignature);
}

/** A property read that leaves the classic object as `this`, so the compiler never sees a wrapper. */
function passthrough(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  // A function member is called with the classic object as `this`; its parameters are not known here.
  return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
}

function isTypeReferenceType(type: ClassicType): boolean {
  return (type.flags & TypeFlags.Object) !== 0 && (type.objectFlags & ObjectFlags.Reference) !== 0;
}

function wrapType(type: ClassicType | undefined, checker: CompatChecker): Golem.Type {
  if (!type) throw new Error('TypeScript checker returned no type.');
  const cached = types.get(type);
  if (cached) return cached;
  const proxy = new Proxy(type, {
    get(target, property) {
      switch (property) {
        case 'types': return (target.isUnion() || target.isIntersection() ? target.types ?? [] : []).map((member) => wrapType(member, checker));
        case 'aliasSymbol': return target.aliasSymbol && wrapSymbol(target.aliasSymbol);
        case 'symbol': return target.symbol && wrapSymbol(target.symbol);
        case 'aliasTypeArguments': return (target.aliasTypeArguments ?? []).map((argument) => wrapType(argument, checker));
        case 'target': return isTypeReferenceType(target) && target.target ? wrapType(target.target, checker) : undefined;
        case 'elementFlags': return (target.target ?? target).elementFlags ?? [];
        case 'getSymbol': return () => target.symbol && wrapSymbol(target.symbol);
        case 'getCallSignatures': return () => checker.getSignaturesOfType(wrapType(target, checker), SignatureKind.Call);
        case 'getConstructSignatures': return () => checker.getSignaturesOfType(wrapType(target, checker), SignatureKind.Construct);
        case 'getProperty': return (name: string) => checker.getPropertyOfType(wrapType(target, checker), name);
        default: return passthrough(target, property);
      }
    },
  }) as unknown as Golem.Type; // The proxy presents the classic type as golem's own Type declaration.
  types.set(type, proxy);
  originalTypes.set(proxy, type);
  return proxy;
}

function wrapSymbol(symbol: ClassicSymbol): Golem.Symbol {
  const cached = symbols.get(symbol);
  if (cached) return cached;
  const proxy = new Proxy(symbol, {
    get(target, property) {
      switch (property) {
        case 'checkFlags': return (target.flags & SymbolFlags.Transient) !== 0 ? target.links?.checkFlags ?? 0 : 0;
        case 'getName': return () => target.name;
        case 'declarations': return target.declarations ?? [];
        default: return passthrough(target, property);
      }
    },
  }) as unknown as Golem.Symbol; // The proxy presents the classic symbol as golem's own Symbol declaration.
  symbols.set(symbol, proxy);
  originalSymbols.set(proxy, symbol);
  return proxy;
}

function wrapSignature(signature: ClassicSignature, checker: CompatChecker): Golem.Signature {
  const cached = signatures.get(signature);
  if (cached) return cached;
  const proxy = new Proxy(signature, {
    get(target, property) {
      switch (property) {
        case 'parameters': return target.parameters.map((parameter) => wrapSymbol(parameter));
        case 'getReturnType': return () => checker.getReturnTypeOfSignature(wrapSignature(target, checker));
        default: return passthrough(target, property);
      }
    },
  }) as unknown as Golem.Signature; // The proxy presents the classic signature as golem's own Signature declaration.
  signatures.set(signature, proxy);
  originalSignatures.set(proxy, signature);
  return proxy;
}

/** The classic checker behind the checker declaration golem reads, with the TypeScript 7 backend's fallbacks. */
class CompatChecker implements Golem.TypeChecker {
  public constructor(private readonly inner: ClassicChecker, private readonly program: CompatProgram) {}

  resolveImport(specifier: Golem.StringLiteralLike, virtualFiles?: ReadonlySet<string>): Golem.ResolvedModule | undefined {
    return this.program.resolveImport(specifier, virtualFiles);
  }

  getTypeFromTypeNode(node: Golem.TypeNode): Golem.Type {
    return wrapType(this.inner.getTypeFromTypeNode(node) ?? this.inner.getUnknownType(), this);
  }

  getTypeAtLocation(node: Golem.Node): Golem.Type {
    return wrapType(this.inner.getTypeAtLocation(node) ?? this.inner.getUnknownType(), this);
  }

  getSymbolAtLocation(node: Golem.Node): Golem.Symbol | undefined {
    const symbol = this.inner.getSymbolAtLocation(node);
    return symbol && wrapSymbol(symbol);
  }

  getAliasedSymbol(symbol: Golem.Symbol): Golem.Symbol {
    return wrapSymbol(this.inner.getAliasedSymbol(unwrapSymbol(symbol)));
  }

  getTypeOfSymbolAtLocation(symbol: Golem.Symbol, location: Golem.Node): Golem.Type {
    return wrapType(this.inner.getTypeOfSymbolAtLocation(unwrapSymbol(symbol), location), this);
  }

  getPropertiesOfType(type: Golem.Type): readonly Golem.Symbol[] {
    return this.inner.getPropertiesOfType(unwrapType(type)).map((symbol) => wrapSymbol(symbol));
  }

  getPropertyOfType(type: Golem.Type, name: string): Golem.Symbol | undefined {
    const symbol = this.inner.getPropertyOfType(unwrapType(type), name);
    return symbol && wrapSymbol(symbol);
  }

  getSignaturesOfType(type: Golem.Type, kind: Golem.SignatureKind): readonly Golem.Signature[] {
    return this.inner.getSignaturesOfType(unwrapType(type), kind).map((signature) => wrapSignature(signature, this));
  }

  getReturnTypeOfSignature(signature: Golem.Signature): Golem.Type {
    return wrapType(this.inner.getReturnTypeOfSignature(unwrapSignature(signature)) ?? this.inner.getUnknownType(), this);
  }

  getTypeArguments(type: Golem.Type): readonly Golem.Type[] {
    const inner = unwrapType(type);
    if (!isTypeReferenceType(inner)) return [];
    return this.inner.getTypeArguments(inner).map((argument) => wrapType(argument, this));
  }

  isTypeAssignableTo(source: Golem.Type, target: Golem.Type): boolean {
    return this.inner.isTypeAssignableTo(unwrapType(source), unwrapType(target));
  }

  isArrayType(type: Golem.Type): boolean {
    return this.inner.isArrayType(unwrapType(type));
  }

  isTupleType(type: Golem.Type): boolean {
    return this.inner.isTupleType(unwrapType(type));
  }

  typeToString(type: Golem.Type, enclosingDeclaration?: Golem.Node, flags?: number): string {
    return this.inner.typeToString(unwrapType(type), enclosingDeclaration, flags);
  }

  typeToTypeNode(type: Golem.Type, enclosingDeclaration?: Golem.Node, flags?: number): Golem.TypeNode | undefined {
    return this.inner.typeToTypeNode(unwrapType(type), enclosingDeclaration, flags);
  }

  getAnyType(): Golem.Type {
    return wrapType(this.inner.getAnyType(), this);
  }

  getStringType(): Golem.Type {
    return wrapType(this.inner.getStringType(), this);
  }

  getNumberType(): Golem.Type {
    return wrapType(this.inner.getNumberType(), this);
  }

  getBooleanType(): Golem.Type {
    return wrapType(this.inner.getBooleanType(), this);
  }

  getUnknownType(): Golem.Type {
    return wrapType(this.inner.getUnknownType(), this);
  }

  getExportsOfModule(symbol: Golem.Symbol): readonly Golem.Symbol[] {
    return this.inner.getExportsOfModule(unwrapSymbol(symbol)).map((item) => wrapSymbol(item));
  }

  tryGetMemberInModuleExports(name: string, moduleSymbol: Golem.Symbol): Golem.Symbol | undefined {
    const symbol = this.inner.tryGetMemberInModuleExports(name, unwrapSymbol(moduleSymbol));
    return symbol && wrapSymbol(symbol);
  }

  getRootSymbols(symbol: Golem.Symbol): readonly Golem.Symbol[] {
    // The TypeScript 7 backend returns the symbol itself (typescript-ts7.ts), so output matches across compilers.
    return [symbol];
  }

  getIndexTypeOfType(type: Golem.Type, kind: Golem.IndexKind): Golem.Type | undefined {
    const infos = this.inner.getIndexInfosOfType(unwrapType(type));
    const key = kind === IndexKind.String ? this.inner.getStringType() : this.inner.getNumberType();
    const match = infos.find((info) => this.inner.isTypeAssignableTo(key, info.keyType) || this.inner.isTypeAssignableTo(info.keyType, key));
    return match && wrapType(match.type, this);
  }

  getIndexInfosOfType(type: Golem.Type): readonly { readonly keyType: Golem.Type; readonly valueType: Golem.Type }[] {
    return this.inner.getIndexInfosOfType(unwrapType(type)).map((info) => ({
      keyType: wrapType(info.keyType, this),
      valueType: wrapType(info.type, this),
    }));
  }

  getBaseTypes(type: Golem.Type): readonly Golem.Type[] {
    const inner = unwrapType(type);
    if (!inner.isClassOrInterface()) return [];
    return this.inner.getBaseTypes(inner).map((base) => wrapType(base, this));
  }

  getDeclaredTypeOfSymbol(symbol: Golem.Symbol): Golem.Type {
    return wrapType(this.inner.getDeclaredTypeOfSymbol(unwrapSymbol(symbol)), this);
  }

  getConstantValue(node: Golem.Node): string | number | undefined {
    return this.inner.getConstantValue(node);
  }

  getSignatureFromDeclaration(node: Golem.Node): Golem.Signature | undefined {
    const signature = this.inner.getSignatureFromDeclaration(node);
    return signature && wrapSignature(signature, this);
  }
}

class CompatProgram implements Golem.Program {
  private checker: CompatChecker | undefined;
  private closed = false;

  public constructor(
    readonly session: ProgramSession,
    readonly program: ClassicProgram,
  ) {}

  /**
   * The module an import of a file of this program resolved to, as the compiler resolved it for the program. The classic compiler reads
   * a package.json that is not JSON as `{}`; golem names the file instead. When the compiler found none, `virtualFiles` are files that
   * do not exist yet but will, and a second lookup counts them.
   */
  resolveImport(specifier: Golem.StringLiteralLike, virtualFiles?: ReadonlySet<string>): Golem.ResolvedModule | undefined {
    const file = specifier.getSourceFile();
    assertPackageManifestsParse(specifier.text, file.fileName);
    this.requireStoredResolution();
    const resolved = this.program.getResolvedModuleFromModuleSpecifier(specifier, file)?.resolvedModule;
    if (resolved || !virtualFiles || virtualFiles.size === 0) return resolved;
    return this.session.resolveModuleName(specifier.text, file.fileName, this.getCompilerOptions(), this.program.getModeForUsageLocation(file, specifier), virtualFiles).resolvedModule;
  }

  /** The lookup the program stored for an import is internal to the classic compiler: stop with a clear error if a release drops it. */
  private requireStoredResolution(): void {
    if (typeof this.program.getResolvedModuleFromModuleSpecifier !== 'function') {
      throw new Error(`TypeScript ${selected.version} gives golem no way to read how a program resolved an import: its program has no getResolvedModuleFromModuleSpecifier.`);
    }
  }

  getTypeChecker(): Golem.TypeChecker {
    // Creating the classic checker binds every file, so it waits for the first use.
    this.checker ??= new CompatChecker(this.program.getTypeChecker(), this);
    return this.checker;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.release(this);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  getSourceFile(filename: string): Golem.SourceFile | undefined {
    return this.program.getSourceFile(filename);
  }

  getSourceFiles(): readonly Golem.SourceFile[] {
    return this.program.getSourceFiles();
  }

  isSourceFileFromExternalLibrary(file: Golem.SourceFile): boolean {
    return this.program.isSourceFileFromExternalLibrary(file);
  }

  isSourceFileDefaultLibrary(file: Golem.SourceFile): boolean {
    return this.program.isSourceFileDefaultLibrary(file);
  }

  getCompilerOptions(): Golem.CompilerOptions {
    return this.program.getCompilerOptions();
  }

  getSyntacticDiagnostics(filename: string): readonly Golem.Diagnostic[] {
    const file = this.program.getSourceFile(filename);
    return file ? this.program.getSyntacticDiagnostics(file).map(withText) : [];
  }

  getSemanticDiagnostics(filename: string): readonly Golem.Diagnostic[] {
    const file = this.program.getSourceFile(filename);
    return file ? this.program.getSemanticDiagnostics(file).map(withText) : [];
  }

  /**
   * The compiler redirects an import of a source of a referenced project to that project's declaration output. When the program holds no file
   * for that output, the source is one an import reached without a declaration output. The compiler's own redirect and resolution say so, not its message.
   */
  unbuiltReferences(): readonly string[] {
    // The imports of a source and the project redirect are internal to the classic compiler too: stop with a clear error if a release drops one.
    this.requireStoredResolution();
    if (typeof this.program.getRedirectFromSourceFile !== 'function') throw new Error(`TypeScript ${selected.version} lacks getRedirectFromSourceFile; golem build needs it for project references.`);
    const unbuilt = new Set<string>();
    for (const file of this.program.getSourceFiles()) {
      if (file.isDeclarationFile) continue;
      const imports = (file as { readonly imports?: readonly Golem.StringLiteralLike[] }).imports;
      if (imports === undefined) throw new Error(`TypeScript ${selected.version} lacks SourceFile.imports; golem build needs it for project references.`);
      for (const specifier of imports) {
        const source = this.program.getResolvedModuleFromModuleSpecifier(specifier, file)?.resolvedModule?.resolvedFileName;
        const output = source === undefined ? undefined : this.program.getRedirectFromSourceFile(source)?.outputDts;
        if (source !== undefined && output !== undefined && this.program.getSourceFile(output) === undefined) unbuilt.add(source);
      }
    }
    return [...unbuilt];
  }

  /**
   * The classic emit with a collecting `writeFile`: it writes nothing. A declaration output is told from JavaScript by its name. The
   * source of an output is the one file `writeFile` gets for it; the files are the compiler's transformed copies, so the name is used.
   */
  emitToMemory(kind: Golem.EmitKind): Golem.MemoryEmit {
    const options = this.getCompilerOptions();
    const declarations = kind === 'declarations';
    const files = new Map<string, string>();
    const sources = new Map<string, string>();
    if (!emitWanted(options, declarations)) return { emitSkipped: true, files, sources, diagnostics: [] };
    const result = this.program.emit(undefined, (filename, text, _writeByteOrderMark, _onError, sourceFiles) => {
      if (DECLARATION_OUTPUT.test(filename) !== declarations) return;
      files.set(canonical(filename), text);
      if (sourceFiles?.length === 1) sources.set(canonical(filename), canonical(sourceFiles[0]!.fileName));
    }, undefined, declarations);
    return { emitSkipped: result.emitSkipped, files, sources, diagnostics: result.diagnostics.map(withText) };
  }
}

/** A declaration file or its map, such as `a.d.ts`, `a.d.mts.map` or `a.d.css.ts`. */
const DECLARATION_OUTPUT = /\.d\.(?:[^./\\]+\.)?[cm]?ts(?:\.map)?$/;

function canonical(filename: string): string {
  return normalize(resolvePath(filename));
}

function parseFlags(flags: readonly string[]) {
  const { options: parsed, fileNames, errors } = classic.parseCommandLine(flags);
  return { options: parsed, fileNames, errors: errors.map((diagnostic) => ({ code: diagnostic.code, text: classic.flattenDiagnosticMessageText(diagnostic.messageText, '\n') })) };
}

/** The options read as a tsconfig of the current folder: the classic parse makes the path options absolute from it. No file is listed or read. */
const resolveAtCurrentFolder: ResolveAtCurrentFolder = (options) => classic.parseJsonConfigFileContent(
  { compilerOptions: options, files: [] },
  { useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames, readDirectory: () => [], fileExists: () => false, readFile: () => undefined },
  process.cwd(),
).options as Readonly<Record<string, unknown>>;

export function createProgramFromSources(options: Golem.OpenProgramOptions): Golem.Program {
  return new ProgramSession({ cwd: options.root, closeWhenIdle: true }).openProgram(options);
}

// Diagnostics: the classic diagnostic gains the `text` golem reads, through a wrapper that keeps the original as its prototype.
function headText(message: string | ClassicMessageChain): string {
  return typeof message === 'string' ? message : message.messageText;
}

function chainTexts(message: string | ClassicMessageChain, depth: number): string[] {
  if (typeof message === 'string') return [];
  return (message.next ?? []).flatMap((next) => [`${'  '.repeat(depth)}${next.messageText}`, ...chainTexts(next, depth + 1)]);
}

/** The classic compiler's diagnostics for the program, each reading `text` as the head message. */
export function getPreEmitDiagnostics(program: Golem.Program): readonly Golem.Diagnostic[] {
  if (!(program instanceof CompatProgram)) throw new TypeError('getPreEmitDiagnostics needs a program opened by the TypeScript 6 backend.');
  return classic.getPreEmitDiagnostics(program.program).map(withText);
}

/**
 * The diagnostics of `tsc`'s own report, in its steps: the configuration's, then the syntax errors alone when there are any, else the
 * options', the global and the semantic ones, then the declaration ones under `noEmit` (an emit reports its own); sorted without repeats.
 */
export function getTscDiagnostics(program: Golem.Program, emitDiagnostics: readonly Golem.Diagnostic[] = []): readonly Golem.Diagnostic[] {
  if (!(program instanceof CompatProgram)) throw new TypeError('getTscDiagnostics needs a program opened by the TypeScript 6 backend.');
  const classicProgram = program.program;
  const found = collectTscDiagnostics<ClassicDiagnostic>({
    config: () => classicProgram.getConfigFileParsingDiagnostics(),
    syntactic: () => classicProgram.getSyntacticDiagnostics(),
    options: () => classicProgram.getOptionsDiagnostics(),
    global: () => classicProgram.getGlobalDiagnostics(),
    semantic: () => classicProgram.getSemanticDiagnostics(),
    declaration: () => classicProgram.getDeclarationDiagnostics(),
  }, classicProgram.getCompilerOptions());
  return classic.sortAndDeduplicateDiagnostics([...found, ...emitDiagnostics as readonly ClassicDiagnostic[]]).map(withText);
}

// Object.create returns `any`; the result is the classic diagnostic with `text` added.
function withText(diagnostic: ClassicDiagnostic): Golem.Diagnostic & ClassicDiagnostic {
  const { file, start } = diagnostic;
  return Object.create(diagnostic, {
    text: { value: headText(diagnostic.messageText), enumerable: true },
    pos: { value: start, enumerable: true },
    fileName: { value: file?.fileName, enumerable: true },
    startPosition: { value: file && start !== undefined ? file.getLineAndCharacterOfPosition(start) : undefined, enumerable: true },
  }) as Golem.Diagnostic & ClassicDiagnostic;
}

/** A change to a package manifest or an installed package invalidates cached module resolution. */
function affectsResolution(filename: string): boolean {
  return basename(filename) === 'package.json' || inNodeModules(filename);
}

function languageVersionKey(languageVersionOrOptions: LanguageVersionOrOptions): string {
  if (typeof languageVersionOrOptions === 'number') return String(languageVersionOrOptions);
  const { languageVersion, impliedNodeFormat, jsDocParsingMode } = languageVersionOrOptions;
  return `${languageVersion}:${impliedNodeFormat}:${jsDocParsingMode}`;
}

interface ParsedConfig {
  readonly options: Golem.CompilerOptions;
  readonly fileNames: string[];
  readonly projectReferences: readonly ClassicProjectReference[];
}

/** The seam's view of a parse: each referenced project by its tsconfig file. */
function projectOf(parsed: ParsedConfig): Golem.ParsedProject {
  return { options: parsed.options, fileNames: parsed.fileNames, projectReferences: parsed.projectReferences.map((reference) => ({ path: referencedConfigFile(reference.path) })) };
}

interface ProgramRequest {
  readonly configPath: string;
  readonly overlays: ReadonlyMap<string, string>;
  /** Configuration paths the observer is not told about: virtual configurations are derived input. */
  readonly hidden: ReadonlySet<string>;
  readonly rootNames: readonly string[];
}

function programRequest(options: Golem.OpenProgramOptions, referencesOf: (configPath: string, overlays: ReadonlyMap<string, string>) => readonly ConfigReference[]): ProgramRequest {
  const overlays = new Map([...options.overlays ?? []].map(([filename, content]) => [canonical(filename), content]));
  const baseConfigPath = canonical(options.configFile === undefined
    ? join(options.root, 'tsconfig.json')
    : isAbsolute(options.configFile) ? options.configFile : join(options.root, options.configFile));
  const hidden = new Set<string>();
  if (options.configFile !== undefined && overlays.has(baseConfigPath)) hidden.add(baseConfigPath);
  if (!overlays.has(baseConfigPath) && !sys.fileExists(baseConfigPath)) {
    overlays.set(baseConfigPath, JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['**/*.ts'],
    }));
  }
  let configPath = baseConfigPath;
  if (options.compilerOptionOverrides !== undefined) {
    // A virtual configuration that extends the original replaces the options for this program only. It sits beside the original, so the
    // references, which an extending configuration does not inherit, keep their meaning when copied.
    configPath = join(dirname(baseConfigPath), `${basename(baseConfigPath, '.json')}.options.json`);
    const references = referencesOf(baseConfigPath, overlays);
    overlays.set(configPath, JSON.stringify({ extends: `./${basename(baseConfigPath)}`, compilerOptions: options.compilerOptionOverrides, ...(references.length === 0 ? {} : { references }) }));
    hidden.add(configPath);
  }
  return { configPath, overlays, hidden, rootNames: [...new Set(options.sources.map(canonical))] };
}

interface CachedSourceFile {
  /** The compiler options and language version the file was parsed for. */
  readonly key: string;
  /** The overlay text or the disk signature the file was parsed from. */
  readonly stamp: string;
  readonly sourceFile: Golem.SourceFile;
}

// Internal notices for golem's own tests (`node:diagnostics_channel`, names in diagnostics-channels.ts), with no promise of stability; nothing is built unless a subscriber exists.
const programOpenedChannel = channel(GOLEM_CHANNELS.programOpened);
const inputsChangedChannel = channel(GOLEM_CHANNELS.inputsChanged);
const sessionDisposedChannel = channel(GOLEM_CHANNELS.sessionDisposed);

/**
 * The programs of a generation run or watch session, sharing one cache of parsed files.
 *
 * The classic compiler runs in this process and parses a file again on every program, so the session keeps each
 * parsed `SourceFile` and hands it back while its overlay text or disk signature is unchanged. A later program is
 * created from the previous one so the compiler reuses what it can, unless a file the compiler probed appeared or
 * vanished, a package manifest changed, or the overlay set differs. Every path the compiler read or probed is
 * reported to the program's input observer, replayed from the record because a reused program does not probe again.
 */
export class ProgramSession implements Disposable {
  private disposed = false;
  private observer: ((filename: string) => void) | undefined;
  private hidden: ReadonlySet<string> = new Set();
  private readonly observed = new Set<string>();
  /** The signature of each disk path the compiler read or probed, as it was when last seen. */
  private readonly seen = new Map<string, string>();
  private readonly files = new Map<string, CachedSourceFile>();
  /** Inputs a host saw change since the previous program. */
  private readonly hinted = new Set<string>();
  private readonly held = new Set<CompatProgram>();
  private latest: { readonly program: ClassicProgram; readonly overlayPaths: string } | undefined;

  public constructor(private readonly options: Golem.ProgramSessionOptions) {}

  /** Report inputs a host observed changing; their parsed files are parsed again. */
  inputsChanged(filenames: Iterable<string>): void {
    const names = [...filenames];
    if (inputsChangedChannel.hasSubscribers) inputsChangedChannel.publish({ session: this, filenames: names });
    for (const filename of names) {
      const path = canonical(filename);
      this.hinted.add(path);
      this.files.delete(path);
    }
  }

  /** Parse a project configuration with the session compiler. */
  parseConfigFile(configPath: string, onInput?: (filename: string) => void): Golem.ParsedProject {
    this.assertOpen();
    this.observe(onInput, new Set());
    return projectOf(this.parseConfig(configPath, new Map()));
  }

  /** Parse a project configuration under compiler command-line arguments, as the classic `tsc -p` does. */
  parseConfigFileWithFlags(configPath: string, flags: readonly string[], onInput?: (filename: string) => void): Golem.ParsedProject {
    this.assertOpen();
    this.observe(onInput, new Set());
    const commandLine = classic.parseCommandLine(flags);
    assertNoSourceFiles(commandLine.fileNames);
    // A path in a flag is read from the current folder, as `tsc` reads it; the session works from the tsconfig's folder.
    const paths = flagPathOptions(flags, parseFlags, resolveAtCurrentFolder);
    return projectOf(this.parseConfig(configPath, new Map(), { ...commandLine, options: { ...commandLine.options, ...paths } }));
  }

  /** Open a program that reflects every file change since the previous one. */
  openProgram(options: Golem.OpenProgramOptions): Golem.Program {
    if (programOpenedChannel.hasSubscribers) programOpenedChannel.publish({ session: this, configFile: options.configFile });
    this.assertOpen();
    const request = programRequest(this.withFlags(options), (configPath, overlays) => this.configReferencesOf(configPath, overlays));
    this.observe(options.onInput, request.hidden);
    const resolutionsChanged = this.resolutionsChanged();
    for (const filename of [...this.observed]) this.report(filename);
    const parsed = this.parseConfig(request.configPath, request.overlays);
    const overlayPaths = [...request.overlays.keys()].sort().join('\0');
    const reusable = this.latest !== undefined && this.latest.overlayPaths === overlayPaths && !resolutionsChanged;
    const program = classic.createProgram({
      rootNames: [...new Set([...parsed.fileNames.map(canonical), ...request.rootNames])],
      options: parsed.options,
      host: this.host(parsed.options, request.overlays),
      ...(parsed.projectReferences.length === 0 ? {} : { projectReferences: parsed.projectReferences }),
      ...(reusable && this.latest ? { oldProgram: this.latest.program } : {}),
    });
    this.latest = { program, overlayPaths };
    const held = new CompatProgram(this, program);
    this.held.add(held);
    this.retainFilesOf(held);
    return held;
  }

  /** The options of a program with its command-line `flags` among its option overrides, which win over the flags. */
  private withFlags(options: Golem.OpenProgramOptions): Golem.OpenProgramOptions {
    if (options.flags === undefined || options.flags.length === 0) return options;
    return { ...options, compilerOptionOverrides: { ...flagsAsConfigOptions(options.flags, parseFlags, resolveAtCurrentFolder), ...options.compilerOptionOverrides } };
  }

  /** Parse one source text on its own, without a program. */
  parseSourceFile(filename: string, text: string): Golem.SourceFile {
    this.assertOpen();
    return classic.createSourceFile(filename, text, classic.ScriptTarget.ES2022);
  }

  /** Compile one source text on its own, with the classic compiler's single-file transpile. */
  transpileModule(filename: string, text: string, compilerOptions: Golem.CompilerOptions): { readonly outputText: string; readonly sourceMapText: string; readonly diagnostics: readonly Golem.Diagnostic[] } {
    this.assertOpen();
    const { outputText, sourceMapText, diagnostics = [] } = classic.transpileModule(text, { fileName: filename, compilerOptions, reportDiagnostics: true });
    if (sourceMapText === undefined) throw new Error(`The TypeScript compiler returned no source map for ${displayPath(filename)}`);
    return { outputText, sourceMapText, diagnostics: diagnostics.map(withText) };
  }

  /**
   * Resolve a module name that no program imports, such as one an SDK manifest names. The lookup sees the disk and `virtualFiles`, the
   * same files as on the TypeScript 7 lane. The classic resolver takes the mode after its cache and redirect arguments.
   */
  resolveModuleName(moduleName: string, containingFile: string, compilerOptions: Golem.CompilerOptions, resolutionMode?: Golem.ModuleKind, virtualFiles: ReadonlySet<string> = new Set()): { resolvedModule?: Golem.ResolvedModule } {
    this.assertOpen();
    assertPackageManifestsParse(moduleName, containingFile);
    const overlays = new Map([...virtualFiles].map((filename) => [canonical(filename), 'export {}\n']));
    return classic.resolveModuleName(moduleName, containingFile, compilerOptions, this.host(compilerOptions, overlays), undefined, undefined, resolutionMode);
  }

  /** Called by a closing program. */
  release(program: CompatProgram): void {
    this.held.delete(program);
    if (this.options.closeWhenIdle && this.held.size === 0) this.close();
  }

  /** Forget everything the session parsed or observed. A later program starts afresh unless the session is disposed. */
  close(): void {
    this.latest = undefined;
    this.observed.clear();
    this.seen.clear();
    this.files.clear();
    this.hinted.clear();
    this.held.clear();
  }

  [Symbol.dispose](): void {
    if (sessionDisposedChannel.hasSubscribers) sessionDisposedChannel.publish({ session: this });
    this.disposed = true;
    this.close();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('The TypeScript program session is closed.');
  }

  private observe(observer: ((filename: string) => void) | undefined, hidden: ReadonlySet<string>): void {
    this.observer = observer;
    this.hidden = hidden;
  }

  private report(filename: string): void {
    if (this.hidden.has(filename)) return;
    this.observed.add(filename);
    this.observer?.(filename);
  }

  /** Report a path and, unless an overlay serves it, record the disk signature the compiler is about to see. */
  private probe(filename: string, overlays: ReadonlyMap<string, string>): string {
    const path = canonical(filename);
    this.report(path);
    if (!overlays.has(path)) this.seen.set(path, fileSignature(path));
    return path;
  }

  /**
   * Whether a probed path appeared or vanished, or a package manifest changed, since the compiler last saw it.
   * Either can change what an unchanged file's imports resolve to.
   */
  private resolutionsChanged(): boolean {
    let changed = [...this.hinted].some((filename) => this.seen.has(filename) && affectsResolution(filename));
    this.hinted.clear();
    for (const [filename, recorded] of this.seen) {
      const current = fileSignature(filename);
      if (current === recorded) continue;
      this.seen.set(filename, current);
      if ((current === MISSING) !== (recorded === MISSING) || affectsResolution(filename)) changed = true;
    }
    return changed;
  }

  /** The `references` a tsconfig writes, read from its text alone: no `include` is expanded. */
  private configReferencesOf(configPath: string, overlays: ReadonlyMap<string, string>): ConfigReference[] {
    const { config } = classic.readConfigFile(configPath, (filename) => overlays.get(this.probe(filename, overlays)) ?? sys.readFile(filename));
    return configReferences(config);
  }

  private parseConfig(configPath: string, overlays: ReadonlyMap<string, string>, commandLine?: { readonly options: Golem.CompilerOptions; readonly errors: readonly ClassicDiagnostic[] }): ParsedConfig {
    const parsed = classic.getParsedCommandLineOfConfigFile(configPath, commandLine?.options, {
      useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
      readDirectory: (root, extensions, excludes, includes, depth) => sys.readDirectory(root, extensions, excludes, includes, depth),
      fileExists: (filename) => overlays.has(this.probe(filename, overlays)) || sys.fileExists(filename),
      readFile: (filename) => overlays.get(this.probe(filename, overlays)) ?? sys.readFile(filename),
      getCurrentDirectory: () => this.options.cwd,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(classic.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    if (!parsed) throw new Error(`The TypeScript configuration ${displayPath(configPath)} could not be parsed.`);
    assertConfigParsed(configPath, [...commandLine?.errors ?? [], ...parsed.errors].map((diagnostic) => ({ code: diagnostic.code, text: classic.flattenDiagnosticMessageText(diagnostic.messageText, '\n') })));
    return { options: parsed.options, fileNames: parsed.fileNames, projectReferences: parsed.projectReferences ?? [] };
  }

  /** The compiler host of one program: overlays over disk, input observation, and the session's parsed files. */
  private host(compilerOptions: Golem.CompilerOptions, overlays: ReadonlyMap<string, string>): ClassicHost {
    const base = classic.createCompilerHost(compilerOptions, true);
    const directories = new Set<string>();
    for (const filename of overlays.keys()) {
      for (let directory = dirname(filename); !directories.has(directory); directory = dirname(directory)) {
        directories.add(directory);
        if (dirname(directory) === directory) break;
      }
    }
    const optionsKey = JSON.stringify(compilerOptions);
    return {
      ...base,
      getCurrentDirectory: () => this.options.cwd,
      fileExists: (filename) => overlays.has(this.probe(filename, overlays)) || base.fileExists(filename),
      readFile: (filename) => overlays.get(this.probe(filename, overlays)) ?? base.readFile(filename),
      directoryExists: (directory) => directories.has(this.probe(directory, overlays)) || (base.directoryExists?.(directory) ?? false),
      getSourceFile: (filename, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const path = this.probe(filename, overlays);
        const overlay = overlays.get(path);
        const key = `${optionsKey}|${languageVersionKey(languageVersionOrOptions)}`;
        const stamp = overlay === undefined ? `disk:${this.seen.get(path) ?? MISSING}` : `overlay:${overlay}`;
        const cached = this.files.get(path);
        if (cached && cached.key === key && cached.stamp === stamp && !shouldCreateNewSourceFile) return cached.sourceFile;
        const sourceFile = overlay === undefined
          ? base.getSourceFile(filename, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
          : classic.createSourceFile(filename, overlay, languageVersionOrOptions, true);
        if (sourceFile) this.files.set(path, { key, stamp, sourceFile });
        else this.files.delete(path);
        return sourceFile;
      },
    };
  }

  /** Keep parsed files only for the programs still open. */
  private retainFilesOf(opened: CompatProgram): void {
    const live = new Set([...this.held, opened].flatMap((program) => program.getSourceFiles().map((file) => canonical(file.fileName))));
    for (const path of this.files.keys()) if (!live.has(path)) this.files.delete(path);
  }
}
