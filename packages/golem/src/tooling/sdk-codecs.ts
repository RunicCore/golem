import { code, exportedName, fileImports, ImportSource, join, lineBreak, nest, propertyKey, render, type Code } from './code.js';
import { rt } from './rt.js';

/**
 * What both generated-SDK writers share: the codec module of an operation the client reads, and the Temporal codec rules. golem-openapi writes
 * the modules of a standalone SDK and golem-model those of a golem-mode SDK, so neither imports the other (generators do not import each other).
 */

/** The prefix of the serde id that names a Temporal codec of `@exprtlabs/golem/internal/temporal-runtime`. */
export const TEMPORAL_SERDE_PREFIX = 'temporal:';

/** `dates: temporal` string formats and the Temporal type each converts to, with the `@exprtlabs/golem/temporal` codec that converts it. */
export const TEMPORAL_FORMATS = {
  'date-time': { typeName: 'Temporal.Instant', type: code`Temporal.Instant`, codec: 'TemporalInstant' },
  date: { typeName: 'Temporal.PlainDate', type: code`Temporal.PlainDate`, codec: 'TemporalPlainDate' },
  duration: { typeName: 'Temporal.Duration', type: code`Temporal.Duration`, codec: 'TemporalDuration' },
} as const;

/** The codec name of a `temporal:` serde id; any other id never reaches a generated SDK. */
export function temporalCodecName(id: string): string {
  if (!id.startsWith(TEMPORAL_SERDE_PREFIX)) throw new Error(`Unexpected serde id in a generated SDK: ${id}`);
  return id.slice(TEMPORAL_SERDE_PREFIX.length);
}

/**
 * Calls the Temporal codec of `@exprtlabs/golem/internal/temporal-runtime` that a `temporal:` serde id names.
 * Conversion code holds values as `unknown`; wire validation has already checked them, so the call casts.
 * The codec is a runtime part, so the file imports exactly the codecs it calls. The module exports one pair for each
 * Temporal type; a name it lacks is a TypeScript error in the generated file.
 */
const TEMPORAL_CODECS = rt.temporal as unknown as Readonly<Record<string, Code>>;

function temporalCodec(direction: 'deserialize' | 'serialize', id: string): Code {
  return TEMPORAL_CODECS[`${direction}${temporalCodecName(id)}`];
}

export const TEMPORAL_SERDE = {
  deserialize: (id: string, value: Code) => code`${temporalCodec('deserialize', id)}((${value}) as never)`,
  serialize: (id: string, value: Code) => code`${temporalCodec('serialize', id)}((${value}) as never)`,
};

/** The code of a function the module names, under the key that picks it. */
export interface SdkKeyedCode {
  readonly key: string;
  readonly code: Code;
}

/**
 * The codecs of one operation; each is the code of a function the module can name. A value that converts nothing has no entry,
 * and an operation with no such value has no such member.
 */
export interface SdkOperationCodecs {
  /** Checks the plain input of a call. */
  readonly input?: Code;
  /** Checks the wire form of each response body or stream item, keyed `status:contentType`. */
  readonly responses?: readonly SdkKeyedCode[];
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

/** The text of a module that exports `operationCodecs`, the codecs of one operation: a client imports the module of the operation it calls and no other. */
export function writeOperationCodecs(operation: SdkOperationCodecs, module: OperationCodecsModule): string {
  const keyed = (member: string, items: readonly SdkKeyedCode[] | undefined): Code[] => items?.length
    ? [code`${propertyKey(member)}: {${nest(code`${lineBreak}${join(items.map(item => code`${propertyKey(item.key)}: ${item.code},`), lineBreak)}`)}${lineBreak}},`]
    : [];
  const members: Code[] = [
    ...(operation.input ? [code`input: ${operation.input},`] : []),
    ...keyed('responses', operation.responses),
    ...keyed('encode', operation.encode),
    ...keyed('decode', operation.decode),
    ...keyed('parameters', operation.parameters),
    ...keyed('headers', operation.headers),
  ];
  const literalBody = members.length ? code`{${nest(code`${lineBreak}${join(members, lineBreak)}`)}${lineBreak}}` : code`{}`;
  const body = code`export const ${exportedName('operationCodecs')} = ${literalBody} as const;\n`;
  const imports = fileImports(body, module.sources);
  return render(code`${join([module.banner, ...imports, code``, body], lineBreak)}`);
}
