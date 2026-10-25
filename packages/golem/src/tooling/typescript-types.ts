// The TypeScript surface golem uses, declared by golem. Published declarations name these types and never a TypeScript
// package, so a project on any supported TypeScript compiles against golem without that compiler's own types.
// Each interface lists only the members golem reads; add a member when golem code starts reading it.

// Enum-like names: the type keeps the TypeScript name and stays a number, so `node.kind === ts.SyntaxKind.X` and
// flag arithmetic compile. The value side lives in TypeScriptBackend and carries the running compiler's own numbers.
export type SyntaxKind = number & { readonly __syntaxKind?: never };
export type NodeFlags = number & { readonly __nodeFlags?: never };
export type TypeFlags = number & { readonly __typeFlags?: never };
export type ObjectFlags = number & { readonly __objectFlags?: never };
export type SymbolFlags = number & { readonly __symbolFlags?: never };
export type ElementFlags = number & { readonly __elementFlags?: never };
export type NodeBuilderFlags = number & { readonly __nodeBuilderFlags?: never };
export type SignatureKind = number & { readonly __signatureKind?: never };
export type IndexKind = number & { readonly __indexKind?: never };
export type ModuleKind = number & { readonly __moduleKind?: never };
export type ModuleResolutionKind = number & { readonly __moduleResolutionKind?: never };
export type ScriptTarget = number & { readonly __scriptTarget?: never };

// Syntax tree

// Every node interface names its own syntax kind through a phantom brand, so the type guards narrow one node type from
// another even where their members overlap (an Identifier and a StringLiteral both read as `text`). The brand has no runtime
// property; the kind is still the compiler's number.
type KindOf<Name extends string> = SyntaxKind & { readonly __node: Name };

export interface Node {
  readonly kind: SyntaxKind;
  readonly flags: NodeFlags;
  readonly pos: number;
  readonly end: number;
  readonly parent: Node;
  getSourceFile(): SourceFile;
  getText(sourceFile?: SourceFile): string;
  getStart(sourceFile?: SourceFile): number;
}

/** The nodes of a list, such as call arguments; `pos` is the offset after the opening token. */
export interface NodeArray<T> extends ReadonlyArray<T> {
  readonly pos: number;
  readonly end: number;
}

export interface Expression extends Node {}
export interface TypeNode extends Node {}
export type Declaration = Node;
export type NamedDeclaration = Node & { readonly name?: Identifier };
export type PropertyName = Identifier | StringLiteral | NumericLiteral | ComputedPropertyName;
export type BindingName = Identifier | ObjectBindingPattern;
export type EntityName = Identifier | QualifiedName;
export type StringLiteralLike = StringLiteral | NoSubstitutionTemplateLiteral;

export interface SourceFile extends Node {
  readonly kind: KindOf<'SourceFile'>;
  readonly fileName: string;
  readonly text: string;
  readonly isDeclarationFile: boolean;
  /** The module format the program gives the file under Node16 and NodeNext resolution: CommonJS or ESNext. Undefined when the file has none. */
  readonly impliedNodeFormat?: ModuleKind | undefined;
  readonly statements: readonly Node[];
  getLineAndCharacterOfPosition(position: number): { readonly line: number; readonly character: number };
}

export interface Identifier extends Expression {
  readonly kind: KindOf<'Identifier'>;
  readonly text: string;
}
export interface QualifiedName extends Node {
  readonly kind: KindOf<'QualifiedName'>;
  readonly left: EntityName;
  readonly right: Identifier;
}
export interface StringLiteral extends Expression {
  readonly kind: KindOf<'StringLiteral'>;
  readonly text: string;
}
export interface NoSubstitutionTemplateLiteral extends Expression {
  readonly kind: KindOf<'NoSubstitutionTemplateLiteral'>;
  readonly text: string;
}
export interface NumericLiteral extends Expression {
  readonly kind: KindOf<'NumericLiteral'>;
  readonly text: string;
}
export interface ComputedPropertyName extends Node {
  readonly kind: KindOf<'ComputedPropertyName'>;
  readonly expression: Expression;
}
export interface BindingElement extends Node {
  readonly kind: KindOf<'BindingElement'>;
  readonly dotDotDotToken?: Node;
  readonly propertyName?: PropertyName;
  readonly name: BindingName;
}
export interface ObjectBindingPattern extends Node {
  readonly kind: KindOf<'ObjectBindingPattern'>;
  readonly elements: readonly BindingElement[];
}
export interface Decorator extends Node {
  readonly kind: KindOf<'Decorator'>;
  readonly expression: Expression;
}

