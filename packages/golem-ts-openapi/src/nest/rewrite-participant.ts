// The rewrite participant of the nest extension (the extension entry `./nest-extension`). Core runs it for each source file when a ts-openapi block turns on
// `extensions: { nest: {} }`, in golem check, golem build, Vite, esbuild and the Node loader alike. It stamps the codec of a `@Body()` or `@Query()` parameter
// and of a return, and reports the inputs that `NestModelInterceptor` would reject. It uses the TypeScript seam that core passes and never picks TypeScript itself.
import type { CodecDataParticipant } from '@exprtlabs/golem-model/plan';
import type * as ts from '@exprtlabs/golem/internal/ts';
import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import type { GolemDiagnostic, GolemExtension, RewriteCore, RewriteParticipantInput, RewriteParticipantResult } from '@exprtlabs/golem/generator-api';
import { REWRITE_IMPORT_PREFIX, type RewriteEdit } from '@exprtlabs/golem/rewrite';
import { arrayItemNode, authoredUnionMembers, decoratorIdentity, isDiscriminatorTag, modelDeclarationKind, propertyType, readTags, resolvedSymbolAt, serdeTypeName, staticDecoratorKey } from '@exprtlabs/golem/internal/type-analysis';
import { NEST_COMMON, OWN_PACKAGE } from './packages.js';
import { nodeQueryFields } from './query-fields.js';

type TypeScript = typeof ts;
type DiscriminatorValue = string | number | boolean;

/** The module that exports the decorators the stamps name. */
const NEST_MODULE = '@exprtlabs/golem-ts-openapi/internal/nest-runtime';
const NEST_PARAMETER_DECORATORS: readonly string[] = ['Body', 'Query'];
const NEST_CODEC_DECORATOR = 'nestModelCodec';
const NEST_UNION_DECORATOR = 'nestModelUnion';
const NEST_RETURN_DECORATOR = 'nestModelReturn';
/** Type names a nest parameter or return never carries a model codec for. */
const NEST_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'void', 'undefined', 'null', 'never', 'any', 'unknown', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol',
  'Date', 'Buffer', 'Blob', 'Promise', 'Array', 'Record', 'Map', 'Set',
]);

const CODE_NEST_NO_CODEC = 'RUNM1071';
/** A `@Body()` or `@Query()` parameter, whole or one field, whose type is no golem model, which `NestModelInterceptor` rejects on each request. An error unless `nonModelInputs: warn` is set. */
const CODE_NEST_NOT_A_MODEL = 'RUNM1081';

/** What the helpers of one file share: the TypeScript seam of core, the checker, the helpers core lends and the file in hand. */
interface Scope {
  readonly ts: TypeScript;
  readonly checker: ts.TypeChecker;
  readonly core: RewriteCore;
  readonly root: string;
  readonly file: ts.SourceFile;
}

function insertion(at: number, text: string): RewriteEdit {
  return { start: at, end: at, expect: '', text };
}

/** Whether the name is `name` or a qualified spelling of it, such as `globalThis.Array`. */
function isNamed(ts: TypeScript, typeName: ts.EntityName, ...names: readonly string[]): boolean {
  return names.includes(ts.isIdentifier(typeName) ? typeName.text : typeName.right.text);
}

/**
 * The model of a parameter or return type and whether it is an array of it, through parentheses, `readonly`, and one
 * `T[]`, `Array<T>` or `ReadonlyArray<T>`; `Promise<T>` too for a return. Nested arrays have no model. A return union has
 * none either; a parameter union stays one type, which `nestBinding` binds when its members are golem models with a tag.
 */
function nestModelType(ts: TypeScript, typeNode: ts.TypeNode, forReturn: boolean): { readonly model: ts.TypeNode; readonly array: boolean } | undefined {
  let node = typeNode;
  let array = false;
  for (;;) {
    const item = arrayItemNode(node);
    if (item !== undefined) {
      if (array) return undefined;
      array = true;
      node = item;
    } else if (ts.isParenthesizedTypeNode(node)) node = node.type;
    else if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) node = node.type;
    else if (ts.isTypeOperatorNode(node) || ts.isUnionTypeNode(node)) return forReturn ? undefined : { model: node, array };
    else if (forReturn && ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1 && isNamed(ts, node.typeName, 'Promise')) node = node.typeArguments[0];
    else return { model: node, array };
  }
}

