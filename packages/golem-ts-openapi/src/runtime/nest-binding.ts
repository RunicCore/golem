/**
 * The decorators that the build-time rewrite inserts on controller sources, the parameter tokens they place, and the readers of
 * those tokens (`@exprtlabs/golem-ts-openapi/internal/nest-runtime`). `nest.ts` reads the tokens in `NestModelInterceptor` and
 * `objectCodecFromMetatype`; the decorators are internal because only generated code calls them.
 */
import { presentValue, requireModelObject, unknownDiscriminatorValue, type InternalObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getIModelClass, getObjectCodec, type ObjectCodec, type SerdeOptions } from '@exprtlabs/golem/serde';
import { decodeQueryField, type QueryFieldTable } from './query-decode.js';

declare module '@exprtlabs/golem/internal/model-runtime' {
  /** The nest extension's data on a codec: the fields of the model that a query string decodes, by name. */
  interface CodecExtensionData {
    readonly nest?: QueryFieldTable;
  }
}

type DiscriminatorValue = string | number | boolean;

const NEST_MODEL_CODEC_ID = Symbol.for('@exprtlabs/golem:nestModelCodec');
const NEST_MODEL_CODEC = Symbol.for('@exprtlabs/golem:nestModelCodec.codec');
const NEST_MODEL_CONSTRUCT = Symbol.for('@exprtlabs/golem:nestModelCodec.construct');
const NEST_MODEL_ARRAY = Symbol.for('@exprtlabs/golem:nestModelCodec.array');
const NEST_MODEL_UNION = Symbol.for('@exprtlabs/golem:nestModelCodec.union');
export const NEST_MODEL_UNION_IDS = Symbol.for('@exprtlabs/golem:nestModelCodec.unionIds');
export const NEST_MODEL_RETURN = '@exprtlabs/golem:nestModelReturn';

type ReflectParamtypes = {
  defineMetadata(key: string, value: unknown, target: object, propertyKey: string | symbol): void;
  getOwnMetadata(key: string, target: object, propertyKey: string | symbol): unknown;
  getMetadata(key: string, target: object, propertyKey: string | symbol): unknown;
};

export type NestReturnMeta = {
  readonly id: string;
  readonly array: boolean;
};

export type NestModelConstruct = abstract new (values?: never) => object;

/** A variant of a union parameter: the values of its tag and the id of its codec. */
type NestUnionVariant = readonly [values: readonly DiscriminatorValue[], id: string];

/** A tagged union of registered codecs that converts a wire value through the codec its tag picks. */
export interface NestUnionInput {
  /** The model of the variant that the tag of `wire` picks. A missing or unknown tag, or input the variant rejects, throws a `LibError`. */
  fromWireFormat(wire: unknown, options?: SerdeOptions): unknown;
  /** Decodes the query fields to what the picked variant declares; a query whose tag picks none stays as it is. */
  decodeQuery(query: unknown): unknown;
}

export interface NestUnionBinding extends NestUnionInput {
  /** The property and variants of the union: two parameters with one key are one input type. */
  readonly key: string;
}

/** What the interceptor converts a whole or one-field input with. */
export type ModelInput = InternalObjectCodec | NestUnionBinding;

type NestModelToken = Function & {
  readonly [NEST_MODEL_CODEC_ID]?: unknown;
  readonly [NEST_MODEL_CODEC]?: ObjectCodec;
  readonly [NEST_MODEL_UNION]?: NestUnionBinding;
  readonly [NEST_MODEL_UNION_IDS]?: readonly string[];
  readonly [NEST_MODEL_CONSTRUCT]?: NestModelConstruct;
  readonly [NEST_MODEL_ARRAY]?: true;
};

export function reflectMeta(): ReflectParamtypes {
  return Reflect as typeof Reflect & ReflectParamtypes;
}

function nestModelMetatype(id: string, array: boolean): Function {
  const Token = class {};
  Object.defineProperty(Token, 'name', { value: id });
  Object.defineProperty(Token, NEST_MODEL_CODEC_ID, { value: id });
  if (array) Object.defineProperty(Token, NEST_MODEL_ARRAY, { value: true });
  const codec = getObjectCodec(id);
  if (codec) {
    Object.defineProperty(Token, NEST_MODEL_CODEC, { value: codec });
    const construct = getIModelClass(id);
    if (construct) Object.defineProperty(Token, NEST_MODEL_CONSTRUCT, { value: construct });
  }
  return Token;
}

export function asToken(metatype: unknown): NestModelToken | undefined {
  return typeof metatype === 'function' ? metatype as NestModelToken : undefined;
}

export function codecIdFromMetatype(metatype: unknown): string | undefined {
  const token = asToken(metatype);
  const registered = token?.[NEST_MODEL_CODEC_ID];
  if (typeof registered === 'string' && registered !== '') return registered;
  return undefined;
}

export function boundCodec(metatype: unknown): ObjectCodec | undefined {
  return asToken(metatype)?.[NEST_MODEL_CODEC];
}

export function boundUnion(metatype: unknown): NestUnionBinding | undefined {
  return asToken(metatype)?.[NEST_MODEL_UNION];
}