// Expressions
export interface ArrayLiteralExpression extends Expression {
  readonly kind: KindOf<'ArrayLiteralExpression'>;
  readonly elements: readonly Expression[];
}
export interface ObjectLiteralExpression extends Expression {
  readonly kind: KindOf<'ObjectLiteralExpression'>;
  readonly properties: readonly ObjectLiteralElementLike[];
}
export type ObjectLiteralElementLike = PropertyAssignment | ShorthandPropertyAssignment | SpreadAssignment | MethodDeclaration;
export interface PropertyAssignment extends Node {
  readonly kind: KindOf<'PropertyAssignment'>;
  readonly name: PropertyName;
  readonly initializer: Expression;
}
export interface ShorthandPropertyAssignment extends Node {
  readonly kind: KindOf<'ShorthandPropertyAssignment'>;
  readonly name: Identifier;
}
export interface SpreadAssignment extends Node {
  readonly kind: KindOf<'SpreadAssignment'>;
  readonly expression: Expression;
}
export interface SpreadElement extends Expression {
  readonly kind: KindOf<'SpreadElement'>;
  readonly expression: Expression;
}
export interface OmittedExpression extends Expression {
  readonly kind: KindOf<'OmittedExpression'>;
}
export interface CallExpression extends Expression {
  readonly kind: KindOf<'CallExpression'>;
  readonly questionDotToken?: Node;
  readonly expression: Expression;
  readonly typeArguments?: NodeArray<TypeNode>;
  readonly arguments: NodeArray<Expression>;
}
export interface PropertyAccessExpression extends Expression {
  readonly kind: KindOf<'PropertyAccessExpression'>;
  readonly expression: Expression;
  readonly name: Identifier;
}
export interface ElementAccessExpression extends Expression {
  readonly kind: KindOf<'ElementAccessExpression'>;
  readonly expression: Expression;
  readonly argumentExpression: Expression;
}
export interface BinaryExpression extends Expression {
  readonly kind: KindOf<'BinaryExpression'>;
  readonly left: Expression;
  readonly operatorToken: Node;
  readonly right: Expression;
}
export interface PrefixUnaryExpression extends Expression {
  readonly kind: KindOf<'PrefixUnaryExpression'>;
  readonly operator: SyntaxKind;
  readonly operand: Expression;
}
export interface ParenthesizedExpression extends Expression {
  readonly kind: KindOf<'ParenthesizedExpression'>;
  readonly expression: Expression;
}
export interface AsExpression extends Expression {
  readonly kind: KindOf<'AsExpression'>;
  readonly expression: Expression;
}
export interface SatisfiesExpression extends Expression {
  readonly kind: KindOf<'SatisfiesExpression'>;
  readonly expression: Expression;
}
export interface NonNullExpression extends Expression {
  readonly kind: KindOf<'NonNullExpression'>;
  readonly expression: Expression;
}
export interface TypeAssertion extends Expression {
  readonly kind: KindOf<'TypeAssertion'>;
  readonly expression: Expression;
}
export interface TemplateExpression extends Expression {
  readonly kind: KindOf<'TemplateExpression'>;
  readonly head: { readonly text: string };
  readonly templateSpans: readonly { readonly expression: Expression; readonly literal: { readonly text: string } }[];
}
export interface ArrowFunction extends Expression, FunctionLikeDeclaration {
  readonly kind: KindOf<'ArrowFunction'>;
}
export interface FunctionExpression extends Expression, FunctionLikeDeclaration {
  readonly kind: KindOf<'FunctionExpression'>;
}