/** The `@Body()` or `@Query()` of NestJS that a parameter carries, found by the symbol it resolves to: an aliased or re-exported import is found, a local decorator of the same name is not. */
function nestParameterDecorator({ ts, checker }: Scope, parameter: ts.ParameterDeclaration): { readonly node: ts.Decorator; readonly name: string } | undefined {
  for (const node of ts.getDecorators(parameter) ?? []) {
    const { name, packageName } = decoratorIdentity(checker, node, [NEST_COMMON]);
    if (packageName === NEST_COMMON && name !== undefined && NEST_PARAMETER_DECORATORS.includes(name)) return { node, name };
  }
  return undefined;
}

/** Whether the node carries the decorator `name` of this package, plainly or under an alias; a decorator of that name from another package is not it. */
function hasDecorator({ ts, checker }: Scope, node: ts.Node, name: string): boolean {
  return (ts.getDecorators(node) ?? []).some((decorator) => {
    const identity = decoratorIdentity(checker, decorator, [OWN_PACKAGE]);
    return identity.name === name && identity.packageName === OWN_PACKAGE;
  });
}

interface NestBinding {
  readonly id: string;
  readonly primitive: boolean;
  /** The type is a golem model, so one that binds to no id is an error rather than a plain class. */
  readonly golemModel: boolean;
  /** The model type as written, array wrappers removed. */
  readonly label: string;
  /** The type is an array of the model. */
  readonly array: boolean;
  /** The type name of the model, when it has one. */
  readonly name?: ts.EntityName;
  /** The model is a class that is the default export of its file, which golem cannot key. */
  readonly defaultExport?: boolean;
  /** The type is a union of golem models that no declared tag tells apart: it names why, and the fix. */
  readonly unionFault?: readonly [reason: string, advice: string];
  /** The type is a union of golem models that its declared `Discriminator` tag tells apart; its `id` joins the ids of the members. */
  readonly union?: NestUnion;
}

/** A union of golem models and the property whose literal value picks the member. */
interface NestUnion {
  readonly property: string;
  readonly variants: readonly { readonly values: readonly DiscriminatorValue[]; readonly id: string; readonly name: ts.EntityName }[];
}

/** The values of a literal type or a union of literals; undefined for any other type. */
function literalTagValues({ ts, checker }: Scope, type: ts.Type): DiscriminatorValue[] | undefined {
  const members = type.isUnion() ? type.types : [type];
  const values: DiscriminatorValue[] = [];
  for (const member of members) {
    if ((member.flags & ts.TypeFlags.StringLiteral) !== 0) values.push((member as ts.StringLiteralType).value);
    else if ((member.flags & ts.TypeFlags.NumberLiteral) !== 0) values.push((member as ts.NumberLiteralType).value);
    else if ((member.flags & ts.TypeFlags.BooleanLiteral) !== 0) values.push(checker.typeToString(member) === 'true');
    else return undefined;
  }
  return values.length === 0 ? undefined : values;
}

/** A `Discriminator` tag golem cannot read, such as a key that is no string literal. */
class TagReadFault extends Error {}

/**
 * The tag that tells the members of a union apart: the key of the `Discriminator` tag written on the union type (written out or through an alias),
 * and the literal values that each member requires for that key. Golem never looks for a key in the members. A query tag is text, so `text` makes
 * `1` and `'1'` one value.
 */
