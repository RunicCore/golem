/**
 * Type-aware TypeScript 7 surface for generators.
 *
 * TS 7's main `typescript` export is version-only. Analysis uses
 * `typescript/ast` plus `typescript/sync` (TypeScript 7.1 and newer). This module keeps
 * the previous checker-shaped API so model and Nest generators do not walk
 * schemas by hand.
 */

export * from 'typescript/ast';

import { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve as resolvePath,
  sep,
} from 'node:path';
import * as ast from 'typescript/ast';
import { displayPath } from './generator-api.js';
import { fileSignature, MISSING } from './input-watcher.js';
import { assertConfigParsed, assertNoSourceFiles, collectTscDiagnostics, configReferences, declarationOutputOf, emitWanted, flagPathOptions, flagsAsConfigOptions, hasDeclarationOutput, referenceClosure, referencedConfigFile } from './typescript-config.js';
import type { ConfigReference, ResolveAtCurrentFolder } from './typescript-config.js';
import { assertPackageManifestsParse } from './type-analysis/package-specifier.js';
import {
  API,
  CheckFlags as SyncCheckFlags,
  Checker,
  ElementFlags,
  JsxEmit,
  ModuleKind,
  NodeBuilderFlags,
  ObjectFlags,
  Project,
  SignatureKind,
  Snapshot,
  Symbol as SyncSymbol,
  SymbolFlags,
  TypeFlags,
  type CompilerOptions,
  type CreateSnapshotParams,
  type Diagnostic as SyncDiagnostic,
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext,
  type ModuleResolver,
  type RawCompilerOptions,
  type ResolutionMode,
  type SyntheticProjectId,
  type Signature as SyncSignature,
  type Type as SyncType,
} from 'typescript/sync';
import { serverFS, type FileSystemCallbacks } from 'typescript/fs';
import type { Node, SourceFile, TypeNode } from 'typescript/ast';
import type { EmitKind, MemoryEmit, ParsedProject } from './typescript-types.js';

export {
  API,
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext,
  ElementFlags,
  JsxEmit,
  ModuleKind,
  NodeBuilderFlags,
  ObjectFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
};
/** TypeScript 7 names a type parameter's default `defaultType`; TypeScript 6 names it `default`. */
export function typeParameterDefault(parameter: ast.TypeParameterDeclaration): TypeNode | undefined {
  return parameter.defaultType;
}

/** The generic target of a type reference (e.g. the tuple target of a tuple type). */
export function typeReferenceTarget(type: Type): Type | undefined {
  return type.target;
}

/** The `CheckFlags` bits golem reads, from the compiler's own enum: their positions differ between TypeScript 7 releases. */
export const CheckFlags = { Readonly: SyncCheckFlags.Readonly, Mapped: SyncCheckFlags.Mapped } as const;

export type Type = CompatType;
export type Symbol = CompatSymbol;
export type Signature = CompatSignature;
export type { CompilerOptions };

export const isParameter = ast.isParameterDeclaration;
export const isPropertySignature = ast.isPropertySignatureDeclaration;
export const isMethodSignature = ast.isMethodSignatureDeclaration;
export const isStringLiteralLike = ast.isStringLiteralLikeNode;
export const isClassLike = ast.isClassLikeDeclaration;
export type NamedDeclaration = Node & { readonly name?: ast.Identifier };
export type Declaration = Node;
export type StringLiteralLike = ast.StringLiteral | ast.NoSubstitutionTemplateLiteral;

export enum ModuleResolutionKind {
  Unknown = 0,
  Classic = 1,
  Node10 = 2,
  Node16 = 3,
  NodeNext = 99,
  Bundler = 100,
}

export enum IndexKind {
  String = 0,
  Number = 1,
}

export const isFunctionLike = ast.isFunctionLikeDeclaration;
export const isTypeAssertionExpression = ast.isTypeAssertion;

export interface Diagnostic {
  readonly fileName?: string;
  readonly file?: SourceFile;
  readonly pos?: number;
  readonly start?: number;
  readonly end?: number;
  readonly code?: number;
  readonly category?: number;
  readonly text?: string;
  readonly messageText?: string | Diagnostic;
}

export interface ModuleResolutionHost {
  fileExists(filename: string): boolean;
  readFile(filename: string): string | undefined;
  directoryExists?(directory: string): boolean;
  getCurrentDirectory?(): string;
  getDirectories?(directory: string): string[];
  realpath?(filename: string): string;
  useCaseSensitiveFileNames?: boolean | (() => boolean);
}

export type CompilerHost = ModuleResolutionHost & {
  getSourceFile?(filename: string): SourceFile | undefined;
  getCanonicalFileName?(filename: string): string;
  getNewLine?(): string;
  writeFile?(filename: string, content: string): void;
};

export interface ResolvedModule {
  readonly resolvedFileName: string;
  readonly isExternalLibraryImport?: boolean;
}

interface CompatType {
  readonly flags: TypeFlags;
  readonly objectFlags: ObjectFlags;
  readonly value?: string | number | boolean | bigint;
  readonly aliasTypeArguments?: readonly CompatType[];
  isUnion(): boolean;
  isIntersection(): boolean;
  isUnionType(): boolean;
  isIntersectionType(): boolean;
  isTypeReference(): boolean;
  isClassOrInterface(): boolean;
  readonly types: readonly CompatType[];
  readonly aliasSymbol?: CompatSymbol;
  readonly symbol?: CompatSymbol;
  readonly target?: CompatType;
  readonly elementFlags?: readonly ElementFlags[];
  getCallSignatures(): readonly CompatSignature[];
  getConstructSignatures(): readonly CompatSignature[];
  getProperty(name: string): CompatSymbol | undefined;
  getProperties(): readonly CompatSymbol[];
  getSymbol(): CompatSymbol | undefined;
  getAliasSymbol(): CompatSymbol | undefined;
  getAliasTypeArguments(): readonly CompatType[];
  getTarget(): CompatType;
}

interface CompatSymbol {
  readonly flags: number;
  /** Checker-internal `CheckFlags` bits; see `readonlyPropertyNames`. */
  readonly checkFlags: number;
  readonly name: string;
  getName(): string;
  readonly valueDeclaration?: Node;
  readonly declarations: readonly Node[];
}

interface CompatSignature {
  readonly parameters: readonly CompatSymbol[];
  readonly declaration?: Node;
  getParameters(): readonly CompatSymbol[];
  getReturnType(): CompatType;
}

export interface TypeChecker {
  getTypeChecker(): TypeChecker;
  getTypeFromTypeNode(node: TypeNode): CompatType;
  getTypeAtLocation(node: Node): CompatType;
  getSymbolAtLocation(node: Node): CompatSymbol | undefined;
  getAliasedSymbol(symbol: CompatSymbol): CompatSymbol;
  getTypeOfSymbolAtLocation(symbol: CompatSymbol, location: Node): CompatType;
  getPropertiesOfType(type: CompatType): readonly CompatSymbol[];
  getPropertyOfType(type: CompatType, name: string): CompatSymbol | undefined;
  getSignaturesOfType(type: CompatType, kind: SignatureKind): readonly CompatSignature[];
  getReturnTypeOfSignature(signature: CompatSignature): CompatType;
  getTypeArguments(type: CompatType): readonly CompatType[];
  getApparentType(type: CompatType): CompatType;
  isTypeAssignableTo(source: CompatType, target: CompatType): boolean;
  isArrayType(type: CompatType): boolean;
  isTupleType(type: CompatType): boolean;
  typeToString(type: CompatType, enclosingDeclaration?: Node, flags?: number): string;
  typeToTypeNode(type: CompatType, enclosingDeclaration?: Node, flags?: number): TypeNode | undefined;
  getAnyType(): CompatType;
  getStringType(): CompatType;
  getNumberType(): CompatType;
  getBooleanType(): CompatType;
  getUnknownType(): CompatType;
  getNeverType(): CompatType;
  getNullType(): CompatType;
  getUndefinedType(): CompatType;
  getExportsOfModule(symbol: CompatSymbol): readonly CompatSymbol[];
  tryGetMemberInModuleExports(name: string, moduleSymbol: CompatSymbol): CompatSymbol | undefined;
  getRootSymbols(symbol: CompatSymbol): readonly CompatSymbol[];
  getIndexTypeOfType(type: CompatType, kind: IndexKind): CompatType | undefined;
  getIndexInfosOfType(type: CompatType): readonly { readonly keyType: CompatType; readonly valueType: CompatType }[];
  getBaseTypes(type: CompatType): readonly CompatType[];
  getDeclaredTypeOfSymbol(symbol: CompatSymbol): CompatType;
  getConstantValue(node: Node): string | number | undefined;
  getSignatureFromDeclaration(node: Node): CompatSignature | undefined;
  getExportSpecifierLocalTargetSymbol(node: Node): CompatSymbol | undefined;
}