// Declarations
export interface ParameterDeclaration extends Node {
  readonly kind: KindOf<'ParameterDeclaration'>;
  readonly name: BindingName;
  readonly dotDotDotToken?: Node;
  readonly questionToken?: Node;
  readonly type?: TypeNode;
  readonly initializer?: Expression;
}
export interface TypeParameterDeclaration extends Node {
  readonly kind: KindOf<'TypeParameterDeclaration'>;
  readonly name: Identifier;
  readonly constraint?: TypeNode;
}
export interface FunctionLikeDeclaration extends Node {
  readonly kind: KindOf<'FunctionDeclaration' | 'MethodDeclaration' | 'ArrowFunction' | 'FunctionExpression'>;
  readonly modifiers?: readonly Node[];
  readonly parameters: readonly ParameterDeclaration[];
  readonly type?: TypeNode;
  readonly body?: Node;
}
export type SignatureDeclaration = FunctionLikeDeclaration;
export interface FunctionDeclaration extends FunctionLikeDeclaration {
  readonly kind: KindOf<'FunctionDeclaration'>;
  readonly name?: Identifier;
}
export interface MethodDeclaration extends FunctionLikeDeclaration {
  readonly kind: KindOf<'MethodDeclaration'>;
  readonly name: PropertyName;
}
export interface ExpressionWithTypeArguments extends Node {
  readonly kind: KindOf<'ExpressionWithTypeArguments'>;
  readonly expression: Expression;
  readonly typeArguments?: NodeArray<TypeNode>;
}
export interface HeritageClause extends Node {
  readonly kind: KindOf<'HeritageClause'>;
  readonly token: SyntaxKind;
  readonly types: readonly ExpressionWithTypeArguments[];
}
export interface ClassLikeDeclaration extends Node {
  readonly kind: KindOf<'ClassDeclaration' | 'ClassExpression'>;
  readonly modifiers?: readonly Node[];
  readonly name?: Identifier;
  readonly typeParameters?: readonly TypeParameterDeclaration[];
  readonly heritageClauses?: readonly HeritageClause[];
  readonly members: readonly Node[];
}
export interface ClassDeclaration extends ClassLikeDeclaration {
  readonly kind: KindOf<'ClassDeclaration'>;
}
export interface PropertyDeclaration extends Node {
  readonly kind: KindOf<'PropertyDeclaration'>;
  readonly name: PropertyName;
  readonly type?: TypeNode;
}
export interface PropertySignature extends Node {
  readonly kind: KindOf<'PropertySignature'>;
  readonly name: PropertyName;
  readonly type?: TypeNode;
}
export interface MethodSignature extends Node {
  readonly kind: KindOf<'MethodSignature'>;
}
export interface IndexSignatureDeclaration extends Node {
  readonly kind: KindOf<'IndexSignatureDeclaration'>;
  readonly type: TypeNode;
}
export interface InterfaceDeclaration extends Node {
  readonly kind: KindOf<'InterfaceDeclaration'>;
  readonly typeParameters?: readonly TypeParameterDeclaration[];
}
export interface TypeAliasDeclaration extends Node {
  readonly kind: KindOf<'TypeAliasDeclaration'>;
  readonly modifiers?: readonly Node[];
  readonly name: Identifier;
  readonly typeParameters?: readonly TypeParameterDeclaration[];
  readonly type: TypeNode;
}
export interface EnumDeclaration extends Node {
  readonly kind: KindOf<'EnumDeclaration'>;
  readonly members: readonly EnumMember[];
}
export interface EnumMember extends Node {
  readonly kind: KindOf<'EnumMember'>;
  readonly name: PropertyName;
}
export interface ModuleDeclaration extends Node {
  readonly kind: KindOf<'ModuleDeclaration'>;
  readonly name: Identifier | StringLiteral;
}
export interface VariableDeclaration extends Node {
  readonly kind: KindOf<'VariableDeclaration'>;
  readonly name: BindingName;
  readonly initializer?: Expression;
}
export interface VariableDeclarationList extends Node {
  readonly kind: KindOf<'VariableDeclarationList'>;
  readonly declarations: readonly VariableDeclaration[];
}
export interface VariableStatement extends Node {
  readonly kind: KindOf<'VariableStatement'>;
  readonly declarationList: VariableDeclarationList;
}
export interface Block extends Node {
  readonly kind: KindOf<'Block'>;
  readonly statements: readonly Node[];
}
export interface EmptyStatement extends Node {
  readonly kind: KindOf<'EmptyStatement'>;
}
export interface ReturnStatement extends Node {
  readonly kind: KindOf<'ReturnStatement'>;
  readonly expression?: Expression;
}