function unionTag(
  scope: Scope,
  model: ts.TypeNode,
  members: readonly ts.TypeNode[],
  text: boolean,
): { readonly property: string; readonly values: readonly (readonly DiscriminatorValue[])[] } | { readonly fault: readonly [reason: string, advice: string] } {
  const { ts, root, checker, file } = scope;
  let declared;
  try {
    declared = readTags({ checker, sourceFile: file, identityRoot: root, diagnostic: (_node, _code, message) => new TagReadFault(message) }, model).metadata;
  } catch (error) {
    if (!(error instanceof TagReadFault)) throw error;
    return { fault: ['has a Discriminator tag that golem cannot read', error.message] };
  }
  const property = declared.discriminator;
  if (property === undefined) {
    return { fault: ['is a union of golem models with no declared tag', "Declare the tag key on the union: (A | B) & Discriminator<'kind'>, and give each model a required literal field kind with a value of its own, such as kind: 'circle'. Or bind one field of a model type."] };
  }
  if (declared.discriminatorDefault !== undefined) {
    return { fault: [`declares a default variant with Discriminator<'${property}', ...>, which NestModelInterceptor does not pick`, `Remove the default type from the tag, or bind one model.`] };
  }
  const owners = new Map<DiscriminatorValue | string, string>();
  const values: DiscriminatorValue[][] = [];
  for (const member of members) {
    const name = member.getText(file);
    const symbol = checker.getPropertyOfType(checker.getTypeFromTypeNode(member), property);
    const own = symbol && (symbol.flags & ts.SymbolFlags.Optional) === 0 ? literalTagValues(scope, propertyType(checker, symbol, member)) : undefined;
    if (own === undefined) {
      return { fault: [`has the member ${name} with no required literal property "${property}", the tag key that Discriminator<'${property}'> declares`, `Give ${name} a required "${property}" property with a literal type, such as ${property}: 'a'.`] };
    }
    for (const value of own) {
      const key = text ? String(value) : value;
      const owner = owners.get(key);
      if (owner !== undefined) return { fault: [`has the members ${owner} and ${name} that share the "${property}" value ${JSON.stringify(value)}`, `Give each model its own "${property}" value.`] };
      owners.set(key, name);
    }
    values.push(own);
  }
  return { property, values };
}

/** A parameter type that is a union of golem models (written out, or through an alias of a union): the models, and the tag that picks one when there is one. */
function nestUnionBinding(
  scope: Scope,
  unbound: NestBinding,
  model: ts.TypeNode,
  members: readonly ts.TypeNode[],
  unions: { readonly text: boolean },
): NestBinding {
  const { checker, core } = scope;
  const variants = members.map((member) => {
    const name = serdeTypeName(member);
    const symbol = name && resolvedSymbolAt(checker, name);
    if (name) core.readAliasChain(name);
    // A union written in another file is part of this file's rewrite.
    core.readWrittenIn(member);
    return { member, name, id: symbol ? core.codecIdOf(symbol) : '', golemModel: symbol ? core.isGolemModel(symbol) : modelDeclarationKind(checker, member) !== undefined };
  });
  const golemModel = variants.every((variant) => variant.golemModel);
  if (!golemModel || variants.some((variant) => variant.id === '')) return { ...unbound, golemModel };
  const tag = unionTag(scope, model, members, unions.text);
  if ('fault' in tag) return { ...unbound, golemModel: true, id: '', unionFault: tag.fault };
  return {
    ...unbound,
    golemModel: true,
    id: '',
    union: { property: tag.property, variants: variants.map((variant, index) => ({ values: tag.values[index]!, id: variant.id, name: variant.name! })) },
  };
}

/**
 * The fault of a union whose `Discriminator` tag is written through an alias of the tag (`(A | B) & Kind`). The binding reads the tag where
 * it is written on the union, on an alias of the whole union or on a generic wrapper of it (`Tagged<A | B>`).
 */
function tagThroughAliasFault({ ts, checker }: Scope, model: ts.TypeNode): readonly [reason: string, advice: string] | undefined {
  let node = model;
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  const aliasOf = (reference: ts.TypeNode): ts.TypeAliasDeclaration | undefined => ts.isTypeReferenceNode(reference)
    ? resolvedSymbolAt(checker, reference.typeName)?.declarations?.find(ts.isTypeAliasDeclaration)
    : undefined;
  const fix = "Write the tag on the union itself, (A | B) & Discriminator<'kind'>, or give the whole tagged union a type alias: type TShape = (A | B) & Discriminator<'kind'>.";
  if (ts.isIntersectionTypeNode(node) && node.types.some((part) => authoredUnionMembers(checker, part))) {
    const through = node.types.find((part) => !isDiscriminatorTag(checker, part) && aliasOf(part)?.type !== undefined && isDiscriminatorTag(checker, aliasOf(part)!.type));
    if (through) return [`is a union whose Discriminator tag is written through the alias ${through.getText()}, which golem does not read`, fix];
  }
  // A generic wrapper binds only when it is its type parameter plus the tag; any other part makes it a type golem does not read.
  const wrapper = ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1 && authoredUnionMembers(checker, node.typeArguments[0]) ? aliasOf(node) : undefined;
  if (wrapper !== undefined && ts.isIntersectionTypeNode(wrapper.type) && wrapper.type.types.some((part) => isDiscriminatorTag(checker, part))) {
    return [`is a generic wrapper of a union that holds more than the type parameter and its Discriminator tag, which golem does not read`, "Use a wrapper that is only U & Discriminator<'kind'>, or write the tag on the union itself, (A | B) & Discriminator<'kind'>."];
  }
  return undefined;
}