export interface Program {
  close(): void;
  [Symbol.dispose](): void;
  getTypeChecker(): TypeChecker;
  getSourceFile(filename: string): SourceFile | undefined;
  getSourceFiles(): readonly SourceFile[];
  /** A dependency resolved through `node_modules`, including a linked package. */
  isSourceFileFromExternalLibrary(file: SourceFile): boolean;
  isSourceFileDefaultLibrary(file: SourceFile): boolean;
  getCompilerOptions(): CompilerOptions;
  getSyntacticDiagnostics(file?: string): readonly SyncDiagnostic[];
  getSemanticDiagnostics(file?: string): readonly SyncDiagnostic[];
  getDeclarationDiagnostics(file?: string): readonly SyncDiagnostic[];
  getProgramDiagnostics(): readonly SyncDiagnostic[];
  getGlobalDiagnostics(): readonly SyncDiagnostic[];
  getConfigFileParsingDiagnostics(): readonly SyncDiagnostic[];
  emitToMemory(kind: EmitKind): MemoryEmit;
  readonly project: Project;
  readonly snapshot: Snapshot;
  /** The compiler session that opened this program; further programs can share it. */
  readonly session: ProgramSession;
}

const typeCache = new WeakMap<object, CompatType>();
const symbolCache = new WeakMap<object, CompatSymbol>();
const signatureCache = new WeakMap<object, CompatSignature>();
const originalTypes = new WeakMap<object, SyncType>();
const originalSymbols = new WeakMap<object, SyncSymbol>();
const originalSignatures = new WeakMap<object, SyncSignature>();

function unwrapType(type: CompatType | SyncType): SyncType {
  return originalTypes.get(type) ?? (type as SyncType);
}

function unwrapSymbol(symbol: CompatSymbol | SyncSymbol): SyncSymbol {
  return originalSymbols.get(symbol) ?? (symbol as SyncSymbol);
}

function unwrapSignature(signature: CompatSignature | SyncSignature): SyncSignature {
  return originalSignatures.get(signature) ?? (signature as SyncSignature);
}