// Imports and exports
export interface ImportDeclaration extends Node {
  readonly kind: KindOf<'ImportDeclaration'>;
  readonly importClause?: ImportClause;
  readonly moduleSpecifier: Expression;
}
export interface ImportClause extends Node {
  readonly kind: KindOf<'ImportClause'>;
  /** TypeScript 6 reads `isTypeOnly`; TypeScript 7 has `phaseModifier` only (`TypeKeyword` for `import type`). */
  readonly isTypeOnly?: boolean;
  readonly phaseModifier?: SyntaxKind;
  readonly name?: Identifier;
  readonly namedBindings?: NamedImports | NamespaceImport;
}
export interface NamedImports extends Node {
  readonly kind: KindOf<'NamedImports'>;
  readonly elements: readonly ImportSpecifier[];
}
export interface ImportSpecifier extends Node {
  readonly kind: KindOf<'ImportSpecifier'>;
  readonly isTypeOnly: boolean;
  readonly propertyName?: Identifier;
  readonly name: Identifier;
}
export interface NamespaceImport extends Node {
  readonly kind: KindOf<'NamespaceImport'>;
  readonly name: Identifier;
}
export interface ImportEqualsDeclaration extends Node {
  readonly kind: KindOf<'ImportEqualsDeclaration'>;
}
export interface ExportDeclaration extends Node {
  readonly kind: KindOf<'ExportDeclaration'>;
  readonly exportClause?: NamedExports | NamespaceExport;
  readonly moduleSpecifier?: Expression;
}
export interface NamedExports extends Node {
  readonly kind: KindOf<'NamedExports'>;
  readonly elements: readonly ExportSpecifier[];
}
export interface ExportSpecifier extends Node {
  readonly kind: KindOf<'ExportSpecifier'>;
  readonly propertyName?: Identifier;
  readonly name: Identifier;
}
export interface NamespaceExport extends Node {
  readonly kind: KindOf<'NamespaceExport'>;
  readonly name: Identifier;
}
export interface ExportAssignment extends Node {
  readonly kind: KindOf<'ExportAssignment'>;
}

// Type nodes
export interface TypeReferenceNode extends TypeNode {
  readonly kind: KindOf<'TypeReferenceNode'>;
  readonly typeName: EntityName;
  readonly typeArguments?: readonly TypeNode[];
}
export interface TypeQueryNode extends TypeNode {
  readonly kind: KindOf<'TypeQueryNode'>;
  readonly exprName: EntityName;
  readonly typeArguments?: readonly TypeNode[];
}
export interface ArrayTypeNode extends TypeNode {
  readonly kind: KindOf<'ArrayTypeNode'>;
  readonly elementType: TypeNode;
}
export interface TupleTypeNode extends TypeNode {
  readonly kind: KindOf<'TupleTypeNode'>;
  readonly elements: readonly TypeNode[];
}
export interface NamedTupleMember extends TypeNode {
  readonly kind: KindOf<'NamedTupleMember'>;
  readonly dotDotDotToken?: Node;
  readonly type: TypeNode;
}
export interface OptionalTypeNode extends TypeNode {
  readonly kind: KindOf<'OptionalTypeNode'>;
  readonly type: TypeNode;
}
export interface RestTypeNode extends TypeNode {
  readonly kind: KindOf<'RestTypeNode'>;
  readonly type: TypeNode;
}
export interface UnionTypeNode extends TypeNode {
  readonly kind: KindOf<'UnionTypeNode'>;
  readonly types: readonly TypeNode[];
}
export interface IntersectionTypeNode extends TypeNode {
  readonly kind: KindOf<'IntersectionTypeNode'>;
  readonly types: readonly TypeNode[];
}
export interface ParenthesizedTypeNode extends TypeNode {
  readonly kind: KindOf<'ParenthesizedTypeNode'>;
  readonly type: TypeNode;
}
export interface TypeOperatorNode extends TypeNode {
  readonly kind: KindOf<'TypeOperatorNode'>;
  readonly operator: SyntaxKind;
  readonly type: TypeNode;
}
export interface LiteralTypeNode extends TypeNode {
  readonly kind: KindOf<'LiteralTypeNode'>;
  readonly literal: Node;
}
/** `import("x").T` and `typeof import("x")`: the argument is a literal type that holds the specifier. */
export interface ImportTypeNode extends TypeNode {
  readonly kind: KindOf<'ImportTypeNode'>;
  readonly argument: TypeNode;
}
export interface TypeLiteralNode extends TypeNode {
  readonly kind: KindOf<'TypeLiteralNode'>;
  readonly members: readonly Node[];
}
export interface MappedTypeNode extends TypeNode {
  readonly kind: KindOf<'MappedTypeNode'>;
  readonly typeParameter: TypeParameterDeclaration;
  readonly type?: TypeNode;
}
export interface ConditionalTypeNode extends TypeNode {
  readonly kind: KindOf<'ConditionalTypeNode'>;
  readonly checkType: TypeNode;
  readonly trueType: TypeNode;
  readonly falseType: TypeNode;
}
export interface IndexedAccessTypeNode extends TypeNode {
  readonly kind: KindOf<'IndexedAccessTypeNode'>;
  readonly objectType: TypeNode;
}
export interface TemplateLiteralTypeNode extends TypeNode {
  readonly kind: KindOf<'TemplateLiteralTypeNode'>;
  readonly head: { readonly text: string };
  readonly templateSpans: readonly { readonly type: TypeNode; readonly literal: { readonly text: string } }[];
}