/** What a parameter or return type binds to. `unions` is set for an input parameter, the only place a union of models can stand; `text` is true for a query, whose tag is text. */
function nestBinding(scope: Scope, typeNode: ts.TypeNode, unions?: { readonly text: boolean }): NestBinding {
  const { ts, checker, core, file } = scope;
  const walked = nestModelType(ts, typeNode, false);
  const model = walked?.model;
  const unbound = { id: '', primitive: false, golemModel: false, label: (model ?? typeNode).getText(file), array: walked?.array ?? false };
  if (!model) return unbound;
  // Only an input parameter can be a union: a union return is left as Nest JSON.
  const members = unions !== undefined ? authoredUnionMembers(checker, model) : undefined;
  if (members) return nestUnionBinding(scope, unbound, model, members, unions!);
  const throughAlias = unions !== undefined ? tagThroughAliasFault(scope, model) : undefined;
  if (throughAlias) return { ...unbound, golemModel: true, unionFault: throughAlias };
  const { label } = unbound;
  const name = serdeTypeName(model);
  const symbol = name && resolvedSymbolAt(checker, name);
  // A golem model may be named like a library type (`Record`, `Map`): the symbol decides before the written name does.
  if (NEST_PRIMITIVE_TYPES.has(label.slice(label.lastIndexOf('.') + 1)) && !(symbol && core.isGolemModel(symbol))) return { ...unbound, primitive: true };
  if (name) core.readAliasChain(name);
  if (!symbol) return { ...unbound, golemModel: modelDeclarationKind(checker, model) !== undefined };
  return { ...unbound, id: core.codecIdOf(symbol), golemModel: core.isGolemModel(symbol), name, defaultExport: symbol.name === 'default' };
}

/** One `@Body()` or `@Query()` parameter of a handler that `NestModelInterceptor` converts to a model. */
interface HandlerInput {
  readonly parameter: ts.ParameterDeclaration;
  readonly decorator: string;
  /** The decorator as written, for the message. */
  readonly node: ts.Decorator;
  /** The field a one-field parameter reads; undefined for a whole one. */
  readonly field: string | undefined;
  /** The type is an array of the model. */
  readonly array: boolean;
  /** The model and array form the interceptor compares between two parameters that read the same value. */
  readonly model: string;
}

function handlerInputModel(binding: NestBinding): string {
  if (binding.union) return JSON.stringify([binding.union.property, binding.union.variants.map((variant) => [variant.values, variant.id])]);
  return `${binding.id}${binding.array ? '[]' : ''}`;
}

/**
 * The limits `NestModelInterceptor` sets on the inputs of one handler together, each with the parameter to report it at, in
 * parameter order. A parameter that omits what the interceptor needs: an optional one-field parameter or an optional whole body
 * (a request without that value answers HTTP 400). A parameter the interceptor cannot convert next to an earlier one: a whole
 * and a one-field parameter of one source, and two parameters that read the same value as another model (both throw a
 * TypeError, and Nest answers HTTP 500). A whole `@Query()` array throws a TypeError too, because a query is an object.
 * Each parameter that breaks a rule gets its own report.
 */
