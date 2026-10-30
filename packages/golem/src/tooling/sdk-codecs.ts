import { code, exportedName, fileImports, ImportSource, join, lineBreak, nest, propertyKey, render, sideEffectImport, type Code } from './code.js';
import { rt } from './rt.js';

/**
 * What both generated-SDK writers share: the `sdkCodecs` table the client reads, and the Temporal codec rules. golem-openapi writes the
 * table of a standalone SDK and golem-model the table of a golem-mode SDK, so neither imports the other (generators do not import each other).
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

/** The codecs of one operation; each is the code of a function the table module can name. An operation that converts nothing has no `encode` or `decode`. */
export interface SdkOperationCodecs {
  /** The operation name: the key of the table, so it is unique. */
  readonly name: string;
  /** Checks the plain input of a call. */
  readonly input?: Code;
  /** Checks the wire form of each response, in the order the operation lists them. */
  readonly responses?: readonly Code[];
  /** Turns the plain request body into its wire form. */
  readonly encode?: Code;
  /** Turns the wire response body into its converted form. */
  readonly decode?: Code;
}

export interface SdkCodecsModule {
  /** The comment that opens the file. */
  readonly banner: Code;
  /** The modules whose names the codecs use; the file imports the names it uses. */
  readonly sources: readonly ImportSource[];
  /** Modules the file loads for the codecs they register, after the named imports. */
  readonly loads?: readonly string[];
}

/** The text of a module that exports `sdkCodecs`, the table of the codecs of each operation by operation name. */
export function writeSdkCodecs(operations: readonly SdkOperationCodecs[], module: SdkCodecsModule): string {
  const names = new Set<string>();
  for (const { name } of operations) {
    if (names.has(name)) throw new Error(`Two operations are named ${JSON.stringify(name)}; the sdkCodecs table keys its entries by operation name.`);
    names.add(name);
  }
  const entry = (operation: SdkOperationCodecs): Code => {
    const members: Code[] = [
      ...(operation.input ? [code`input: ${operation.input},`] : []),
      ...(operation.responses?.length ? [code`responses: [${join(operation.responses, code`, `)}],`] : []),
      ...(operation.encode ? [code`encode: ${operation.encode},`] : []),
      ...(operation.decode ? [code`decode: ${operation.decode},`] : []),
    ];
    return members.length
      ? code`${propertyKey(operation.name)}: {${nest(code`${lineBreak}${join(members, lineBreak)}`)}${lineBreak}},`
      : code`${propertyKey(operation.name)}: {},`;
  };
  const table = operations.length
    ? code`export const ${exportedName('sdkCodecs')} = {${nest(code`${lineBreak}${join(operations.map(entry), lineBreak)}`)}${lineBreak}} as const;`
    : code`export const ${exportedName('sdkCodecs')} = {} as const;`;
  const body = code`${table}\n`;
  const imports = fileImports(body, module.sources);
  return render(code`${join([module.banner, ...imports, ...(module.loads ?? []).map(specifier => sideEffectImport(specifier)), code``, body], lineBreak)}`);
}