function wrapType(type: SyncType | undefined, checker: CompatChecker): CompatType {
  if (!type) {
    throw new Error('TypeScript checker returned no type.');
  }
  const cached = typeCache.get(type);
  if (cached) return cached;
  const proxy = new Proxy(type, {
    get(target, property, receiver) {
      if (property === 'isUnion') return () => target.isUnionType();
      if (property === 'isIntersection') return () => target.isIntersectionType();
      if (property === 'types') {
        const members = (target as SyncType & { getTypes?: () => readonly SyncType[] | undefined }).getTypes?.() ?? [];
        return members.map((member) => wrapType(member, checker));
      }
      if (property === 'aliasSymbol') {
        const symbol = target.getAliasSymbol();
        return symbol ? wrapSymbol(symbol, checker) : undefined;
      }
      if (property === 'symbol') {
        const symbol = target.getSymbol();
        return symbol ? wrapSymbol(symbol, checker) : undefined;
      }
      if (property === 'aliasTypeArguments') {
        return target.getAliasTypeArguments().map((argument) => wrapType(argument, checker));
      }
      if (property === 'elementFlags') {
        return (target as SyncType & { elementFlags?: readonly ElementFlags[] }).elementFlags ?? [];
      }
      if (property === 'getCallSignatures') {
        return () => checker.getSignaturesOfType(proxy, SignatureKind.Call);
      }
      if (property === 'getConstructSignatures') {
        return () => checker.getSignaturesOfType(proxy, SignatureKind.Construct);
      }
      if (property === 'getProperty') {
        return (name: string) => checker.getPropertyOfType(proxy, name);
      }
      if (property === 'getProperties') {
        return () => checker.getPropertiesOfType(proxy);
      }
      if (property === 'target') {
        return wrapType((target as SyncType & { getTarget(): SyncType }).getTarget(), checker);
      }
      if (property === 'getTarget') {
        return () => wrapType((target as SyncType & { getTarget(): SyncType }).getTarget(), checker);
      }
      if (property === 'typeArguments') {
        return checker.getTypeArguments(proxy);
      }
      if (property === 'getSymbol') {
        return () => {
          const symbol = target.getSymbol();
          return symbol ? wrapSymbol(symbol, checker) : undefined;
        };
      }
      if (property === 'getAliasSymbol') {
        return () => {
          const symbol = target.getAliasSymbol();
          return symbol ? wrapSymbol(symbol, checker) : undefined;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as unknown as CompatType;
  typeCache.set(type, proxy);
  originalTypes.set(proxy, type);
  return proxy;
}

function wrapSymbol(symbol: SyncSymbol, checker: CompatChecker): CompatSymbol {
  const cached = symbolCache.get(symbol);
  if (cached) return cached;
  const proxy = new Proxy(symbol, {
    get(target, property, receiver) {
      if (property === 'getName') return () => target.name;
      if (property === 'valueDeclaration') {
        return target.valueDeclaration?.resolve(checker.project);
      }
      if (property === 'declarations') {
        return target.declarations
          .map((handle) => handle.resolve(checker.project))
          .filter((node) => node !== undefined);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as unknown as CompatSymbol;
  symbolCache.set(symbol, proxy);
  originalSymbols.set(proxy, symbol);
  return proxy;
}

function wrapSignature(signature: SyncSignature, checker: CompatChecker): CompatSignature {
  const cached = signatureCache.get(signature);
  if (cached) return cached;
  const proxy = new Proxy(signature, {
    get(target, property, receiver) {
      if (property === 'parameters') {
        return target.getParameters().map((parameter) => wrapSymbol(parameter, checker));
      }
      if (property === 'declaration') {
        return target.declaration?.resolve(checker.project);
      }
      if (property === 'getReturnType') {
        return () => checker.getReturnTypeOfSignature(proxy);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as unknown as CompatSignature;
  signatureCache.set(signature, proxy);
  originalSignatures.set(proxy, signature);
  return proxy;
}

/**
 * One answer for each object key. A compiler request costs a round trip, and a snapshot never changes, so a checker asks the compiler
 * once for an object and reads the answer back after that.
 */
class Memo<Key extends object, Value> {
  private readonly answers = new WeakMap<Key, Value>();

  get(key: Key, compute: () => Value): Value {
    if (this.answers.has(key)) return this.answers.get(key) as Value;
    const value = compute();
    this.answers.set(key, value);
    return value;
  }
}

const objectIds = new WeakMap<object, number>();
let lastObjectId = 0;

function objectId(value: object | undefined): number {
  if (!value) return 0;
  let id = objectIds.get(value);
  if (id === undefined) {
    id = ++lastObjectId;
    objectIds.set(value, id);
  }
  return id;
}

class CompatChecker implements TypeChecker {
  private readonly symbolsAtLocation = new Memo<Node, CompatSymbol | undefined>();
  private readonly aliasedSymbols = new Memo<SyncSymbol, CompatSymbol>();
  private readonly typesAtLocation = new Memo<Node, CompatType>();
  private readonly typesFromNode = new Memo<Node, CompatType>();
  private readonly typesOfSymbol = new Memo<SyncSymbol, Memo<Node, CompatType>>();
  private readonly typeStrings = new Memo<SyncType, Map<string, string>>();
  private readonly assignable = new Memo<SyncType, Memo<SyncType, boolean>>();
  private readonly arrayTypes = new Memo<SyncType, boolean>();
  private readonly intrinsics = new Map<string, CompatType>();

  public constructor(
    private readonly inner: Checker,
    readonly project: Project,
    private readonly program: CompatProgram,
  ) {}

  getTypeChecker(): TypeChecker {
    return this;
  }

  resolveImport(specifier: StringLiteralLike, virtualFiles?: ReadonlySet<string>): ResolvedModule | undefined {
    return this.program.resolveImport(specifier, virtualFiles);
  }

  private intrinsic(name: string, ask: () => SyncType): CompatType {
    let type = this.intrinsics.get(name);
    if (!type) {
      type = wrapType(ask(), this);
      this.intrinsics.set(name, type);
    }
    return type;
  }

  getTypeFromTypeNode(node: TypeNode): CompatType {
    return this.typesFromNode.get(node, () => wrapType(this.inner.getTypeFromTypeNode(node) ?? unwrapType(this.getUnknownType()), this));
  }

  getTypeAtLocation(node: Node): CompatType {
    return this.typesAtLocation.get(node, () => wrapType(this.inner.getTypeAtLocation(node) ?? unwrapType(this.getUnknownType()), this));
  }

  getSymbolAtLocation(node: Node): CompatSymbol | undefined {
    return this.symbolsAtLocation.get(node, () => {
      const symbol = this.inner.getSymbolAtLocation(node);
      const resolved = Array.isArray(symbol) ? symbol[0] : symbol;
      return resolved ? wrapSymbol(resolved, this) : undefined;
    });
  }

  getAliasedSymbol(symbol: CompatSymbol): CompatSymbol {
    const inner = unwrapSymbol(symbol);
    return this.aliasedSymbols.get(inner, () => wrapSymbol(this.inner.getAliasedSymbol(inner), this));
  }

  getTypeOfSymbolAtLocation(symbol: CompatSymbol, location: Node): CompatType {
    const inner = unwrapSymbol(symbol);
    return this.typesOfSymbol
      .get(inner, () => new Memo())
      .get(location, () => wrapType(this.inner.getTypeOfSymbolAtLocation(inner, location), this));
  }

  getPropertiesOfType(type: CompatType): readonly CompatSymbol[] {
    return this.inner.getPropertiesOfType(unwrapType(type)).map((symbol) => wrapSymbol(symbol, this));
  }

  getPropertyOfType(type: CompatType, name: string): CompatSymbol | undefined {
    const symbol = this.inner.getPropertyOfType(unwrapType(type), name);
    return symbol ? wrapSymbol(symbol, this) : undefined;
  }

  getSignaturesOfType(type: CompatType, kind: SignatureKind): readonly CompatSignature[] {
    return this.inner.getSignaturesOfType(unwrapType(type), kind).map((signature) => wrapSignature(signature, this));
  }

  getReturnTypeOfSignature(signature: CompatSignature): CompatType {
    const type = this.inner.getReturnTypeOfSignature(unwrapSignature(signature)) ?? unwrapType(this.getUnknownType());
    return wrapType(type, this);
  }

  getTypeArguments(type: CompatType): readonly CompatType[] {
    const inner = unwrapType(type);
    if (!inner.isTypeReference()) return [];
    return this.inner.getTypeArguments(inner).map((argument) => wrapType(argument, this));
  }

  getApparentType(type: CompatType): CompatType {
    return wrapType(this.inner.getApparentType(unwrapType(type)) ?? unwrapType(type), this);
  }

  isTypeAssignableTo(source: CompatType, target: CompatType): boolean {
    const to = unwrapType(target);
    return this.assignable
      .get(unwrapType(source), () => new Memo())
      .get(to, () => this.inner.isTypeAssignableTo(unwrapType(source), to));
  }

  isArrayType(type: CompatType): boolean {
    const inner = unwrapType(type);
    return this.arrayTypes.get(inner, () => this.inner.isArrayType(inner));
  }

  isTupleType(type: CompatType): boolean {
    return this.inner.isTupleType(unwrapType(type));
  }

  typeToString(type: CompatType, enclosingDeclaration?: Node, flags?: number): string {
    const inner = unwrapType(type);
    const strings = this.typeStrings.get(inner, () => new Map());
    const key = `${objectId(enclosingDeclaration)}:${flags ?? ''}`;
    let text = strings.get(key);
    if (text === undefined) {
      text = this.inner.typeToString(inner, enclosingDeclaration, flags);
      strings.set(key, text);
    }
    return text;
  }

  typeToTypeNode(type: CompatType, enclosingDeclaration?: Node, flags?: number): TypeNode | undefined {
    return this.inner.typeToTypeNode(unwrapType(type), enclosingDeclaration, flags);
  }

  getAnyType(): CompatType {
    return this.intrinsic('Any', () => this.inner.getAnyType());
  }

  getStringType(): CompatType {
    return this.intrinsic('String', () => this.inner.getStringType());
  }

  getNumberType(): CompatType {
    return this.intrinsic('Number', () => this.inner.getNumberType());
  }

  getBooleanType(): CompatType {
    return this.intrinsic('Boolean', () => this.inner.getBooleanType());
  }

  getUnknownType(): CompatType {
    return this.intrinsic('Unknown', () => this.inner.getUnknownType());
  }

  getNeverType(): CompatType {
    return this.intrinsic('Never', () => this.inner.getNeverType());
  }

  getNullType(): CompatType {
    return this.intrinsic('Null', () => this.inner.getNullType());
  }

  getUndefinedType(): CompatType {
    return this.intrinsic('Undefined', () => this.inner.getUndefinedType());
  }

  getExportsOfModule(symbol: CompatSymbol): readonly CompatSymbol[] {
    return this.inner.getExportsOfModule(unwrapSymbol(symbol)).map((item) => wrapSymbol(item, this));
  }

  tryGetMemberInModuleExports(name: string, moduleSymbol: CompatSymbol): CompatSymbol | undefined {
    const symbol = this.inner.getMemberInModuleExports(unwrapSymbol(moduleSymbol), name);
    return symbol ? wrapSymbol(symbol, this) : undefined;
  }

  getRootSymbols(symbol: CompatSymbol): readonly CompatSymbol[] {
    return [symbol];
  }

  getIndexTypeOfType(type: CompatType, kind: IndexKind): CompatType | undefined {
    const infos = this.inner.getIndexInfosOfType(unwrapType(type));
    const key = unwrapType(kind === IndexKind.String ? this.getStringType() : this.getNumberType());
    const match = infos.find((info) => this.inner.isTypeAssignableTo(key, info.keyType) || this.inner.isTypeAssignableTo(info.keyType, key));
    return match ? wrapType(match.valueType, this) : undefined;
  }

  getIndexInfosOfType(type: CompatType): readonly { readonly keyType: CompatType; readonly valueType: CompatType }[] {
    return this.inner.getIndexInfosOfType(unwrapType(type)).map((info) => ({
      keyType: wrapType(info.keyType, this),
      valueType: wrapType(info.valueType, this),
    }));
  }

  getBaseTypes(type: CompatType): readonly CompatType[] {
    const inner = unwrapType(type);
    if (!inner.isClassOrInterface()) return [];
    return this.inner.getBaseTypes(inner).map((base) => wrapType(base, this));
  }

  getDeclaredTypeOfSymbol(symbol: CompatSymbol): CompatType {
    return wrapType(this.inner.getDeclaredTypeOfSymbol(unwrapSymbol(symbol)), this);
  }

  getConstantValue(node: Node): string | number | undefined {
    return this.inner.getConstantValue(node);
  }

  getSignatureFromDeclaration(node: Node): CompatSignature | undefined {
    const signature = this.inner.getSignatureFromDeclaration(node);
    return signature ? wrapSignature(signature, this) : undefined;
  }

  getExportSpecifierLocalTargetSymbol(node: Node): CompatSymbol | undefined {
    const symbol = this.inner.getExportSpecifierLocalTargetSymbol(node);
    return symbol ? wrapSymbol(symbol, this) : undefined;
  }
}

class CompatProgram implements Program {
  readonly checker: CompatChecker;
  private closed = false;

  public constructor(
    readonly session: ProgramSession,
    readonly snapshot: Snapshot,
    readonly project: Project,
    private readonly unbuilt: ReadonlySet<string> = new Set(),
  ) {
    this.checker = new CompatChecker(project.checker, project, this);
  }

  unbuiltReferences(): readonly string[] {
    return [...this.unbuilt];
  }

  getTypeChecker(): TypeChecker {
    return this.checker;
  }

  /**
   * The module an import of a file of this program resolved to, as the compiler resolved it for the program. When the compiler found
   * none, `virtualFiles` are files that do not exist yet but will, and a second lookup counts them.
   */
  resolveImport(specifier: StringLiteralLike, virtualFiles?: ReadonlySet<string>): ResolvedModule | undefined {
    const file = specifier.getSourceFile().fileName;
    assertPackageManifestsParse(specifier.text, file);
    const resolved = this.project.program.getResolvedModuleFromModuleSpecifier(specifier, file);
    if (resolved || !virtualFiles || virtualFiles.size === 0) return resolved;
    const mode = this.project.program.getModeForUsageLocation(file, specifier);
    return this.session.resolveModuleName(specifier.text, file, this.getCompilerOptions(), mode, virtualFiles).resolvedModule;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.release(this);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  getSourceFile(filename: string): SourceFile | undefined {
    return this.withImpliedNodeFormat(this.project.program.getSourceFile(filename));
  }

  getSourceFiles(): readonly SourceFile[] {
    return this.project.program.getSourceFileNames()
      .map((name) => this.withImpliedNodeFormat(this.project.program.getSourceFile(name)))
      .filter((file): file is SourceFile => file !== undefined);
  }

  /** The program's module format of the file, as the classic `SourceFile.impliedNodeFormat`; the TypeScript 7 file leaves it in the program's metadata. */
  private withImpliedNodeFormat(file: SourceFile | undefined): SourceFile | undefined {
    if (file && !Object.hasOwn(file, 'impliedNodeFormat')) {
      const format = this.project.program.getSourceFileMetadata(file.fileName)?.impliedNodeFormat;
      Object.defineProperty(file, 'impliedNodeFormat', { value: format === undefined || format === ModuleKind.None ? undefined : format });
    }
    return file;
  }

  isSourceFileFromExternalLibrary(file: SourceFile): boolean {
    return this.project.program.isSourceFileFromExternalLibrary(file);
  }

  isSourceFileDefaultLibrary(file: SourceFile): boolean {
    return this.project.program.isSourceFileDefaultLibrary(file);
  }

  getCompilerOptions(): CompilerOptions {
    return this.project.parsedCommandLine.options;
  }

  getSyntacticDiagnostics(file?: string): readonly SyncDiagnostic[] {
    return this.project.program.getSyntacticDiagnostics(file);
  }

  getSemanticDiagnostics(file?: string): readonly SyncDiagnostic[] {
    return this.project.program.getSemanticDiagnostics(file);
  }

  getDeclarationDiagnostics(file?: string): readonly SyncDiagnostic[] {
    return this.project.program.getDeclarationDiagnostics(file);
  }

  getProgramDiagnostics(): readonly SyncDiagnostic[] {
    return this.project.program.getProgramDiagnostics();
  }

  getGlobalDiagnostics(): readonly SyncDiagnostic[] {
    return this.project.program.getGlobalDiagnostics();
  }

  getConfigFileParsingDiagnostics(): readonly SyncDiagnostic[] {
    return this.project.program.getConfigFileParsingDiagnostics();
  }

  /**
   * The compiler's `getJavaScriptEmit` and `getDeclarationEmit` over the program's own sources: they return the text and write
   * nothing. They ignore `noEmit` and the declaration options, so the classic compiler's rule for what a program emits is applied here.
   */
  emitToMemory(kind: EmitKind): MemoryEmit {
    const options = this.getCompilerOptions();
    const declarations = kind === 'declarations';
    if (!emitWanted(options, declarations)) return { emitSkipped: true, files: new Map(), sources: new Map(), diagnostics: [] };
    const sources = this.getSourceFiles()
      .filter((file) => !file.isDeclarationFile && !this.isSourceFileDefaultLibrary(file) && !this.isSourceFileFromExternalLibrary(file))
      .map((file) => file.fileName);
    const output = declarations ? this.project.program.getDeclarationEmit(sources) : this.project.program.getJavaScriptEmit(sources);
    return {
      emitSkipped: output.emitSkipped,
      files: new Map([...output.outputFiles].map(([filename, { text }]) => [canonical(filename), text])),
      sources: new Map([...output.outputFiles].flatMap(([filename, { sourceFileName }]) => (sourceFileName === undefined ? [] : [[canonical(filename), canonical(sourceFileName)] as const]))),
      diagnostics: output.diagnostics,
    };
  }
}

function canonical(filename: string): string {
  return normalize(resolvePath(filename));
}

const parseFlags = (api: API) => (flags: readonly string[]) => {
  const { options, fileNames, errors } = api.parseCommandLine(flags);
  return { options, fileNames, errors };
};

/** The options read as a tsconfig of the current folder: the compiler's parse makes the path options absolute from it. It lists no file. */
const resolveAtCurrentFolder = (api: API): ResolveAtCurrentFolder => (options) => api.parseJsonConfigFileContent(
  { compilerOptions: options, files: [] },
  { configFileName: join(process.cwd(), 'tsconfig.golem-flags.json') },
).options as Readonly<Record<string, unknown>>;

export const sys: ModuleResolutionHost & {
  useCaseSensitiveFileNames: boolean;
  getCurrentDirectory(): string;
} = {
  useCaseSensitiveFileNames: process.platform !== 'win32',
  getCurrentDirectory: () => process.cwd(),
  // Like the TypeScript 6 system: a file, so a folder named like a module is no module.
  fileExists: (filename) => statSync(filename, { throwIfNoEntry: false })?.isFile() === true,
  readFile: (filename) => {
    try {
      // Like the TypeScript 6 system, return the text without a leading U+FEFF, so a JSON file that starts with one parses.
      return readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      return undefined;
    }
  },
  directoryExists: (directory) => {
    try {
      return lstatSync(directory).isDirectory();
    } catch {
      return false;
    }
  },
  getDirectories: (directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  realpath: (filename) => {
    try {
      return realpathSync(filename);
    } catch {
      return filename;
    }
  },
};

export function createCompilerHost(options: CompilerOptions = {}, _setParentNodes?: boolean): CompilerHost {
  void options;
  return {
    fileExists: (filename) => sys.fileExists(filename),
    readFile: (filename) => sys.readFile(filename),
    directoryExists: (directory) => sys.directoryExists?.(directory) ?? false,
    getCurrentDirectory: () => sys.getCurrentDirectory(),
    getDirectories: (directory) => sys.getDirectories?.(directory) ?? [],
    realpath: (filename) => sys.realpath?.(filename) ?? filename,
    useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
    getCanonicalFileName: (filename) => filename,
    getNewLine: () => '\n',
  };
}

export function findConfigFile(
  searchPath: string,
  fileExists: (filename: string) => boolean,
  configName = 'tsconfig.json',
): string | undefined {
  let current = resolvePath(searchPath);
  for (;;) {
    const candidate = join(current, configName);
    if (fileExists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function getPreEmitDiagnostics(program: Program): readonly SyncDiagnostic[] {
  // As the classic compiler: declaration diagnostics belong to a program that emits declarations.
  const options = program.getCompilerOptions();
  return [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...(options.declaration === true || options.composite === true ? program.getDeclarationDiagnostics() : []),
    ...program.getProgramDiagnostics(),
  ];
}

/** The order `tsc` sorts diagnostics in: file, start, end, code, message. A diagnostic without a file comes first. */
function compareDiagnostics(left: SyncDiagnostic, right: SyncDiagnostic): number {
  const text = (diagnostic: SyncDiagnostic): string => [diagnostic.text, ...(diagnostic.messageChain ?? []).map((chained) => chained.text)].join('\n');
  const order = (a: string | number | undefined, b: string | number | undefined): number => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1);
  return order(left.fileName, right.fileName) || order(left.pos, right.pos) || order(left.end, right.end) || order(left.code, right.code) || order(text(left), text(right));
}

/**
 * The diagnostics of `tsc`'s own report, in its steps: the configuration's, then the syntax errors alone when there are any, else the
 * options', the global and the semantic ones, then the declaration ones under `noEmit` (an emit reports its own); sorted without repeats.
 */
export function getTscDiagnostics(program: Program, emitDiagnostics: readonly SyncDiagnostic[] = []): readonly SyncDiagnostic[] {
  const found = collectTscDiagnostics<SyncDiagnostic>({
    config: () => program.getConfigFileParsingDiagnostics(),
    syntactic: () => program.getSyntacticDiagnostics(),
    options: () => program.getProgramDiagnostics(),
    global: () => program.getGlobalDiagnostics(),
    semantic: () => program.getSemanticDiagnostics(),
    declaration: () => program.getDeclarationDiagnostics(),
  }, program.getCompilerOptions());
  const sorted = [...found, ...emitDiagnostics].sort(compareDiagnostics);
  return sorted.filter((diagnostic, index) => index === 0 || compareDiagnostics(sorted[index - 1]!, diagnostic) !== 0);
}

export function canHaveDecorators(node: Node): boolean {
  return 'modifiers' in node || ast.isClassDeclaration(node) || ast.isMethodDeclaration(node)
    || ast.isParameterDeclaration(node) || ast.isPropertyDeclaration(node);
}

export function getDecorators(node: Node): readonly ast.Decorator[] | undefined {
  const modifiers = (node as { modifiers?: readonly Node[] }).modifiers;
  const decorators = modifiers?.filter(ast.isDecorator);
  return decorators && decorators.length > 0 ? decorators : undefined;
}

export function canHaveModifiers(node: Node): boolean {
  return 'modifiers' in node;
}

export function getModifiers(node: Node): readonly Node[] | undefined {
  const modifiers = (node as { modifiers?: readonly Node[] }).modifiers;
  return modifiers?.filter((modifier) => !ast.isDecorator(modifier));
}

/** The TypeScript 7 scanner takes no language version, and the variant before the text. */
export function createScanner(skipTrivia: boolean, text: string, start?: number, length?: number) {
  return ast.createScanner(skipTrivia, ast.LanguageVariant.Standard, text, start, length);
}

export function forEachChild<T>(node: Node, callback: (node: Node) => T | undefined): T | undefined {
  return node.forEachChild(callback);
}

export interface OpenProgramOptions {
  readonly root: string;
  readonly sources: readonly string[];
  /**
   * Optional virtual project configuration path, relative to root when not
   * absolute. A configuration supplied through overlays is derived input and
   * is not reported to onInput.
   */
  readonly configFile?: string;
  readonly overlays?: ReadonlyMap<string, string>;
  /** Compiler options that replace the configuration's own for this program only, as tsconfig JSON values (an enum is its name). */
  readonly compilerOptionOverrides?: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
  /** Command-line arguments that replace the configuration's options for this program only; `compilerOptionOverrides` win over them. */
  readonly flags?: readonly string[];
  readonly onInput?: (filename: string) => void;
}

export interface ProgramSessionOptions {
  /** Working directory of the compiler process. */
  readonly cwd: string;
  /** Close the compiler process when the last open program closes. */
  readonly closeWhenIdle?: boolean;
}

interface ProgramRequest {
  readonly configPath: string;
  readonly files: readonly string[];
  readonly overlays: ReadonlyMap<string, string>;
  /** Configuration paths the observer is not told about: virtual configurations are derived input. */
  readonly hidden: ReadonlySet<string>;
  /** Set for a project that has references: the compiler is given a synthetic program, not the project. */
  readonly synthetic?: SyntheticProgram;
}

/**
 * A program of a project with references, as the compiler takes it from the API. A program that is given `projectReferences`
 * reads the referenced sources, so the program takes a module resolver that answers with the declaration output of a referenced source instead.
 */
interface SyntheticProgram {
  readonly rootFiles: readonly string[];
  readonly compilerOptions: CompilerOptions;
  readonly resolver: ModuleResolver;
  /** The sources of referenced projects that an import reached and that have no declaration output. The resolver fills it while the program is made. */
  readonly unbuilt: ReadonlySet<string>;
}

/** A project a tsconfig references, parsed: the source files it owns and where `tsc` finds its declaration output. */
interface ReferencedProject {
  readonly configFile: string;
  readonly options: CompilerOptions;
  readonly sources: ReadonlySet<string>;
}

function directoryEntries(directory: string): string {
  try {
    return readdirSync(directory).sort().join('\0');
  } catch {
    return '';
  }
}

/** A change to a package manifest or an installed package invalidates cached module resolution. */
function affectsResolution(filename: string): boolean {
  return basename(filename) === 'package.json' || filename.split(sep).includes('node_modules');
}

/** The compiler process exited or its channel closed; a server-reported error leaves it running. */
function compilerExited(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  if (code === 'EPIPE' || code === 'EBADF' || code === 'ECONNRESET') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Unexpected EOF while reading from child process|SyncRpcChannel is closed/.test(message);
}

function programRequest(options: OpenProgramOptions, referencesOf: (configPath: string, overlays: ReadonlyMap<string, string>) => readonly ConfigReference[]): ProgramRequest {
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
    // A virtual configuration that extends the original replaces the options for this program only: the API has no override. It sits beside
    // the original, so the references, which an extending configuration does not inherit, keep their meaning when copied.
    configPath = join(dirname(baseConfigPath), `${basename(baseConfigPath, '.json')}.options.json`);
    const references = referencesOf(baseConfigPath, overlays);
    overlays.set(configPath, JSON.stringify({ extends: `./${basename(baseConfigPath)}`, compilerOptions: options.compilerOptionOverrides, ...(references.length === 0 ? {} : { references }) }));
    hidden.add(configPath);
  }
  return { configPath, files: [...new Set(options.sources.map(canonical))], overlays, hidden };
}

// Notices for tests and tools that watch the sessions of this process (`node:diagnostics_channel`); nothing is built unless a subscriber exists.
const programOpenedChannel = channel('golem:program-opened');
const inputsChangedChannel = channel('golem:inputs-changed');
const sessionDisposedChannel = channel('golem:session-disposed');
const compilerStartedChannel = channel('golem:compiler-started');
const compilerClosedChannel = channel('golem:compiler-closed');
const snapshotRequestedChannel = channel('golem:snapshot-requested');
const snapshotSettledChannel = channel('golem:snapshot-settled');

/** The compiler process of an API, or undefined when this TypeScript build keeps it somewhere else. */
function compilerProcess(api: API): ChildProcess | undefined {
  const child: unknown = (api as unknown as { readonly client?: { readonly channel?: { readonly child?: unknown } } }).client?.channel?.child;
  return child instanceof ChildProcess ? child : undefined;
}

/**
 * Stop the compiler process. `api.close()` ends it with SIGTERM, right after it closes the compiler's input. The compiler
 * server reacts to SIGTERM by cancelling its context, and when the signal lands between its last response and its next read
 * it reports `context canceled` on the inherited stderr, a line that no golem command wrote. SIGKILL cannot be reported on.
 * The compiler holds no state that must be written out, since golem only reads its answers, so it is killed first and the
 * API then releases its side of the channel. `session.close()` has already released every snapshot.
 */
function closeCompiler(api: API): void {
  const compiler = compilerProcess(api);
  compiler?.kill('SIGKILL');
  try {
    api.close();
  } finally {
    if (compilerClosedChannel.hasSubscribers) compilerClosedChannel.publish({ compiler });
  }
}

/** Release a module resolver; one on an exited compiler is already gone. */
function disposeResolver(resolver: ModuleResolver | undefined): void {
  try {
    resolver?.dispose();
  } catch (error) {
    if (!compilerExited(error)) throw error;
  }
}

/** Release a snapshot; one on an exited compiler is already gone. */
function disposeSnapshot(snapshot: Snapshot): void {
  try {
    snapshot.dispose();
  } catch (error) {
    if (!compilerExited(error)) throw error;
  }
}

interface PendingChanges {
  /** Every detected change and every hinted file the compiler read, or undefined when there is none. */
  readonly changes?: { readonly changed: readonly string[]; readonly created: readonly string[]; readonly deleted: readonly string[] };
  /** Invalidate every cached file too: resolution inputs changed, or records outgrew the last full snapshot. */
  readonly full: boolean;
  /** Record the signatures the changes were computed from, once a snapshot has reported them. */
  readonly commit: () => void;
}

/**
 * One TypeScript compiler process shared by the programs of a generation
 * run or watch session.
 *
 * The compiler caches every file it reads, so each later snapshot reports
 * the files that changed since the compiler last held them. The session
 * records the signature of every path the compiler read or probed and every
 * directory it listed, compares them before the next snapshot, and replays the
 * recorded paths to the next program's input observer because a warm compiler
 * does not probe them again.
 *
 * A compiler callback records a path only the first time. Only a snapshot that
 * reported a change replaces the recorded signature: a callback does not show
 * what the compiler holds, because it can read or probe a project configuration
 * without applying it. A record that is older than the disk costs one extra
 * reload; a record that is newer would hide the change.
 *
 * Invalidating every file does not parse a project configuration again, only a
 * reported change does, so a snapshot that invalidates every file first reports
 * the detected changes in a snapshot of their own. The records survive such a
 * snapshot because the compiler keeps its parsed configurations through it: a record
 * taken again after an edit that lands inside the snapshot would postdate an edit the
 * compiler never applied, and the next snapshot would not report it. Only the replayed
 * inputs are collected again.
 */
export class ProgramSession implements Disposable {
  private api: API | undefined;
  private disposed = false;
  private callbackFailed = false;
  /** Overlays served by the latest snapshot. */
  private overlays: ReadonlyMap<string, string> = new Map();
  private overlayDirectories = new Set<string>();
  private observer: ((filename: string) => void) | undefined;
  private hidden: ReadonlySet<string> = new Set();
  private readonly observed = new Set<string>();
  private readonly signatures = new Map<string, string>();
  private readonly listings = new Map<string, string>();
  private fullRecordCount = 0;
  /** Inputs a host saw change since the previous snapshot. */
  private readonly hinted = new Set<string>();
  private readonly openProjects = new Set<string>();
  private readonly held = new Map<CompatProgram, ProgramRequest>();
  /** The compiler's module resolver of each set of options (by their JSON), made when a lookup first needs it. */
  private readonly resolvers = new Map<string, ModuleResolver>();
  /**
   * The synthetic program the newest snapshot holds, and the module resolver it was made with. The next program of a project with references
   * replaces the program's configuration and the resolver; the snapshots before keep theirs. TypeScript 7.1.0-beta panics when a program is removed.
   */
  private syntheticProgram: SyntheticProjectId | undefined;
  private referenceResolver: ModuleResolver | undefined;
  /**
   * The newest snapshot stays alive until the next one exists: TypeScript 7.1 builds each snapshot as an update of a
   * live one, and refuses to update a disposed snapshot.
   */
  private latest: Snapshot | undefined;

  public constructor(private readonly options: ProgramSessionOptions) {}

  /**
   * Report inputs a host observed changing. The next snapshot reports each one
   * the compiler read as changed, so an edit that the session's own signatures
   * cannot see, such as one within the file system's timestamp resolution,
   * still reaches the compiler.
   */
  inputsChanged(filenames: Iterable<string>): void {
    const names = [...filenames];
    if (inputsChangedChannel.hasSubscribers) inputsChangedChannel.publish({ session: this, filenames: names });
    for (const filename of names) this.hinted.add(canonical(filename));
  }

  /** Parse a project configuration with the session compiler. */
  parseConfigFile(configPath: string, onInput?: (filename: string) => void): ParsedProject {
    const parsed = this.withCompiler('parse', (api) => {
      this.observe(onInput, new Set());
      const result = api.parseConfigFile(configPath);
      assertConfigParsed(configPath, result.errors);
      return result;
    });
    return projectOf(parsed);
  }

  /**
   * Parse a project configuration under compiler command-line arguments. The API has no `tsc -p` parse, so the arguments are parsed
   * on their own and merged over the configuration's options, which is what `tsc` does. The options that decide which files match
   * (`allowJs`, `resolveJsonModule` and the output directories the default `exclude` skips) first go through a virtual configuration
   * that extends the original, so the file list follows the merged options.
   */
  parseConfigFileWithFlags(configPath: string, flags: readonly string[], onInput?: (filename: string) => void): ParsedProject {
    const parsed = this.withCompiler('parse', (api) => {
      this.observe(onInput, new Set());
      const commandLine = api.parseCommandLine(flags);
      assertNoSourceFiles(commandLine.fileNames);
      const { allowJs, resolveJsonModule, outDir, declarationDir } = commandLine.options;
      const matching = Object.fromEntries(Object.entries({ allowJs, resolveJsonModule, outDir, declarationDir }).filter(([, value]) => value !== undefined));
      const virtual = join(dirname(configPath), `${basename(configPath, '.json')}.flags.json`);
      const references = configReferences(api.readConfigFile(configPath).config);
      const result = api.parseJsonConfigFileContent({ extends: `./${basename(configPath)}`, compilerOptions: matching, ...(references.length === 0 ? {} : { references }) }, { configFileName: virtual });
      assertConfigParsed(configPath, [...commandLine.errors, ...result.errors]);
      // A path in a flag is read from the current folder, as `tsc` reads it; the API's parse reads it from the folder of the session.
      const paths = flagPathOptions(flags, parseFlags(api), resolveAtCurrentFolder(api));
      return { options: { ...result.options, ...commandLine.options, ...paths, configFilePath: configPath }, fileNames: result.fileNames, projectReferences: result.projectReferences };
    });
    return projectOf(parsed);
  }

  /**
   * The options of a program with its command-line `flags` among its option overrides, which win over the flags. The compiler builds a
   * program from a configuration alone, so the flags travel in the virtual configuration that `compilerOptionOverrides` already uses.
   */
  private withFlags(options: OpenProgramOptions): OpenProgramOptions {
    const { flags } = options;
    if (flags === undefined || flags.length === 0) return options;
    const flagged = this.withCompiler('parse', (api) => flagsAsConfigOptions(flags, parseFlags(api), resolveAtCurrentFolder(api)));
    return { ...options, compilerOptionOverrides: { ...flagged, ...options.compilerOptionOverrides } };
  }

  /**
   * Parse one source text on its own, without a program. The syntax tree reads from its own buffer, so the compiler's lease on
   * the file ends here.
   */
  parseSourceFile(filename: string, text: string): SourceFile {
    return this.withCompiler('parse', (api) => {
      // The tree reads from the response buffer that this call owns; dispose only releases the server's copy, so a syntax walk
      // may read the tree after it. Asking the server about a node (a symbol or a type) after dispose is not valid.
      const retained = api.createSourceFile(filename, text);
      try {
        return retained.sourceFile;
      } finally {
        retained.dispose();
      }
    });
  }

  /** Compile one source text on its own, with the compiler's single-file transpile: no snapshot, no program. */
  transpileModule(filename: string, text: string, compilerOptions: CompilerOptions): { readonly outputText: string; readonly sourceMapText: string; readonly diagnostics: readonly SyncDiagnostic[] } {
    return this.withCompiler('parse', (api) => {
      const { outputText, sourceMapText, diagnostics = [] } = api.transpileModule(text, { fileName: filename, compilerOptions: compilerOptions as RawCompilerOptions, reportDiagnostics: true });
      if (sourceMapText === undefined) throw new Error(`The TypeScript compiler returned no source map for ${displayPath(filename)}`);
      return { outputText, sourceMapText, diagnostics };
    });
  }

  /**
   * Resolve a module name for a file at `containingFile` with the compiler's own resolver, for a module that is no import of a
   * program, such as one an SDK manifest names. The lookup sees the disk and `virtualFiles`, the same files as on the TypeScript 6
   * lane, and no overlay of a program.
   */
  resolveModuleName(moduleName: string, containingFile: string, compilerOptions: CompilerOptions, resolutionMode?: ModuleKind, virtualFiles: ReadonlySet<string> = new Set()): { resolvedModule?: ResolvedModule } {
    assertPackageManifestsParse(moduleName, containingFile);
    return this.withCompiler('parse', (api) => {
      const resolver = this.plainResolver(api, compilerOptions);
      const previous = this.overlays;
      this.setOverlays(new Map([...virtualFiles].map((filename) => [canonical(filename), 'export {}\n'])));
      try {
        return resolver.resolveModuleName(moduleName, dirname(containingFile), resolutionMode as ResolutionMode | undefined);
      } finally {
        this.setOverlays(previous);
      }
    });
  }

  /** The compiler's module resolver for these options. Options that parse alike share one, so a watch that parses its configuration again does not make a new one. */
  private plainResolver(api: API, compilerOptions: CompilerOptions): ModuleResolver {
    const key = JSON.stringify(compilerOptions);
    let resolver = this.resolvers.get(key);
    if (!resolver) this.resolvers.set(key, resolver = api.createModuleResolver(compilerOptions));
    return resolver;
  }

  /** The `references` a tsconfig writes, read from its text alone, over the overlays of a request: no `include` is expanded. */
  private configReferencesOf(configPath: string, overlays: ReadonlyMap<string, string>): ConfigReference[] {
    return this.withCompiler('parse', (api) => {
      const previous = this.overlays;
      this.setOverlays(overlays);
      try {
        return configReferences(api.readConfigFile(configPath).config);
      } finally {
        this.setOverlays(previous);
      }
    });
  }

  /**
   * The module resolver of a program that has references. It resolves as the compiler does, and a source file of a referenced project resolves to the
   * declaration file `tsc` writes for it, which is what `tsc -p` reads for an import of that source. A declaration file or a JSON file of a
   * referenced project resolves as it is, as `tsc` leaves it. Whether the declaration file exists is the compiler's to find: a missing one is an import it cannot resolve.
   */
  private referenceResolverFor(api: API, compilerOptions: CompilerOptions, projects: readonly ReferencedProject[], unbuilt: Set<string>): ModuleResolver {
    const plain = this.plainResolver(api, compilerOptions);
    return api.createModuleResolver(compilerOptions as RawCompilerOptions, {
      resolveModuleName: (moduleName, directory, mode, { snapshot }) => {
        const resolved = plain.resolveModuleName(moduleName, directory, mode, { snapshot }).resolvedModule;
        if (!resolved) return undefined;
        const { resolvedFileName, originalPath, packageId } = resolved;
        const file = canonical(resolvedFileName);
        const owner = hasDeclarationOutput(file) ? projects.find((project) => project.sources.has(file)) : undefined;
        if (owner) {
          const output = declarationOutputOf(file, owner.configFile, owner.options);
          if (!sys.fileExists(output)) unbuilt.add(file);
          return { resolvedFileName: output };
        }
        return { resolvedFileName, ...(originalPath === undefined ? {} : { originalPath }), ...(packageId === undefined ? {} : { packageId }) };
      },
    });
  }

  /** The change that gives a snapshot the program of a project with references: the first one creates it, the later ones give it a new configuration. */
  private syntheticChange(synthetic: SyntheticProgram): CreateSnapshotParams {
    const program = { rootFiles: [...synthetic.rootFiles], compilerOptions: synthetic.compilerOptions as RawCompilerOptions, options: { moduleResolver: synthetic.resolver, configFileParsingDiagnostics: [] } };
    return this.syntheticProgram === undefined ? { createPrograms: [program] } : { reconfigurePrograms: [{ id: this.syntheticProgram, ...program }] };
  }

  /** Open a program in a new snapshot that reflects every file change since the previous one. */
  openProgram(options: OpenProgramOptions): Program {
    if (programOpenedChannel.hasSubscribers) programOpenedChannel.publish({ session: this, configFile: options.configFile });
    const base = programRequest(this.withFlags(options), (configPath, overlays) => this.configReferencesOf(configPath, overlays));
    return this.withCompiler('snapshot', (api, reused) => {
      const request = this.withRequestedRoots(api, base, options.onInput);
      // A program sees only its own overlays: a held program keeps the snapshot it was opened in.
      const overlays = request.overlays;
      const pending = reused ? this.pendingChanges(overlays) : undefined;
      const full = pending === undefined || pending.full;
      if (full) this.observed.clear();
      this.setOverlays(overlays);
      this.observe(options.onInput, request.hidden);
      for (const filename of [...this.observed]) this.report(filename);
      const changes = pending?.changes && {
        changed: nonEmpty(pending.changes.changed),
        created: nonEmpty(pending.changes.created),
        deleted: nonEmpty(pending.changes.deleted),
      };
      // The request's configuration lists every root, so no file is opened on its own: TypeScript 7.1.0-beta panics while it
      // searches a default project for an open file outside every tsconfig directory.
      const { synthetic } = request;
      const projects = new Set(synthetic ? [] : [request.configPath]);
      // Invalidating every file leaves a parsed configuration as it is, so its change is reported first.
      if (pending?.full && changes) this.advance(api, { fileNotifications: changes });
      const snapshot = this.advance(api, {
        openProjects: synthetic || this.openProjects.has(request.configPath) ? undefined : [request.configPath],
        closeProjects: nonEmpty([...this.openProjects].filter((project) => !projects.has(project))),
        ...(synthetic ? this.syntheticChange(synthetic) : {}),
        fileNotifications: pending?.full ? { invalidateAll: true } : changes,
      });
      pending?.commit();
      if (full) this.fullRecordCount = this.observed.size;
      this.hinted.clear();
      replaceAll(this.openProjects, projects);
      const previousResolver = this.referenceResolver;
      const previousSynthetic = this.syntheticProgram;
      if (synthetic) {
        disposeResolver(previousResolver);
        this.referenceResolver = synthetic.resolver;
      }
      try {
        // The project of the request's own configuration (the derived one when roots were added), so every run of a job
        // sees the same files. Another project would be the wrong program.
        const created = synthetic ? this.syntheticProgram ?? snapshot.operation.createdPrograms?.[0]?.id : undefined;
        const project = created === undefined ? snapshot.getConfiguredProject(request.configPath) : snapshot.getProject(created);
        if (!project) throw new Error(`The compiler did not open the TypeScript project ${displayPath(request.configPath)} for ${displayPath(options.root)}.`);
        this.syntheticProgram = created ?? this.syntheticProgram;
        const program = new CompatProgram(this, snapshot, project, synthetic?.unbuilt);
        this.held.set(program, request);
        return program;
      } catch (error) {
        // The snapshot takes its program with it; the resolver made for the program goes too, and the session keeps no id of a program that was not made.
        snapshot.dispose();
        if (synthetic) {
          disposeResolver(synthetic.resolver);
          this.referenceResolver = undefined;
          this.syntheticProgram = previousSynthetic;
        }
        throw error;
      }
    });
  }

  /**
   * Send one snapshot update, based on the newest snapshot. The newest snapshot stays alive until the next one exists, and
   * the one before it is disposed unless a held program uses it. An update that changes nothing returns its base.
   */
  private advance(api: API, changes: CreateSnapshotParams): Snapshot {
    const previous = this.latest;
    // TypeScript 7.1 rebuilds a program that a change made dirty only when the request asks for it; without this the
    // snapshot serves the previous program. The session keeps one project open, so every project is the requested one.
    const params: CreateSnapshotParams = { ...changes, ensurePrograms: true };
    if (snapshotRequestedChannel.hasSubscribers) snapshotRequestedChannel.publish({ request: changes });
    let snapshot: Snapshot;
    try {
      snapshot = previous === undefined ? api.createSnapshot(params) : previous.update(params);
    } finally {
      if (snapshotSettledChannel.hasSubscribers) snapshotSettledChannel.publish({ request: changes });
    }
    this.latest = snapshot;
    if (previous && previous !== snapshot && !this.heldBy(previous)) disposeSnapshot(previous);
    return snapshot;
  }

  /**
   * The compiler builds a project only from a configuration, so a requested root outside the configuration's own files (an
   * external model root, or a file that exists only as an overlay) needs a derived configuration. It extends the project's
   * own and lists exactly what the TypeScript 6 backend gives the compiler: the files the project's configuration parses to,
   * plus the requested roots. `include` is emptied so the list is the whole project. A program with no requested root still parses
   * the configuration here, so a configuration with errors fails the same way on both backends.
   */
  private withRequestedRoots(api: API, base: ProgramRequest, onInput: ((filename: string) => void) | undefined): ProgramRequest {
    const previous = this.overlays;
    this.setOverlays(base.overlays);
    this.observe(onInput, base.hidden);
    let parsed: { readonly fileNames: readonly string[]; readonly options: CompilerOptions };
    let referenced: ReferencedProject[];
    try {
      const result = api.parseConfigFile(base.configPath);
      assertConfigParsed(base.configPath, result.errors);
      parsed = result;
      referenced = referenceClosure(result.projectReferences ?? [], (configFile) => {
        const project = api.parseConfigFile(configFile);
        assertConfigParsed(configFile, project.errors);
        return project;
      }).map(({ configFile, parsed: project }) => ({ configFile, options: project.options as CompilerOptions, sources: new Set(project.fileNames.map(canonical)) }));
    } finally {
      this.setOverlays(previous);
    }
    if (referenced.length > 0) {
      const options = parsed.options as CompilerOptions;
      const unbuilt = new Set<string>();
      return { ...base, synthetic: { rootFiles: [...new Set([...parsed.fileNames.map(canonical), ...base.files])], compilerOptions: options, resolver: this.referenceResolverFor(api, options, referenced, unbuilt), unbuilt } };
    }
    if (base.files.length === 0) return base;
    const configPath = join(dirname(base.configPath), `${basename(base.configPath, '.json')}.roots.json`);
    const files = [...new Set([...parsed.fileNames.map(canonical), ...base.files])];
    const overlays = new Map(base.overlays);
    overlays.set(configPath, JSON.stringify({ extends: `./${basename(base.configPath)}`, files, include: [] }));
    return { configPath, files: base.files, overlays, hidden: new Set([...base.hidden, configPath]) };
  }

  /** Whether a held program reads this snapshot: an update that changes nothing may return its base, shared by two programs. */
  private heldBy(snapshot: Snapshot): boolean {
    return [...this.held.keys()].some((program) => program.snapshot === snapshot);
  }

  /** Called by a closing program. */
  release(program: CompatProgram): void {
    this.held.delete(program);
    if (program.snapshot !== this.latest && !this.heldBy(program.snapshot)) disposeSnapshot(program.snapshot);
    if (this.options.closeWhenIdle && this.held.size === 0) this.close();
  }

  /** Close the compiler process. A later program starts a new one unless the session is disposed. */
  close(): void {
    const api = this.api;
    const snapshots = [this.latest, ...[...this.held.keys()].map((program) => program.snapshot)];
    this.reset();
    for (const snapshot of snapshots) if (snapshot) disposeSnapshot(snapshot);
    if (api) closeCompiler(api);
  }

  [Symbol.dispose](): void {
    if (sessionDisposedChannel.hasSubscribers) sessionDisposedChannel.publish({ session: this });
    this.disposed = true;
    this.close();
  }

  /**
   * Run one compiler request. A reused compiler that exited is replaced once.
   * A failed configuration parse keeps a running compiler; any other failure
   * closes it, and the next request starts one compiler.
   */
  private withCompiler<T>(kind: 'parse' | 'snapshot', operation: (api: API, reused: boolean) => T): T {
    if (this.disposed) throw new Error('The TypeScript program session is closed.');
    const reused = this.api !== undefined;
    try {
      return operation(this.compiler(), reused);
    } catch (error) {
      const exited = compilerExited(error);
      const idle = this.options.closeWhenIdle === true && this.held.size === 0;
      if (kind === 'parse' && !exited && !this.callbackFailed && !idle) throw error;
      const replace = reused && exited && !this.callbackFailed;
      this.discard(error);
      if (!replace) throw error;
    }
    try {
      return operation(this.compiler(), false);
    } catch (error) {
      this.discard(error);
      throw error;
    }
  }

  private compiler(): API {
    if (this.api === undefined) {
      this.api = new API({ cwd: this.options.cwd, fs: this.fileSystem() });
      if (compilerStartedChannel.hasSubscribers) compilerStartedChannel.publish({ compiler: compilerProcess(this.api) });
    }
    return this.api;
  }

  private discard(error: unknown): void {
    try {
      this.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Opening the TypeScript project and closing its compiler failed.', { cause: error });
    }
  }

  private reset(): void {
    this.api = undefined;
    this.latest = undefined;
    this.resolvers.clear();
    this.callbackFailed = false;
    this.setOverlays(new Map());
    this.observed.clear();
    this.signatures.clear();
    this.listings.clear();
    this.fullRecordCount = 0;
    this.hinted.clear();
    this.openProjects.clear();
    this.held.clear();
    this.syntheticProgram = undefined;
    this.referenceResolver = undefined;
  }

  private setOverlays(overlays: ReadonlyMap<string, string>): void {
    this.overlays = overlays;
    this.overlayDirectories = new Set();
    for (const filename of overlays.keys()) {
      let directory = dirname(filename);
      while (!this.overlayDirectories.has(directory)) {
        this.overlayDirectories.add(directory);
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  }

  private observe(observer: ((filename: string) => void) | undefined, hidden: ReadonlySet<string>): void {
    this.observer = observer;
    this.hidden = hidden;
  }

  private report(filename: string): void {
    if (this.hidden.has(filename)) return;
    this.observed.add(filename);
    try {
      this.observer?.(filename);
    } catch (error) {
      this.callbackFailed = true;
      throw error;
    }
  }

  /**
   * Record a path the compiler touched, unless it is recorded. A callback is not evidence that the compiler holds the
   * current file: a read can leave a parsed configuration as it was, and a probe reads nothing. Refreshing the record
   * would hide an edit from the next snapshot, so only `commit` replaces a signature.
   */
  private recordSignature(filename: string): void {
    if (!this.signatures.has(filename)) this.signatures.set(filename, fileSignature(filename));
  }

  /** Overlays answer from memory; every other path goes to the disk (`serverFS.useOS`), as the compiler would read it. */
  private fileSystem(): FileSystemCallbacks {
    return {
      readFile: (fileName) => {
        const filename = canonical(fileName);
        this.report(filename);
        if (this.overlays.has(filename)) return this.overlays.get(filename)!;
        this.recordSignature(filename);
        return serverFS.useOS;
      },
      fileExists: (fileName) => {
        const filename = canonical(fileName);
        this.report(filename);
        if (this.overlays.has(filename)) return true;
        this.recordSignature(filename);
        return serverFS.useOS;
      },
      directoryExists: (directoryName) => {
        const directory = canonical(directoryName);
        this.report(directory);
        if (this.overlayDirectories.has(directory)) return true;
        this.recordSignature(directory);
        return serverFS.useOS;
      },
      getAccessibleEntries: (directoryName) => {
        const directory = canonical(directoryName);
        if (!this.listings.has(directory)) this.listings.set(directory, directoryEntries(directory));
        return serverFS.useOS;
      },
      realpath: serverFS.useOS,
      stat: serverFS.useOS,
      writeFile: serverFS.useOS,
      removeFile: serverFS.useOS,
    };
  }

  /** Files whose overlay or disk state differs from what the compiler last read. */
  private pendingChanges(overlays: ReadonlyMap<string, string>): PendingChanges {
    const changed = new Set<string>();
    const created = new Set<string>();
    const deleted = new Set<string>();
    const signatures = new Map<string, string>();
    const listings = new Map<string, string>();
    const classify = (filename: string, existed: boolean, exists: boolean): void => {
      if (existed && exists) changed.add(filename);
      else if (exists) created.add(filename);
      else if (existed) deleted.add(filename);
    };
    for (const filename of new Set([...this.overlays.keys(), ...overlays.keys()])) {
      const previous = this.overlays.get(filename);
      const next = overlays.get(filename);
      if (previous === next) continue;
      const onDisk = fileSignature(filename) !== MISSING;
      classify(filename, previous !== undefined || onDisk, next !== undefined || onDisk);
    }
    for (const [filename, signature] of this.signatures) {
      if (this.overlays.has(filename) || overlays.has(filename)) continue;
      const current = fileSignature(filename);
      if (current === signature) continue;
      signatures.set(filename, current);
      classify(filename, signature !== MISSING, current !== MISSING);
    }
    for (const [directory, listing] of this.listings) {
      const current = directoryEntries(directory);
      if (current === listing) continue;
      listings.set(directory, current);
      const before = new Set(listing.split('\0').filter(Boolean));
      const after = new Set(current.split('\0').filter(Boolean));
      for (const name of after) if (!before.has(name)) created.add(join(directory, name));
      for (const name of before) if (!after.has(name)) deleted.add(join(directory, name));
    }
    for (const filename of [...created, ...deleted]) changed.delete(filename);
    // An edit within the timestamp resolution leaves the signature as it was; the host's report still reaches the compiler.
    for (const filename of this.hinted) {
      const recorded = this.signatures.get(filename);
      if (recorded !== undefined && recorded !== MISSING && !created.has(filename) && !deleted.has(filename)) changed.add(filename);
    }
    const detected = new Set([...changed, ...created, ...deleted]);
    const resolution = [...detected].some(affectsResolution);
    const outgrown = this.observed.size > 2 * this.fullRecordCount + 256;
    return {
      ...(detected.size > 0 ? { changes: { changed: [...changed], created: [...created], deleted: [...deleted] } } : {}),
      full: resolution || outgrown,
      commit: () => {
        for (const [filename, signature] of signatures) this.signatures.set(filename, signature);
        for (const [directory, listing] of listings) this.listings.set(directory, listing);
      },
    };
  }
}

/** The seam's view of a parse: each referenced project by its tsconfig file. */
function projectOf(parsed: { readonly options: unknown; readonly fileNames: string[]; readonly projectReferences?: readonly { readonly path: string }[] }): ParsedProject {
  return { options: parsed.options as ParsedProject['options'], fileNames: parsed.fileNames, projectReferences: (parsed.projectReferences ?? []).map((reference) => ({ path: referencedConfigFile(reference.path) })) };
}

function nonEmpty<T>(values: readonly T[]): T[] | undefined {
  return values.length > 0 ? [...values] : undefined;
}

function replaceAll<T>(target: Set<T>, values: ReadonlySet<T>): void {
  target.clear();
  for (const value of values) target.add(value);
}

/** Open one program with its own compiler process, closed with the program. */
export function createProgramFromSources(options: OpenProgramOptions): Program {
  return new ProgramSession({ cwd: options.root, closeWhenIdle: true }).openProgram(options);
}