// Types, symbols and signatures from the checker
export interface Type {
  readonly flags: TypeFlags;
  readonly objectFlags: ObjectFlags;
  readonly aliasTypeArguments?: readonly Type[];
  isUnion(): boolean;
  isIntersection(): boolean;
  readonly types: readonly Type[];
  readonly aliasSymbol?: Symbol;
  readonly symbol?: Symbol;
  readonly elementFlags?: readonly ElementFlags[];
  getCallSignatures(): readonly Signature[];
  getConstructSignatures(): readonly Signature[];
  getProperty(name: string): Symbol | undefined;
  getSymbol(): Symbol | undefined;
}
export type TypeReference = Type;
export type ObjectType = Type;
export type InterfaceType = Type;
export type StringLiteralType = Type & { readonly value: string };
export type NumberLiteralType = Type & { readonly value: number };

export interface Symbol {
  readonly flags: SymbolFlags;
  readonly checkFlags: number;
  readonly name: string;
  getName(): string;
  readonly valueDeclaration?: Node;
  readonly declarations: readonly Node[];
}

export interface Signature {
  readonly parameters: readonly Symbol[];
  readonly declaration?: Node;
  getReturnType(): Type;
}

export interface TypeChecker {
  /**
   * The module an import of a file of the checker's program resolved to, as the compiler resolved it for the program, or undefined when
   * it resolved to none. `virtualFiles` are files that do not exist yet but will (the companions a job is about to write): when the
   * compiler found none, a second lookup counts them. A package.json that is not JSON throws an error that names it.
   */
  resolveImport(specifier: StringLiteralLike, virtualFiles?: ReadonlySet<string>): ResolvedModule | undefined;
  getTypeFromTypeNode(node: TypeNode): Type;
  getTypeAtLocation(node: Node): Type;
  getSymbolAtLocation(node: Node): Symbol | undefined;
  getAliasedSymbol(symbol: Symbol): Symbol;
  getTypeOfSymbolAtLocation(symbol: Symbol, location: Node): Type;
  getPropertiesOfType(type: Type): readonly Symbol[];
  getPropertyOfType(type: Type, name: string): Symbol | undefined;
  getSignaturesOfType(type: Type, kind: SignatureKind): readonly Signature[];
  getReturnTypeOfSignature(signature: Signature): Type;
  getTypeArguments(type: Type): readonly Type[];
  isTypeAssignableTo(source: Type, target: Type): boolean;
  isArrayType(type: Type): boolean;
  isTupleType(type: Type): boolean;
  typeToString(type: Type, enclosingDeclaration?: Node, flags?: number): string;
  typeToTypeNode(type: Type, enclosingDeclaration?: Node, flags?: number): TypeNode | undefined;
  getAnyType(): Type;
  getStringType(): Type;
  getNumberType(): Type;
  getBooleanType(): Type;
  getUnknownType(): Type;
  getExportsOfModule(symbol: Symbol): readonly Symbol[];
  tryGetMemberInModuleExports(name: string, moduleSymbol: Symbol): Symbol | undefined;
  getRootSymbols(symbol: Symbol): readonly Symbol[];
  getIndexTypeOfType(type: Type, kind: IndexKind): Type | undefined;
  getIndexInfosOfType(type: Type): readonly { readonly keyType: Type; readonly valueType: Type }[];
  getBaseTypes(type: Type): readonly Type[];
  getDeclaredTypeOfSymbol(symbol: Symbol): Type;
  getConstantValue(node: Node): string | number | undefined;
  getSignatureFromDeclaration(node: Node): Signature | undefined;
}