function handlerInputFaults(file: ts.SourceFile, inputs: readonly HandlerInput[]): readonly { readonly parameter: ts.ParameterDeclaration; readonly message: string }[] {
  const faults: { parameter: ts.ParameterDeclaration; message: string }[] = [];
  const expression = ({ node }: HandlerInput): string => `@${node.expression.getText(file)}`;
  const written = (input: HandlerInput): string => `${expression(input)} ${input.parameter.name.getText(file)}`;
  inputs.forEach((input, index) => {
    const { parameter, decorator, field } = input;
    const lowered = decorator.toLowerCase();
    const earlier = inputs.slice(0, index).filter((other) => other.decorator === decorator);
    const fault = (message: string): void => { faults.push({ parameter, message }); };
    const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;
    if (optional && field !== undefined) {
      fault(`${written(input)} is an optional one-field model, and NestModelInterceptor answers HTTP 400 for a request that omits the field. Make the parameter required, or declare the field optional in a whole @${decorator}() model.`);
    } else if (optional && decorator === 'Body') {
      fault(`${written(input)} is an optional whole body, and NestModelInterceptor answers HTTP 400 for a request without a body. Make the parameter required.`);
    }
    if (field === undefined && decorator === 'Query' && input.array) {
      fault(`${written(input)} is an array of models, and NestModelInterceptor throws a TypeError for a whole @Query() array, and Nest answers HTTP 500: a query is an object. Declare the query as one model.`);
    }
    const mixed = earlier.find((other) => (other.field === undefined) !== (field === undefined));
    if (mixed) {
      fault(`${written(input)} cannot share a handler with ${written(mixed)}: NestModelInterceptor throws a TypeError for a whole and a one-field @${decorator}() together, and Nest answers HTTP 500. Declare the whole ${lowered} as one model, or use one-field parameters only.`);
    }
    const reads = earlier.find((other) => other.field === field);
    if (reads && reads.model !== input.model) {
      fault(`${written(input)} takes another model than ${written(reads)}: NestModelInterceptor throws a TypeError for ${field === undefined ? `whole @${decorator}() parameters` : `${expression(input)} parameters`} of different types, and Nest answers HTTP 500. Give them one model type, or declare one ${field === undefined ? `whole ${lowered}` : 'parameter'}.`);
    }
  });
  return faults;
}

