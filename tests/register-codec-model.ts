import {
  registerGeneratedModel,
  type GeneratedModelConversion,
  type GeneratedModelValidatorEnhancer,
  type ModelTypeDescriptor,
} from '@exprtlabs/golem/model';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX, schemaForDescriptor } from '@exprtlabs/golem/internal/schema';
import {
  assertModelValue,
  createObjectCodec,
  isValidModelValue,
  registerIModelClass,
  requireObjectCodec,
  IssueRepresentation,
  IssueSource,
} from '@exprtlabs/golem/serde';
import { compileValidators } from './support/compiled-validators.js';

/** Where a compiled module finds the test's own validation functions: files cannot carry closures. */
const BINDINGS = Symbol.for('golem.test.validationBindings');

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

/** Registers a model whose codec validates with validators compiled from the descriptor's schema. */
export async function installCodecModel<Model extends object>(options: {
  readonly constructor: abstract new (...arguments_: never[]) => Model;
  readonly name: string;
  readonly fields: readonly string[];
  readonly definitions: Readonly<Record<string, ModelTypeDescriptor>>;
  readonly conversion?: GeneratedModelConversion<Model, unknown>;
  readonly bindings?: Readonly<Record<string, (value: unknown) => boolean | string>>;
  readonly nestedCodecIds?: readonly string[];
  readonly profileValidation?: boolean;
  readonly enhanceValidator?: GeneratedModelValidatorEnhancer;
}): Promise<string> {
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
    const ids = Object.keys(bindings);
    const registry = globalThis as { [BINDINGS]?: Record<string, Record<string, (value: unknown) => boolean | string>> };
    registry[BINDINGS] = { ...registry[BINDINGS], [codecId]: bindings };
    const validators = await compileValidators({
      roots: { [codecId]: resolved },
      validations: Object.fromEntries(ids.map((id, index) => [id, { importPath: './bindings.mjs', exportName: `binding${index}` }])),
      modules: {
        'bindings.mjs': ids.map((id, index) => `export const binding${index} = (value) => globalThis[Symbol.for('golem.test.validationBindings')][${JSON.stringify(codecId)}][${JSON.stringify(id)}](value);`).join('\n'),
      },
    });
    const validator = validators[codecId];
    createObjectCodec(codecId, {
      stringify: () => { throw new Error('not used'); },
      parse: () => { throw new Error('not used'); },
      validate: (value, optionsArg) => isValidModelValue(value, optionsArg, validator, codecId),
      assert: (value, optionsArg) => {
        assertModelValue(value, optionsArg, validator, codecId, IssueRepresentation.Model, IssueSource.TypeScript);
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
