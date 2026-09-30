import type { Ajv2020 } from 'ajv/dist/2020.js';
import { _, stringify } from 'ajv/dist/compile/codegen/index.js';
import { MODEL_DATE_KEYWORD, MODEL_INSTANCE_KEYWORD, VALIDATION_KEYWORD } from './schema-keywords.js';

export type ValidationBindings = Readonly<Record<string, (value: unknown) => boolean | string>>;
export { VALIDATION_KEYWORD } from './schema-keywords.js';

/** Must match `MODEL_CODEC_IDS` in object-codec.ts; this module stays free of runtime imports. */
const MODEL_CODEC_IDS_KEY = '@exprtlabs/golem:modelCodecIds';

/**
 * `{ of?, among, required }`: among the union variant classes `among`, the
 * class a value's encoder selects is the most-derived one it is an instance
 * of. It must be `of` (always when `required`, otherwise when there is one);
 * without `of`, the value must be an instance of none of them.
 */
interface ModelInstanceSchema {
  readonly of?: string;
  readonly among: readonly string[];
  readonly required: boolean;
}

function modelInstanceSchema(value: unknown): ModelInstanceSchema {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid model instance schema.');
  const of: unknown = Reflect.get(value, 'of');
  const among: unknown = Reflect.get(value, 'among');
  const required: unknown = Reflect.get(value, 'required');
  if ((of !== undefined && typeof of !== 'string') || !Array.isArray(among)
    || !among.every((id): id is string => typeof id === 'string') || typeof required !== 'boolean') {
    throw new TypeError('Invalid model instance schema.');
  }
  return { ...(of === undefined ? {} : { of }), among, required };
}

/**
 * Add the model-only keywords: the Date identity check used by nested
 * structural tags, and the model-instance check that ties a union branch to
 * the variant class its encoder selects.
 */
export function addModelKeywords(ajv: Ajv2020): void {
  ajv.addKeyword({
    keyword: MODEL_INSTANCE_KEYWORD,
    schemaType: 'object',
    errors: false,
    code(context) {
      const schema = modelInstanceSchema(context.schema);
      // The first registered prototype on the chain is the most-derived class.
      // A hashed codec id matches exactly; an unhashed name also matches its hashed ids.
      const selected = context.gen.const('selected', _`((value, among) => {
        if (typeof value !== "object" || value === null) return undefined;
        const key = Symbol.for(${stringify(MODEL_CODEC_IDS_KEY)});
        const matches = (registered, id) => registered === id
          || (!/_[0-9a-f]{8}$/.test(id) && registered.length === id.length + 9 && registered.startsWith(id + "_") && /_[0-9a-f]{8}$/.test(registered));
        for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
          if (!Object.prototype.hasOwnProperty.call(prototype, key)) continue;
          for (const id of among) if (prototype[key].some((registered) => matches(registered, id))) return id;
        }
        return undefined;
      })(${context.data}, ${stringify(schema.among)})`);
      const expected = schema.of === undefined ? _`undefined` : stringify(schema.of);
      context.fail(schema.required || schema.of === undefined
        ? _`${selected} !== ${expected}`
        : _`${selected} !== undefined && ${selected} !== ${expected}`);
    },
  });
  ajv.addKeyword({
    keyword: MODEL_DATE_KEYWORD,
    schemaType: 'boolean',
    errors: false,
    code(context) {
      if (context.schema !== true) return;
      context.gen.if(
        _`!(${context.data} instanceof Date) || !Number.isFinite(${context.data}.getTime())`,
        () => context.fail(),
      );
    },
  });
}

/** One bridge is used by runtime and standalone Ajv compilation. */
export function addValidationKeyword(ajv: Ajv2020, bindings: ValidationBindings = {}): void {
  ajv.addKeyword({
    keyword: VALIDATION_KEYWORD,
    schemaType: ['array', 'object'],
    errors: true,
    error: {
      message: ({ params }) => _`${params.message}`,
      params: ({ params }) => _`{message: ${params.message}}`,
    },
    code(context) {
      const envelope = context.schema !== null
        && typeof context.schema === 'object'
        && !Array.isArray(context.schema)
        ? context.schema as { readonly schema?: unknown; readonly bindings?: unknown }
        : undefined;
      const ids: unknown = envelope ? envelope.bindings : context.schema;
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) {
        throw new TypeError('Validation bindings must be an array of declaration identifiers.');
      }
      const invoke = (overallValid?: ReturnType<typeof context.gen.name>): void => {
        for (const id of new Set(ids)) {
          const binding = bindings[id] ?? (() => { throw new TypeError(`Missing validation function: ${id}`); });
          const fn = context.gen.scopeValue('func', { key: id, ref: binding, code: _`bindings[${stringify(id)}]` });
          const result = context.gen.const('result', _`${fn}(${context.data})`);
          context.gen.if(_`typeof ${result} !== "boolean" && typeof ${result} !== "string"`, () => {
            context.gen.throw(_`new TypeError("Validation functions must return boolean or string.")`);
          });
          context.setParams({ message: _`typeof ${result} === "string" && ${result}.length > 0 ? ${result} : "Invalid value"` });
          context.gen.if(_`${result} !== true`, () => {
            if (overallValid) context.gen.assign(overallValid, false);
            context.fail();
          });
        }
      };
      if (!envelope) {
        invoke();
        return;
      }
      if (envelope.schema === undefined) throw new TypeError('Validation binding schemas require a structural schema.');
      const valid = context.gen.name('valid');
      const schemaContext = context.subschema({
        keyword: VALIDATION_KEYWORD,
        schemaProp: 'schema',
        compositeRule: true,
      }, valid);
      const overallValid = context.gen.let('callbackValid', valid);
      context.gen.if(valid, () => invoke(overallValid));
      context.mergeValidEvaluated(schemaContext, overallValid);
    },
  });
}