/** The edits, imports, codec loads and diagnostics of the NestJS side for one file. `nonModelInputs` is the validated option of the extension. */
function rewriteFile(input: RewriteParticipantInput): RewriteParticipantResult {
  const { ts, checker, file, root, core } = input;
  const scope: Scope = { ts, checker, core, root, file };
  const warn = input.options.nonModelInputs === 'warn';
  const edits: RewriteEdit[] = [];
  const diagnostics: GolemDiagnostic[] = [];
  const nonModelSeverity = warn ? GolemDiagnosticSeverity.Warning : GolemDiagnosticSeverity.Error;
  const nonModelAdvice = warn
    ? 'Generation continues, because golem.yaml sets nonModelInputs: warn.'
    : 'An app with its own interceptor can set nonModelInputs: warn on the nest extension in golem.yaml.';
  const bindParameter = (typeNode: ts.TypeNode, decorator: string): NestBinding => nestBinding(scope, typeNode, { text: decorator === 'Query' });

  /** The inputs of one handler that the interceptor converts together: `handlerInputFaults` reports the limits they set on each other. */
  const visitHandler = (method: ts.MethodDeclaration): void => {
    const inputs: HandlerInput[] = [];
    for (const parameter of method.parameters) {
      const found = nestParameterDecorator(scope, parameter);
      if (!parameter.type || found === undefined) continue;
      const { node, name: decorator } = found;
      const binding = bindParameter(parameter.type, decorator);
      const field = staticDecoratorKey(checker, node);
      // A type that is no model, or a union in one field, has its own report; the interceptor throws on it before it compares anything.
      if ((binding.id === '' && binding.union === undefined) || (binding.union !== undefined && (binding.array || field !== undefined))) continue;
      inputs.push({ parameter, decorator, node, field, array: binding.array, model: handlerInputModel(binding) });
    }
    for (const { parameter, message } of handlerInputFaults(file, inputs)) {
      diagnostics.push(core.locate(parameter, CODE_NEST_NOT_A_MODEL, `${message} ${nonModelAdvice}`, nonModelSeverity));
    }
  };

  /** A `@Body()` or `@Query()` parameter of a model gets `@nestModelCodec(id)` before its name, and one of a tagged union of models `@nestModelUnion(tag, variants)`. */
  const visitParameter = (parameter: ts.ParameterDeclaration): void => {
    const found = nestParameterDecorator(scope, parameter);
    if (!parameter.type || found === undefined || hasDecorator(scope, parameter, NEST_CODEC_DECORATOR) || hasDecorator(scope, parameter, NEST_UNION_DECORATOR)) return;
    const { node: decoratorNode, name: decorator } = found;
    const typeNode = parameter.type;
    const { id, golemModel, label, array, name, defaultExport, union, unionFault } = bindParameter(typeNode, decorator);
    // A union converts as a whole input only; golem describes no array of a union and no one-field union.
    const unionUnsupported = union !== undefined && (array || staticDecoratorKey(checker, decoratorNode) !== undefined);
    if ((id === '' && union === undefined) || unionUnsupported) {
      const [reason, advice] = unionFault
        ? unionFault
        : unionUnsupported
          ? ['is a union of golem models, which NestModelInterceptor converts only as a whole input', `Declare the parameter as the union itself in a whole @${decorator}(), or as one model.`]
          : ['is not a golem model', 'Declare the input as a golem model (IModel or IObject), or bind one field of a model type.'];
      if (golemModel && !unionFault && !unionUnsupported) diagnostics.push(core.locate(typeNode, CODE_NEST_NO_CODEC, defaultExport
        ? `@${decorator}() type ${label} is the default export of its file, which has no codec id; golem generate cannot add one. Export the class by name (export class ${label}) and import it by name.`
        : `@${decorator}() type ${label} has no unique codec id; run golem generate`));
      else diagnostics.push(core.locate(typeNode, CODE_NEST_NOT_A_MODEL,
        `${label} ${reason}, and NestModelInterceptor answers HTTP 500 for a @${decorator}() parameter of that type. ${advice} ${nonModelAdvice}`,
        nonModelSeverity));
      return;
    }
    if (union) {
      edits.push(insertion(parameter.name.getStart(file), `@${REWRITE_IMPORT_PREFIX}${NEST_UNION_DECORATOR}(${JSON.stringify(union.property)}, ${JSON.stringify(union.variants.map((variant) => [variant.values, variant.id]))}) `));
      core.importName(parameter, NEST_UNION_DECORATOR, NEST_MODULE);
      for (const variant of union.variants) core.loadCodecModule(variant.id, variant.name);
    } else {
      edits.push(insertion(parameter.name.getStart(file), `@${REWRITE_IMPORT_PREFIX}${NEST_CODEC_DECORATOR}(${JSON.stringify(id)}${array ? ', true' : ''}) `));
      core.importName(parameter, NEST_CODEC_DECORATOR, NEST_MODULE);
      core.loadCodecModule(id, name);
    }
  };

  /**
   * A class method with a decorator that returns a model gets `@nestModelReturn(id[, true])` before its other decorators.
   * The interceptor reads it for an HTTP handler only, and a handler always carries the decorator that sets its route,
   * a composed one such as `applyDecorators(Get())` included. A method with no decorator is no handler, and gets none.
   */
  const visitMethod = (method: ts.MethodDeclaration): void => {
    // A decorator is a syntax error on an object literal method, an abstract method and an overload signature.
    if (!method.type || !method.body || !ts.isClassLike(method.parent) || (ts.getDecorators(method) ?? []).length === 0) return;
    const returned = nestModelType(ts, method.type, true);
    if (!returned || hasDecorator(scope, method, NEST_RETURN_DECORATOR)) return;
    const { id, primitive, name } = nestBinding(scope, returned.model);
    if (primitive || id === '') return;
    edits.push(insertion(method.getStart(file), `@${REWRITE_IMPORT_PREFIX}${NEST_RETURN_DECORATOR}(${JSON.stringify(id)}${returned.array ? ', true' : ''}) `));
    core.importName(method, NEST_RETURN_DECORATOR, NEST_MODULE);
    core.loadCodecModule(id, name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node)) visitParameter(node);
    else if (ts.isMethodDeclaration(node)) { visitMethod(node); visitHandler(node); }
    ts.forEachChild(node, (child) => { visit(child); return undefined; });
  };
  visit(file);
  return { edits, diagnostics };
}

/** Fills `model.codecData` (the hook name is plain text, as a third party writes it): the codec of a model carries the query fields that a query string decodes. */
const codecData: CodecDataParticipant = nodeQueryFields;

export const extension: GolemExtension = { rewrite: rewriteFile, hooks: { 'model.codecData': codecData } };
