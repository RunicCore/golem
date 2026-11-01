import path from 'node:path';
import { code, exportedName, fileImports, ImportSource, join, lineBreak, nest, propertyKey, render, type Code } from './code.js';
import { portableRelativeFilename } from './type-analysis/path-identity.js';

/**
 * What both generated-SDK writers share: the codec module of an operation the client reads. golem-openapi-ts writes
 * the modules of a standalone SDK and golem-model those of a golem-mode SDK, so neither imports the other (generators do not import each other).
 */

/**
 * Where a golem-mode SDK reads its codecs. The openapi job writes no codec of such an SDK: the models job of the same golem.yaml writes one file for it,
 * which exports `SDK_CODECS_EXPORT`, an object with a member for every operation of the SDK, and the operation modules import that file by this name.
 * The openapi job writes its imports and the models job writes the file, so both take the path from `sdkCodecsFile`.
 */
export const SDK_CODECS_EXPORT = 'sdkCodecs';

export { sdkCodecsFile } from './plan-support.js';

/** The specifier by which the generated file `fromFile` imports the generated TypeScript file `toFile`: relative, with `/` and the `.js` ending. */
export function moduleSpecifier(fromFile: string, toFile: string): string {
  const target = path.parse(toFile);
  const relative = portableRelativeFilename(path.join(target.dir, `${target.name}.js`), path.dirname(fromFile));
  return relative.startsWith('./') || relative.startsWith('../') ? relative : `./${relative}`;
}

/** The code of a function the module names, under the key that picks it. */
interface SdkKeyedCode {
  readonly key: string;
  readonly code: Code;
}

/**
 * The codecs of one operation; each is the code of a function the module can name. A value that converts nothing has no entry,
 * and an operation with no such value has no such member. The members `encode`, `decode`, `parameters` and `headers` name the client's direction.
 */
interface SdkOperationCodecs {
  /** Checks the plain input of a call. */
  readonly input?: Code;
  /** Checks the plain header parameters of a call, apart from `input`; none when the operation has no header parameter. */
  readonly requestHeaders?: Code;
  /** Checks the wire form of each response body or stream item, keyed `status:contentType`. */
  readonly responses?: readonly SdkKeyedCode[];
  /** Checks the wire form of each declared response header, keyed `status:name`. */
  readonly responseHeaders?: readonly SdkKeyedCode[];
  /** Turns the plain request body of a media type into its wire form, keyed by the request content type. */
  readonly encode?: readonly SdkKeyedCode[];
  /** Turns the wire body or stream item of a response into its converted form, keyed `status:contentType`. */
  readonly decode?: readonly SdkKeyedCode[];
  /** Turns a plain request parameter into its wire form, keyed `location:name` (`querystring:name` for the querystring parameter). */
  readonly parameters?: readonly SdkKeyedCode[];
  /** Turns the decoded wire value of a response header into its converted form, keyed `status:name`. */
  readonly headers?: readonly SdkKeyedCode[];
}

export interface OperationCodecsModule {
  /** The comment that opens the file. */
  readonly banner: Code;
  /** The modules whose names the codecs use; the file imports the names it uses. */
  readonly sources: readonly ImportSource[];
}

/** The object literal of the codecs of one operation; the member of the table of a golem-mode SDK and the value of the module of a standalone one. */
function operationCodecsLiteral(operation: SdkOperationCodecs): Code {
  const keyed = (member: string, items: readonly SdkKeyedCode[] | undefined): Code[] => items?.length
    ? [code`${propertyKey(member)}: {${nest(code`${lineBreak}${join(items.map(item => code`${propertyKey(item.key)}: ${item.code},`), lineBreak)}`)}${lineBreak}},`]
    : [];
  const members: Code[] = [
    ...(operation.input ? [code`input: ${operation.input},`] : []),
    ...(operation.requestHeaders ? [code`requestHeaders: ${operation.requestHeaders},`] : []),
    ...keyed('responses', operation.responses),
    ...keyed('responseHeaders', operation.responseHeaders),
    ...keyed('encode', operation.encode),
    ...keyed('decode', operation.decode),
    ...keyed('parameters', operation.parameters),
    ...keyed('headers', operation.headers),
  ];
  return members.length ? code`{${nest(code`${lineBreak}${join(members, lineBreak)}`)}${lineBreak}}` : code`{}`;
}

