/**
 * Type-aware TypeScript 7 surface for generators.
 *
 * TS 7's main `typescript` export is version-only. Analysis uses
 * `typescript/unstable/ast` plus `typescript/unstable/sync`. This module keeps
 * the previous checker-shaped API so model and Nest generators do not walk
 * schemas by hand.
 */

export * from 'typescript/unstable/ast';

import { ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve as resolvePath,
  sep,
} from 'node:path';
import * as ast from 'typescript/unstable/ast';
import {
  API,
  Checker,
  DiagnosticCategory,
  ElementFlags,
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
  type Diagnostic as SyncDiagnostic,
  type Signature as SyncSignature,
  type Type as SyncType,
} from 'typescript/unstable/sync';
import type { FileSystem } from 'typescript/unstable/fs';
import type { Node, SourceFile, TypeNode } from 'typescript/unstable/ast';

export {
  API,
  ElementFlags,
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

/** Checker-internal `CheckFlags` bits; the TypeScript 7 API exposes the number but no enum. */
export const CheckFlags = { Readonly: 1 << 3, Mapped: 1 << 18 } as const;

export type Type = CompatType;
export type Symbol = CompatSymbol;
export type Signature = CompatSignature;
export type GenericType = CompatType;
export type TypeReference = CompatType;
export type ObjectType = CompatType;
export type InterfaceType = CompatType;
export type StringLiteralType = CompatType & { readonly value: string };
export type NumberLiteralType = CompatType & { readonly value: number };
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

export interface CompatType {
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

export interface CompatSymbol {
  readonly flags: number;
  /** Checker-internal `CheckFlags` bits; see `readonlyPropertyNames`. */
  readonly checkFlags: number;
  readonly name: string;
  getName(): string;
  readonly valueDeclaration?: Node;
  readonly declarations: readonly Node[];
}

export interface CompatSignature {
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
          .filter((node): node is Node => node !== undefined);
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

class CompatChecker implements TypeChecker {
  public constructor(
    private readonly inner: Checker,
    readonly project: Project,
  ) {}

  getTypeChecker(): TypeChecker {
    return this;
  }

  getTypeFromTypeNode(node: TypeNode): CompatType {
    const type = this.inner.getTypeFromTypeNode(node) ?? this.inner.getUnknownType();
    return wrapType(type, this);
  }

  getTypeAtLocation(node: Node): CompatType {
    const type = this.inner.getTypeAtLocation(node) ?? this.inner.getUnknownType();
    return wrapType(type, this);
  }

  getSymbolAtLocation(node: Node): CompatSymbol | undefined {
    const symbol = this.inner.getSymbolAtLocation(node);
    const resolved = Array.isArray(symbol) ? symbol[0] : symbol;
    return resolved ? wrapSymbol(resolved, this) : undefined;
  }

  getAliasedSymbol(symbol: CompatSymbol): CompatSymbol {
    return wrapSymbol(this.inner.getAliasedSymbol(unwrapSymbol(symbol)), this);
  }

  getTypeOfSymbolAtLocation(symbol: CompatSymbol, location: Node): CompatType {
    return wrapType(this.inner.getTypeOfSymbolAtLocation(unwrapSymbol(symbol), location), this);
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
    const type = this.inner.getReturnTypeOfSignature(unwrapSignature(signature)) ?? this.inner.getUnknownType();
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
    return this.inner.isTypeAssignableTo(unwrapType(source), unwrapType(target));
  }

  isArrayType(type: CompatType): boolean {
    return this.inner.isArrayType(unwrapType(type));
  }

  isTupleType(type: CompatType): boolean {
    return this.inner.isTupleType(unwrapType(type));
  }

  typeToString(type: CompatType, enclosingDeclaration?: Node, flags?: number): string {
    return this.inner.typeToString(unwrapType(type), enclosingDeclaration, flags);
  }

  typeToTypeNode(type: CompatType, enclosingDeclaration?: Node, flags?: number): TypeNode | undefined {
    return this.inner.typeToTypeNode(unwrapType(type), enclosingDeclaration, flags);
  }

  getAnyType(): CompatType {
    return wrapType(this.inner.getAnyType(), this);
  }

  getStringType(): CompatType {
    return wrapType(this.inner.getStringType(), this);
  }

  getNumberType(): CompatType {
    return wrapType(this.inner.getNumberType(), this);
  }

  getBooleanType(): CompatType {
    return wrapType(this.inner.getBooleanType(), this);
  }

  getUnknownType(): CompatType {
    return wrapType(this.inner.getUnknownType(), this);
  }

  getNeverType(): CompatType {
    return wrapType(this.inner.getNeverType(), this);
  }

  getNullType(): CompatType {
    return wrapType(this.inner.getNullType(), this);
  }

  getUndefinedType(): CompatType {
    return wrapType(this.inner.getUndefinedType(), this);
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
    const key = kind === IndexKind.String ? this.inner.getStringType() : this.inner.getNumberType();
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
  ) {
    this.checker = new CompatChecker(project.checker, project);
  }

  getTypeChecker(): TypeChecker {
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

  getSourceFile(filename: string): SourceFile | undefined {
    return this.project.program.getSourceFile(filename);
  }

  getSourceFiles(): readonly SourceFile[] {
    return this.project.program.getSourceFileNames()
      .map((name) => this.project.program.getSourceFile(name))
      .filter((file): file is SourceFile => file !== undefined);
  }

  isSourceFileFromExternalLibrary(file: SourceFile): boolean {
    return this.project.program.isSourceFileFromExternalLibrary(file);
  }

  isSourceFileDefaultLibrary(file: SourceFile): boolean {
    return this.project.program.isSourceFileDefaultLibrary(file);
  }

  getCompilerOptions(): CompilerOptions {
    return this.project.compilerOptions;
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
}

function canonical(filename: string): string {
  return normalize(resolvePath(filename));
}

export const sys: ModuleResolutionHost & {
  useCaseSensitiveFileNames: boolean;
  getCurrentDirectory(): string;
  readDirectory(root: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[];
} = {
  useCaseSensitiveFileNames: process.platform !== 'win32',
  getCurrentDirectory: () => process.cwd(),
  fileExists: (filename) => existsSync(filename),
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
  readDirectory(root) {
    const found: string[] = [];
    const visit = (directory: string): void => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const filename = join(directory, entry.name);
        if (entry.isDirectory()) visit(filename);
        else found.push(filename);
      }
    };
    visit(root);
    return found;
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

function flattenDiagnosticMessageText(message: string | Diagnostic | undefined, _newLine = '\n'): string {
  if (message === undefined) return '';
  if (typeof message === 'string') return message;
  return message.text ?? flattenDiagnosticMessageText(message.messageText);
}

/** One-based line and column of a UTF-16 offset in `text`. */
function lineAndColumn(text: string, position: number): { readonly line: number; readonly column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(position, 0), text.length);
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

const DIAGNOSTIC_CATEGORY_NAMES: Readonly<Record<number, string>> = {
  [DiagnosticCategory.Warning]: 'warning',
  [DiagnosticCategory.Error]: 'error',
  [DiagnosticCategory.Suggestion]: 'suggestion',
  [DiagnosticCategory.Message]: 'message',
};

/** Format diagnostics as `path:line:col - error TS1234: message`, with chained messages indented below. */
export function formatDiagnosticsWithColorAndContext(
  diagnostics: readonly Diagnostic[] | readonly SyncDiagnostic[],
  host: { getCanonicalFileName(filename: string): string; getCurrentDirectory(): string; getNewLine(): string; readFile?(filename: string): string | undefined },
): string {
  const texts = new Map<string, string | undefined>();
  const sourceText = (fileName: string, file: SourceFile | undefined): string | undefined => {
    if (file?.text !== undefined) return file.text;
    if (!texts.has(fileName)) {
      // The host knows files that exist only in the program, such as a companion a run has not written.
      let text: string | undefined = host.readFile?.(fileName);
      if (text === undefined) {
        try {
          text = readFileSync(fileName, 'utf8');
        } catch {
          text = undefined;
        }
      }
      texts.set(fileName, text);
    }
    return texts.get(fileName);
  };
  const chain = (message: SyncDiagnostic, depth: number): string[] => (message.messageChain ?? [])
    .flatMap((next) => [`${'  '.repeat(depth)}${next.text}`, ...chain(next, depth + 1)]);
  return diagnostics.map((diagnostic) => {
    const record = diagnostic as Diagnostic & SyncDiagnostic & { file?: SourceFile };
    const text = record.text ?? flattenDiagnosticMessageText(record.messageText);
    const fileName = record.fileName ?? record.file?.fileName;
    const pos = record.pos ?? record.start ?? 0;
    let location = '';
    if (fileName) {
      const source = sourceText(fileName, record.file);
      const shown = host.getCanonicalFileName(fileName);
      if (source === undefined) {
        location = `${shown} - `;
      } else {
        const { line, column } = lineAndColumn(source, pos);
        location = `${shown}:${line}:${column} - `;
      }
    }
    const category = record.category === undefined ? 'error' : DIAGNOSTIC_CATEGORY_NAMES[record.category] ?? 'error';
    const code = record.code ? ` TS${record.code}` : '';
    return [`${location}${category}${code}: ${text}`, ...chain(record, 1)].join(host.getNewLine());
  }).join(host.getNewLine());
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

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.mjs', '.cjs', '.json'];
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx']);

function tryFile(host: ModuleResolutionHost, filename: string): string | undefined {
  if (host.fileExists(filename)) return canonical(filename);
  return undefined;
}

function sourceCandidates(filename: string): readonly string[] {
  const extension = extname(filename);
  if (!JS_EXTENSIONS.has(extension)) return [filename];
  const stem = filename.slice(0, -extension.length);
  return [
    filename,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}.d.ts`,
  ];
}

function firstExisting(host: ModuleResolutionHost, filenames: readonly string[]): string | undefined {
  for (const filename of filenames) {
    const match = tryFile(host, filename);
    if (match) return match;
  }
  return undefined;
}

function resolveRelative(moduleName: string, containingFile: string, host: ModuleResolutionHost): string | undefined {
  const base = resolvePath(dirname(containingFile), moduleName);
  const extension = extname(base);
  if (extension) {
    const match = firstExisting(host, sourceCandidates(base));
    if (match) return match;
    if (JS_EXTENSIONS.has(extension)) {
      const stem = base.slice(0, -extension.length);
      for (const sourceExtension of SOURCE_EXTENSIONS) {
        const nested = tryFile(host, join(stem, `index${sourceExtension}`));
        if (nested) return nested;
      }
    }
    return undefined;
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    const match = tryFile(host, base + sourceExtension);
    if (match) return match;
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    const match = tryFile(host, join(base, `index${sourceExtension}`));
    if (match) return match;
  }
  return undefined;
}

function importMapTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return importMapTarget(record.default) ?? importMapTarget(record.import);
}

function matchStarPattern(pattern: string, moduleName: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star < 0) return moduleName === pattern ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!moduleName.startsWith(prefix) || !moduleName.endsWith(suffix)) return undefined;
  return moduleName.slice(prefix.length, moduleName.length - suffix.length);
}

function applyStar(target: string, star: string): string {
  return target.replaceAll('*', star);
}

function resolveTsconfigPaths(
  moduleName: string,
  containingFile: string,
  compilerOptions: CompilerOptions,
  host: ModuleResolutionHost,
): string | undefined {
  const paths = (compilerOptions as CompilerOptions & { paths?: Record<string, string | readonly string[]> }).paths;
  if (!paths || typeof paths !== 'object') return undefined;
  let baseUrl = typeof (compilerOptions as { baseUrl?: string }).baseUrl === 'string'
    ? resolvePath((compilerOptions as { baseUrl: string }).baseUrl)
    : undefined;
  if (!baseUrl) {
    let current = dirname(containingFile);
    for (;;) {
      if (host.fileExists(join(current, 'tsconfig.json'))) {
        baseUrl = current;
        break;
      }
      const parent = dirname(current);
      if (parent === current) {
        baseUrl = dirname(containingFile);
        break;
      }
      current = parent;
    }
  }
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = matchStarPattern(pattern, moduleName);
    if (star === undefined) continue;
    const mapped = Array.isArray(targets) ? targets : [];
    for (const target of mapped) {
      if (typeof target !== 'string') continue;
      const candidate = resolvePath(baseUrl, applyStar(target, star));
      const match = firstExisting(host, sourceCandidates(candidate));
      if (match) return match;
    }
  }
  return undefined;
}

function resolveImportMap(
  moduleName: string,
  containingFile: string,
  host: ModuleResolutionHost,
): string | undefined {
  let current = dirname(containingFile);
  for (;;) {
    const manifest = join(current, 'package.json');
    if (host.fileExists(manifest)) {
      const text = host.readFile(manifest);
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          const imports = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { imports?: unknown }).imports
            : undefined;
          if (imports && typeof imports === 'object' && !Array.isArray(imports)) {
            const record = imports as Record<string, unknown>;
            const exact = importMapTarget(record[moduleName]);
            if (typeof exact === 'string') {
              const resolved = resolveRelative(exact, manifest, host);
              if (resolved) return resolved;
            }
            for (const [pattern, target] of Object.entries(record)) {
              const star = matchStarPattern(pattern, moduleName);
              if (star === undefined) continue;
              const mapped = importMapTarget(target);
              if (typeof mapped !== 'string') continue;
              const resolved = resolveRelative(applyStar(mapped, star), manifest, host);
              if (resolved) return resolved;
            }
          }
        } catch {
          // Keep walking toward the workspace root.
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolvePackage(moduleName: string, containingFile: string, host: ModuleResolutionHost): string | undefined {
  if (moduleName.startsWith('#')) {
    const mapped = resolveImportMap(moduleName, containingFile, host);
    if (mapped) return mapped;
  }
  try {
    const require = createRequire(containingFile);
    const resolved = require.resolve(moduleName);
    const mapped = firstExisting(host, sourceCandidates(resolved));
    if (mapped) return mapped;
  } catch {
    // Fall through to a directory walk for generated companions.
  }
  let current = dirname(containingFile);
  for (;;) {
    const candidate = join(current, 'node_modules', moduleName);
    for (const extension of SOURCE_EXTENSIONS) {
      const match = firstExisting(host, sourceCandidates(candidate + extension))
        ?? firstExisting(host, sourceCandidates(join(candidate, `index${extension}`)));
      if (match) return match;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveModuleName(
  moduleName: string,
  containingFile: string,
  compilerOptions: CompilerOptions,
  host: ModuleResolutionHost,
): { resolvedModule?: ResolvedModule } {
  const resolved = resolveTsconfigPaths(moduleName, containingFile, compilerOptions, host)
    ?? (moduleName.startsWith('.') || isAbsolute(moduleName)
      ? resolveRelative(moduleName, containingFile, host)
      : resolvePackage(moduleName, containingFile, host));
  if (!resolved) return {};
  return {
    resolvedModule: {
      resolvedFileName: resolved,
      isExternalLibraryImport: resolved.replace(/\\/g, '/').includes('/node_modules/'),
    },
  };
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
}

type UpdateSnapshotParams = NonNullable<Parameters<API['updateSnapshot']>[0]>;

const MISSING = 'missing';

function fileSignature(filename: string): string {
  try {
    const stat = statSync(filename, { throwIfNoEntry: false });
    if (!stat) return MISSING;
    return stat.isDirectory() ? 'directory' : `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    return MISSING;
  }
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

function programRequest(options: OpenProgramOptions): ProgramRequest {
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
  return { configPath: baseConfigPath, files: [...new Set(options.sources.map(canonical))], overlays, hidden };
}

/** The compiler process of an API, or undefined when this TypeScript build keeps it somewhere else. */
function compilerProcess(api: API): ChildProcess | undefined {
  const child: unknown = api['client']?.['channel']?.['child'];
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
  compilerProcess(api)?.kill('SIGKILL');
  api.close();
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
  private readonly openFiles = new Set<string>();
  private readonly held = new Map<CompatProgram, ProgramRequest>();
  /**
   * The newest snapshot stays alive until the next one exists. The server
   * reports changed files only against a live previous snapshot, and the
   * client otherwise carries its parsed files into the next snapshot (see the
   * "server change report" test in compiler-lifecycle.test.ts).
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
    for (const filename of filenames) this.hinted.add(canonical(filename));
  }

  /** Parse a project configuration with the session compiler. */
  parseConfigFile(configPath: string, onInput?: (filename: string) => void): { options: CompilerOptions; fileNames: string[] } {
    const parsed = this.withCompiler('parse', (api) => {
      this.observe(onInput, new Set());
      return api.parseConfigFile(configPath);
    });
    return { options: parsed.options as CompilerOptions, fileNames: parsed.fileNames };
  }

  /** Open a program in a new snapshot that reflects every file change since the previous one. */
  openProgram(options: OpenProgramOptions): Program {
    const base = programRequest(options);
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
      const projects = new Set([request.configPath]);
      const files = new Set(request.files);
      // Invalidating every file leaves a parsed configuration as it is, so its change is reported first.
      if (pending?.full && changes) this.advance(api, { fileChanges: changes });
      const snapshot = this.advance(api, {
        openProjects: this.openProjects.has(request.configPath) ? undefined : [request.configPath],
        closeProjects: nonEmpty([...this.openProjects].filter((project) => !projects.has(project))),
        openFiles: nonEmpty(request.files.filter((filename) => !this.openFiles.has(filename))),
        closeFiles: nonEmpty([...this.openFiles].filter((filename) => !files.has(filename))),
        fileChanges: pending?.full ? { invalidateAll: true } : changes,
      });
      pending?.commit();
      if (full) this.fullRecordCount = this.observed.size;
      this.hinted.clear();
      replaceAll(this.openProjects, projects);
      replaceAll(this.openFiles, files);
      try {
        // The project of the request's own configuration (the derived one when roots were added), so every run of a job
        // sees the same files. Another project would be the wrong program.
        const project = snapshot.getProject(request.configPath);
        if (!project) throw new Error(`The compiler did not open the TypeScript project ${request.configPath} for ${options.root}.`);
        const program = new CompatProgram(this, snapshot, project);
        this.held.set(program, request);
        return program;
      } catch (error) {
        snapshot.dispose();
        throw error;
      }
    });
  }

  /**
   * Send one snapshot update. The newest snapshot stays alive until the next one exists, and the one before it is
   * disposed unless a held program uses it.
   */
  private advance(api: API, params: UpdateSnapshotParams): Snapshot {
    const snapshot = api.updateSnapshot(params);
    const previous = this.latest;
    this.latest = snapshot;
    if (previous && ![...this.held.keys()].some((program) => program.snapshot === previous)) disposeSnapshot(previous);
    return snapshot;
  }

  /**
   * The compiler builds a project only from a configuration, so a requested root outside the configuration's own files (an
   * external model root, or a file that exists only as an overlay) needs a derived configuration. It extends the project's
   * own and lists exactly what the TypeScript 6 backend gives the compiler: the files the project's configuration parses to,
   * plus the requested roots. `include` is emptied so the list is the whole project.
   */
  private withRequestedRoots(api: API, base: ProgramRequest, onInput: ((filename: string) => void) | undefined): ProgramRequest {
    if (base.files.length === 0) return base;
    const previous = this.overlays;
    this.setOverlays(base.overlays);
    this.observe(onInput, base.hidden);
    let parsed: { readonly fileNames: readonly string[] };
    try {
      parsed = api.parseConfigFile(base.configPath);
    } finally {
      this.setOverlays(previous);
    }
    const configPath = join(dirname(base.configPath), `${basename(base.configPath, '.json')}.roots.json`);
    const files = [...new Set([...parsed.fileNames.map(canonical), ...base.files])];
    const overlays = new Map(base.overlays);
    overlays.set(configPath, JSON.stringify({ extends: `./${basename(base.configPath)}`, files, include: [] }));
    return { configPath, files: base.files, overlays, hidden: new Set([...base.hidden, configPath]) };
  }

  /** Called by a closing program. */
  release(program: CompatProgram): void {
    this.held.delete(program);
    if (program.snapshot !== this.latest) disposeSnapshot(program.snapshot);
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
    this.api ??= new API({ cwd: this.options.cwd, fs: this.fileSystem() });
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
    this.callbackFailed = false;
    this.setOverlays(new Map());
    this.observed.clear();
    this.signatures.clear();
    this.listings.clear();
    this.fullRecordCount = 0;
    this.hinted.clear();
    this.openProjects.clear();
    this.openFiles.clear();
    this.held.clear();
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

  private fileSystem(): FileSystem {
    return {
      readFile: (fileName) => {
        const filename = canonical(fileName);
        this.report(filename);
        if (this.overlays.has(filename)) return this.overlays.get(filename)!;
        this.recordSignature(filename);
        return undefined;
      },
      fileExists: (fileName) => {
        const filename = canonical(fileName);
        this.report(filename);
        if (this.overlays.has(filename)) return true;
        this.recordSignature(filename);
        return undefined;
      },
      directoryExists: (directoryName) => {
        const directory = canonical(directoryName);
        this.report(directory);
        if (this.overlayDirectories.has(directory)) return true;
        this.recordSignature(directory);
        return undefined;
      },
      getAccessibleEntries: (directoryName) => {
        const directory = canonical(directoryName);
        if (!this.listings.has(directory)) this.listings.set(directory, directoryEntries(directory));
        return undefined;
      },
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
