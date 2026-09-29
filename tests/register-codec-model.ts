import { createOpenApiSyncAjvEngine } from '@exprtlabs/codegen/ajv';
import {
  registerGeneratedModel,
  type GeneratedModelConversion,
  type GeneratedModelValidatorEnhancer,
  type ModelTypeDescriptor,
} from '@exprtlabs/codegen/model';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX, schemaForDescriptor } from '@exprtlabs/codegen/schema';
import {
  createObjectCodec,
  registerIModelClass,
  requireAjvSchema,
  requireObjectCodec,
  serdeFailFast,
  validationFailure,
  ajvIssues,
  IssueRepresentation,
} from '@exprtlabs/codegen/serde';

function inlineGeneratedModelRefs(schema: object): object {
  const prefix = GENERATED_MODEL_SCHEMA_REF_PREFIX;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string' && record.$ref.startsWith(prefix)) {
      const codec = requireObjectCodec(record.$ref.slice(prefix.length));
      if (codec.schema === undefined || codec.schema === null || typeof codec.schema !== 'object') {
        throw new Error(`Nested codec schema is missing: ${record.$ref}`);
      }
      const nested = { ...(codec.schema as Record<string, unknown>) };
      delete nested.$id;
      const rest: Record<string, unknown> = { ...record };
      delete rest.$ref;
      return walk({ ...nested, ...rest });
    }
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) next[key] = walk(item);
    return next;
  };
  return walk(schema) as object;
}

export function installCodecModel<Model extends object>(options: {
  readonly constructor: abstract new (...arguments_: never[]) => Model;
  readonly name: string;
  readonly fields: readonly string[];
  readonly definitions: Readonly<Record<string, ModelTypeDescriptor>>;
  readonly conversion?: GeneratedModelConversion<Model, unknown>;
  readonly bindings?: Readonly<Record<string, (value: unknown) => boolean | string>>;
  readonly nestedCodecIds?: readonly string[];
  readonly profileValidation?: boolean;
  readonly enhanceValidator?: GeneratedModelValidatorEnhancer;
}): string {
  const codecId = options.name;
  const enabled = options.profileValidation !== false;
  const schema = schemaForDescriptor(options.definitions[options.name], {
    definitions: options.definitions,
    executableBindings: true,
    representation: 'model',
  });
  const payload = typeof schema === 'boolean'
    ? (schema ? { $id: codecId } : { $id: codecId, not: true })
    : { $id: codecId, ...schema };
  const resolved = inlineGeneratedModelRefs(payload as object);
  if (enabled) {
    const bindings = options.bindings ?? {};
    const ajvFast = createOpenApiSyncAjvEngine({ allErrors: false, validationBindings: bindings });
    const ajvAll = createOpenApiSyncAjvEngine({ allErrors: true, validationBindings: bindings });
    ajvFast.addSchema(resolved, codecId);
    ajvAll.addSchema(resolved, codecId);
    const validateFast = requireAjvSchema(ajvFast.getSchema(codecId), codecId);
    const validateAll = requireAjvSchema(ajvAll.getSchema(codecId), codecId);
    function validate(value: unknown, optionsArg?: { readonly failFast?: boolean }): value is Record<string, unknown> {
      const validator = serdeFailFast(optionsArg) ? validateFast : validateAll;
      const ok = validator(value) === true;
      (validate as { errors?: unknown }).errors = validator.errors;
      return ok;
    }
    createObjectCodec(codecId, {
      stringify: () => { throw new Error('not used'); },
      parse: () => { throw new Error('not used'); },
      validate,
      assert: (value) => {
        if (validateFast(value) !== true) validationFailure(ajvIssues(validateFast, value, IssueRepresentation.Model));
        return value as never;
      },
      toWireFormat: (value) => value,
      fromWireFormat: (wire) => wire as never,
      schema: resolved,
    });
  }
  registerGeneratedModel(options.constructor, {
    fields: options.fields as never,
    // Validation requires conversion metadata; plain field copies stand in for a companion.
    conversion: options.conversion ?? {
      decode: (value) => Object.assign(Object.create(options.constructor.prototype) as Model, value),
      encode: (model) => ({ ...model }),
    },
    codecId,
    profile: { validation: enabled },
    ...(options.enhanceValidator ? { enhanceValidator: options.enhanceValidator } : {}),
  });
  registerIModelClass(codecId, options.constructor as never);
  return codecId;
}