// Programs and compiler hosts
export interface CompilerOptions {
  readonly [option: string]: unknown;
}

export interface Diagnostic {
  readonly text?: string;
  /** The TypeScript error number, such as 2304. */
  readonly code?: number;
  /** Where the diagnostic starts in its file. */
  readonly pos?: number;
  /** The file the diagnostic is about; absent for a diagnostic about the program as a whole. */
  readonly fileName?: string;
}

export interface ModuleResolutionHost {
  fileExists(filename: string): boolean;
  readFile(filename: string): string | undefined;
}

export type CompilerHost = ModuleResolutionHost;

export interface ResolvedModule {
  readonly resolvedFileName: string;
}

export interface Program extends Disposable {
  close(): void;
  getTypeChecker(): TypeChecker;
  getSourceFile(filename: string): SourceFile | undefined;
  getSourceFiles(): readonly SourceFile[];
  isSourceFileFromExternalLibrary(file: SourceFile): boolean;
  isSourceFileDefaultLibrary(file: SourceFile): boolean;
  getCompilerOptions(): CompilerOptions;
  /** The parse errors of one file, read without a type check. */
  getSyntacticDiagnostics(filename: string): readonly Diagnostic[];
  /** The type errors of one file, found by checking that file. */
  getSemanticDiagnostics(filename: string): readonly Diagnostic[];
  readonly session: ProgramSession;
}

export interface OpenProgramOptions {
  readonly root: string;
  readonly sources: readonly string[];
  readonly configFile?: string;
  readonly overlays?: ReadonlyMap<string, string>;
  readonly onInput?: (filename: string) => void;
}

export interface ProgramSessionOptions {
  readonly cwd: string;
  readonly closeWhenIdle?: boolean;
}

export interface ProgramSession extends Disposable {
  inputsChanged(filenames: Iterable<string>): void;
  parseConfigFile(configPath: string, onInput?: (filename: string) => void): { options: CompilerOptions; fileNames: string[] };
  openProgram(options: OpenProgramOptions): Program;
  /** Parse one source text on its own, without a program: its syntax tree, with no types and no diagnostics. */
  parseSourceFile(filename: string, text: string): SourceFile;
  /** Resolve a module name that no program imports, such as one an SDK manifest names, as the compiler resolves an import of `containingFile`: the disk and `virtualFiles` count. */
  resolveModuleName(moduleName: string, containingFile: string, compilerOptions: CompilerOptions, resolutionMode?: ModuleKind, virtualFiles?: ReadonlySet<string>): { resolvedModule?: ResolvedModule };
}