export function boundArray(metatype: unknown): boolean {
  return asToken(metatype)?.[NEST_MODEL_ARRAY] === true;
}

export function boundConstruct(metatype: unknown): NestModelConstruct | undefined {
  return asToken(metatype)?.[NEST_MODEL_CONSTRUCT];
}

export function nestModelReturn(id: string, array?: boolean): MethodDecorator {
  const meta: NestReturnMeta = { id, array: array === true };
  return (target, propertyKey) => {
    if (propertyKey === undefined) return;
    reflectMeta().defineMetadata(NEST_MODEL_RETURN, meta, target, propertyKey);
  };
}

function bindMetatype(token: Function): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) return;
    const meta = reflectMeta();
    const types = Array.from(
      (meta.getOwnMetadata('design:paramtypes', target, propertyKey) as unknown[] | undefined) ?? [],
    );
    types[parameterIndex] = token;
    meta.defineMetadata('design:paramtypes', types, target, propertyKey);
  };
}

export function nestModelCodec(id: string, array?: boolean): ParameterDecorator {
  return bindMetatype(nestModelMetatype(id, array === true));
}

/**
 * Binds a parameter typed as a union of models, such as `TCircle | TRect`. `property` is the tag every variant requires with a
 * literal type, and each variant lists the values of its tag and its codec id. The interceptor converts
 * the input through the codec of the variant that its tag picks. `NestModelInterceptor` and `nestUnionFromMetatype` read this binding.
 */
export function nestModelUnion(property: string, variants: readonly NestUnionVariant[]): ParameterDecorator {
  // The token is named after its variants, which the interceptor's fault messages show.
  const ids = variants.map(([, id]) => id);
  const token = nestModelMetatype(ids.join(' | '), false);
  Object.defineProperty(token, NEST_MODEL_UNION_IDS, { value: ids });
  // The codecs of the variants register when their generated modules load, which can be after this class loads, so the first read resolves them.
  let union: NestUnionBinding | undefined;
  Object.defineProperty(token, NEST_MODEL_UNION, { get: () => union ??= nestUnionInput(property, variants) });
  return bindMetatype(token);
}

/** The union of the variants, or undefined while the codec of one is not registered. */
function nestUnionInput(property: string, variants: readonly NestUnionVariant[]): NestUnionBinding | undefined {
  const members = variants.map(([values, id]) => ({ values, codec: getObjectCodec(id), construct: getIModelClass(id) }));
  const registered = members.flatMap((member) => member.codec === undefined ? [] : [{ ...member, codec: member.codec }]);
  if (registered.length !== members.length) return undefined;
  const picked = (record: Readonly<Record<string, unknown>>): (typeof registered)[number] | undefined => {
    const tag = presentValue(record, property);
    return registered.find((member) => member.values.includes(tag as DiscriminatorValue));
  };
  return {
    key: JSON.stringify([property, variants]),
    fromWireFormat(wire, options) {
      const record = requireModelObject(wire, 'The input');
      const member = picked(record);
      if (!member) return unknownDiscriminatorValue(property, presentValue(record, property), 'deserialize');
      return member.codec.fromWireFormat(wire, { ...options, construct: member.construct });
    },
    decodeQuery(query) {
      const record = schemaRecord(query);
      const tag = record && presentValue(record, property);
      // A query tag is text: the picked variant decodes it to a number or a boolean when its tag has that type.
      const member = typeof tag === 'string' ? registered.find((each) => each.values.some((value) => String(value) === tag)) : undefined;
      return member ? queryWireDecoder(member.codec)(query) : query;
    },
  };
}

type QueryWireDecoder = (query: unknown) => unknown;

const queryWireDecoders = new WeakMap<InternalObjectCodec, QueryWireDecoder>();

export function schemaRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/**
 * Query values arrive as strings or repeated-key string arrays. Decode each
 * field to the scalar or array type the codec's query-field table (`data.nest`) declares
 * before the model's wire validation runs. A value that does not fit stays a
 * string, so the validator reports it. Body JSON keeps its own types and is
 * not decoded.
 */
export function queryWireDecoder(input: ModelInput): QueryWireDecoder {
  if ('decodeQuery' in input) return input.decodeQuery;
  const codec = input;
  const cached = queryWireDecoders.get(codec);
  if (cached) return cached;
  const decoded = Object.entries(codec.data?.nest ?? {});
  const decoder: QueryWireDecoder = decoded.length === 0 ? (query) => query : (query) => {
    const record = schemaRecord(query);
    if (!record) return query;
    let copy: Record<string, unknown> | undefined;
    for (const [name, shape] of decoded) {
      if (!Object.hasOwn(record, name)) continue;
      copy ??= { ...record };
      // Define rather than assign so a field named __proto__ stays data.
      Object.defineProperty(copy, name, {
        value: decodeQueryField(record[name], shape), writable: true, enumerable: true, configurable: true,
      });
    }
    return copy ?? query;
  };
  queryWireDecoders.set(codec, decoder);
  return decoder;
}