/**
 * What a writer knows of one operation. `values` are the places of the values that convert: `['request', contentType]`,
 * `['response', status, contentType]`, `['parameter', location, name]` and `['response-header', status, name]`, in the order of each kind's table.
 * `checks` are the validators of the operation.
 */
export interface SdkOperationShape {
  readonly values: readonly (readonly string[])[];
  readonly checks?: Pick<SdkOperationCodecs, 'input' | 'requestHeaders' | 'responses' | 'responseHeaders'>;
}

/** The code of the conversion function of the value at a place, or none when the value converts nothing. */
export type SdkValueCodec = (at: readonly string[], conversion: 'fromWire' | 'toWire') => Code | undefined;

/**
 * The codecs of one operation, or none when it has nothing to say. Both writers of the SDK codecs (the module of a standalone operation
 * and the table of a golem-mode SDK) build them here, so the keys and the members are written once.
 */
function operationCodecsOf(shape: SdkOperationShape, codecOf: SdkValueCodec): SdkOperationCodecs | undefined {
  // The request of a client operation leaves in its wire form and its response arrives in its plain form.
  const keyed = (kind: string, key: (at: readonly string[]) => string, conversion: 'fromWire' | 'toWire'): SdkKeyedCode[] => shape.values
    .filter((at) => at[0] === kind)
    .flatMap((at) => {
      const codec = codecOf(at, conversion);
      return codec === undefined ? [] : [{ key: key(at.slice(1)), code: codec }];
    });
  const encode = keyed('request', ([contentType]) => contentType!, 'toWire');
  const decode = keyed('response', ([status, contentType]) => `${status}:${contentType}`, 'fromWire');
  const parameters = keyed('parameter', ([location, name]) => `${location}:${name}`, 'toWire');
  const headers = keyed('response-header', ([status, name]) => `${status}:${name}`, 'fromWire');
  const codecs: SdkOperationCodecs = {
    ...shape.checks,
    ...(encode.length ? { encode } : {}),
    ...(decode.length ? { decode } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(headers.length ? { headers } : {}),
  };
  return Object.keys(codecs).length ? codecs : undefined;
}

/** The text of a module that exports `operationCodecs`, the codecs of one operation: a client imports the module of the operation it calls and no other. An operation with no codecs has no module. */
export function writeOperationCodecs(shape: SdkOperationShape, codecOf: SdkValueCodec, module: OperationCodecsModule): string | undefined {
  const operation = operationCodecsOf(shape, codecOf);
  if (operation === undefined) return undefined;
  const body = code`export const ${exportedName('operationCodecs')} = ${operationCodecsLiteral(operation)} as const;\n`;
  const imports = fileImports(body, module.sources);
  return render(code`${join([module.banner, ...imports, code``, body], lineBreak)}`);
}

/** The declaration of `SDK_CODECS_EXPORT`: the codecs of every operation of a golem-mode SDK that has any, each under the operation's name, in the shape a standalone operation module exports. */
export function sdkCodecsTable(operations: readonly { readonly name: string; readonly shape: SdkOperationShape; readonly codecOf: SdkValueCodec }[]): Code {
  const members = operations.flatMap(({ name, shape, codecOf }) => {
    const codecs = operationCodecsOf(shape, codecOf);
    return codecs === undefined ? [] : [code`${propertyKey(name)}: ${operationCodecsLiteral(codecs)},`];
  });
  const literal = members.length ? code`{${nest(code`${lineBreak}${join(members, lineBreak)}`)}${lineBreak}}` : code`{}`;
  return code`export const ${exportedName(SDK_CODECS_EXPORT)} = ${literal} as const;\n`;
}