// The runtime values of the seam, as the facade destructures them. The value `X` of an enum-like name carries the
// members golem reads; the type `X` above is the number those members hold.
export interface TypeScriptBackend {
  readonly SyntaxKind: {
    readonly ExportKeyword: SyntaxKind;
    readonly ExtendsKeyword: SyntaxKind;
    readonly FalseKeyword: SyntaxKind;
    readonly ImportKeyword: SyntaxKind;
    readonly MinusToken: SyntaxKind;
    readonly NullKeyword: SyntaxKind;
    readonly PlusToken: SyntaxKind;
    readonly ReadonlyKeyword: SyntaxKind;
    readonly StaticKeyword: SyntaxKind;
    readonly ThisKeyword: SyntaxKind;
    readonly TrueKeyword: SyntaxKind;
    readonly TypeKeyword: SyntaxKind;
  };
  readonly TypeFlags: {
    readonly Any: TypeFlags;
    readonly BigInt: TypeFlags;
    readonly BigIntLike: TypeFlags;
    readonly Boolean: TypeFlags;
    readonly BooleanLike: TypeFlags;
    readonly BooleanLiteral: TypeFlags;
    readonly Never: TypeFlags;
    readonly Null: TypeFlags;
    readonly Number: TypeFlags;
    readonly NumberLike: TypeFlags;
    readonly NumberLiteral: TypeFlags;
    readonly Object: TypeFlags;
    readonly String: TypeFlags;
    readonly StringLike: TypeFlags;
    readonly StringLiteral: TypeFlags;
    readonly TemplateLiteral: TypeFlags;
    readonly TypeParameter: TypeFlags;
    readonly Undefined: TypeFlags;
    readonly Unknown: TypeFlags;
    readonly Void: TypeFlags;
  };
  readonly SymbolFlags: {
    readonly Alias: SymbolFlags;
    readonly Class: SymbolFlags;
    readonly Enum: SymbolFlags;
    readonly Method: SymbolFlags;
    readonly Optional: SymbolFlags;
    readonly Transient: SymbolFlags;
    readonly Value: SymbolFlags;
  };
  readonly ElementFlags: {
    readonly Optional: ElementFlags;
    readonly Rest: ElementFlags;
    readonly Variadic: ElementFlags;
  };
  readonly ObjectFlags: { readonly Mapped: ObjectFlags };
  readonly NodeFlags: { readonly Const: NodeFlags };
  readonly NodeBuilderFlags: { readonly NoTruncation: NodeBuilderFlags };
  readonly SignatureKind: { readonly Call: SignatureKind };
  readonly IndexKind: { readonly String: IndexKind };
  readonly ModuleKind: { readonly NodeNext: ModuleKind };
  readonly ModuleResolutionKind: { readonly NodeNext: ModuleResolutionKind };
  readonly ScriptTarget: { readonly ES2022: ScriptTarget };
  readonly CheckFlags: { readonly Readonly: number; readonly Mapped: number };
  readonly ProgramSession: { new (options: ProgramSessionOptions): ProgramSession };
  readonly sys: ModuleResolutionHost;
  canHaveDecorators(node: Node): boolean;
  canHaveModifiers(node: Node): boolean;
  createCompilerHost(options?: CompilerOptions, setParentNodes?: boolean): CompilerHost;
  createProgramFromSources(options: OpenProgramOptions): Program;
  findConfigFile(searchPath: string, fileExists: (filename: string) => boolean, configName?: string): string | undefined;
  forEachChild<T>(node: Node, callback: (node: Node) => T | undefined): T | undefined;
  /** The compiler's plain form, `path(line,col): error TS1234: message`, one line each with chained messages indented below. */
  formatDiagnostics(
    diagnostics: readonly Diagnostic[],
    host: { getCanonicalFileName(filename: string): string; getCurrentDirectory(): string; getNewLine(): string },
  ): string;
  getDecorators(node: Node): readonly Decorator[] | undefined;
  getModifiers(node: Node): readonly Node[] | undefined;
  getPreEmitDiagnostics(program: Program): readonly Diagnostic[];
  /** TypeScript 7 names a type parameter's default `defaultType`; TypeScript 6 names it `default`. */
  typeParameterDefault(parameter: TypeParameterDeclaration): TypeNode | undefined;
  /** The generic target of a type reference (e.g. the tuple target of a tuple type). */
  typeReferenceTarget(type: Type): Type | undefined;
  isArrayLiteralExpression(node: Node): node is ArrayLiteralExpression;
  isArrayTypeNode(node: Node): node is ArrayTypeNode;
  isArrowFunction(node: Node): node is ArrowFunction;
  isAsExpression(node: Node): node is AsExpression;
  isBinaryExpression(node: Node): node is BinaryExpression;
  isBlock(node: Node): node is Block;
  isCallExpression(node: Node): node is CallExpression;
  isClassDeclaration(node: Node): node is ClassDeclaration;
  isClassLike(node: Node): node is ClassLikeDeclaration;
  isComputedPropertyName(node: Node): node is ComputedPropertyName;
  isConditionalTypeNode(node: Node): node is ConditionalTypeNode;
  isDecorator(node: Node): node is Decorator;
  isElementAccessExpression(node: Node): node is ElementAccessExpression;
  isEmptyStatement(node: Node): node is EmptyStatement;
  isEnumDeclaration(node: Node): node is EnumDeclaration;
  isEnumMember(node: Node): node is EnumMember;
  isExportAssignment(node: Node): node is ExportAssignment;
  isExportDeclaration(node: Node): node is ExportDeclaration;
  isExportSpecifier(node: Node): node is ExportSpecifier;
  isExpression(node: Node): node is Expression;
  isExpressionWithTypeArguments(node: Node): node is ExpressionWithTypeArguments;
  isFunctionDeclaration(node: Node): node is FunctionDeclaration;
  isFunctionExpression(node: Node): node is FunctionExpression;
  isFunctionLike(node: Node): node is FunctionLikeDeclaration;
  isIdentifier(node: Node): node is Identifier;
  isImportClause(node: Node): node is ImportClause;
  isImportDeclaration(node: Node): node is ImportDeclaration;
  isImportEqualsDeclaration(node: Node): node is ImportEqualsDeclaration;
  isImportSpecifier(node: Node): node is ImportSpecifier;
  isImportTypeNode(node: Node): node is ImportTypeNode;
  isIndexSignatureDeclaration(node: Node): node is IndexSignatureDeclaration;
  isIndexedAccessTypeNode(node: Node): node is IndexedAccessTypeNode;
  isInterfaceDeclaration(node: Node): node is InterfaceDeclaration;
  isIntersectionTypeNode(node: Node): node is IntersectionTypeNode;
  isLiteralTypeNode(node: Node): node is LiteralTypeNode;
  isMappedTypeNode(node: Node): node is MappedTypeNode;
  isMethodDeclaration(node: Node): node is MethodDeclaration;
  isMethodSignature(node: Node): node is MethodSignature;
  isModuleDeclaration(node: Node): node is ModuleDeclaration;
  isNamedExports(node: Node): node is NamedExports;
  isNamedImports(node: Node): node is NamedImports;
  isNamedTupleMember(node: Node): node is NamedTupleMember;
  isNamespaceExport(node: Node): node is NamespaceExport;
  isNamespaceImport(node: Node): node is NamespaceImport;
  isNoSubstitutionTemplateLiteral(node: Node): node is NoSubstitutionTemplateLiteral;
  isNonNullExpression(node: Node): node is NonNullExpression;
  isNumericLiteral(node: Node): node is NumericLiteral;
  isObjectBindingPattern(node: Node): node is ObjectBindingPattern;
  isObjectLiteralExpression(node: Node): node is ObjectLiteralExpression;
  isOmittedExpression(node: Node): node is OmittedExpression;
  isOptionalTypeNode(node: Node): node is OptionalTypeNode;
  isParameter(node: Node): node is ParameterDeclaration;
  isParenthesizedExpression(node: Node): node is ParenthesizedExpression;
  isParenthesizedTypeNode(node: Node): node is ParenthesizedTypeNode;
  isPrefixUnaryExpression(node: Node): node is PrefixUnaryExpression;
  isPropertyAccessExpression(node: Node): node is PropertyAccessExpression;
  isPropertyAssignment(node: Node): node is PropertyAssignment;
  isPropertyDeclaration(node: Node): node is PropertyDeclaration;
  isPropertySignature(node: Node): node is PropertySignature;
  isQualifiedName(node: Node): node is QualifiedName;
  isRestTypeNode(node: Node): node is RestTypeNode;
  isReturnStatement(node: Node): node is ReturnStatement;
  isSatisfiesExpression(node: Node): node is SatisfiesExpression;
  isShorthandPropertyAssignment(node: Node): node is ShorthandPropertyAssignment;
  isSourceFile(node: Node): node is SourceFile;
  isSpreadAssignment(node: Node): node is SpreadAssignment;
  isSpreadElement(node: Node): node is SpreadElement;
  isStringLiteral(node: Node): node is StringLiteral;
  isStringLiteralLike(node: Node): node is StringLiteralLike;
  isTemplateExpression(node: Node): node is TemplateExpression;
  isTemplateLiteralTypeNode(node: Node): node is TemplateLiteralTypeNode;
  isTupleTypeNode(node: Node): node is TupleTypeNode;
  isTypeAliasDeclaration(node: Node): node is TypeAliasDeclaration;
  isTypeAssertionExpression(node: Node): node is TypeAssertion;
  isTypeLiteralNode(node: Node): node is TypeLiteralNode;
  isTypeNode(node: Node): node is TypeNode;
  isTypeOperatorNode(node: Node): node is TypeOperatorNode;
  isTypeParameterDeclaration(node: Node): node is TypeParameterDeclaration;
  isTypeQueryNode(node: Node): node is TypeQueryNode;
  isTypeReferenceNode(node: Node): node is TypeReferenceNode;
  isUnionTypeNode(node: Node): node is UnionTypeNode;
  isVariableDeclaration(node: Node): node is VariableDeclaration;
  isVariableDeclarationList(node: Node): node is VariableDeclarationList;
  isVariableStatement(node: Node): node is VariableStatement;
}
