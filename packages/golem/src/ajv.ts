import * as AddFormatsModule from 'ajv-formats';
import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type Options,
  ValidationError,
  type AsyncValidateFunction,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { lowerDiscriminatorMappings } from './discriminator-mapping.js';
import {
  addModelKeywords,
  addValidationKeyword,
  type ValidationBindings,
} from './ajv-keywords.js';
import { LibError, LibErrorKind } from './errors.js';

/** The Ajv-era validator contracts, kept with the Ajv adapter until it is removed. */
export interface ModelRuntimeValidator {
  (value: unknown): boolean | Promise<boolean>;
  readonly errors?: readonly unknown[] | null;
}

/** A generated/JIT Ajv validator whose provider guarantees synchronous execution. */
export interface ModelRuntimeSyncValidator {
  (value: unknown): boolean;
  readonly errors?: readonly unknown[] | null;
}

export interface ModelRuntimeValidationEngine {
  addSchema(schema: object | boolean, id: string): void;
  getSchema(reference: string): ModelRuntimeValidator | undefined;
}

type AnyValidateFunction = ValidateFunction | AsyncValidateFunction;

function isFormatsPlugin(value: unknown): value is FormatsPlugin {
  return typeof value === 'function' && 'get' in value && typeof value.get === 'function';
}
const formatsPlugin: unknown = AddFormatsModule.default;
if (!isFormatsPlugin(formatsPlugin)) throw new TypeError('ajv-formats did not export its formats plugin.');
const addFormats = formatsPlugin;

export type OpenApiRuntimeValidator = ModelRuntimeValidator;
export type OpenApiSyncRuntimeValidator = ModelRuntimeSyncValidator;

export interface OpenApiRuntimeValidationEngine extends ModelRuntimeValidationEngine {
  addSchema(schema: AnySchema, id: string): void;
  getSchema(reference: string): OpenApiRuntimeValidator | undefined;
}

/** Sync-only provider used by generated object codecs. */
export interface OpenApiSyncRuntimeValidationEngine extends ModelRuntimeValidationEngine {
  addSchema(schema: AnySchema, id: string): void;
  getSchema(reference: string): OpenApiSyncRuntimeValidator | undefined;
}

export interface OpenApiAjvOptions extends Options {
  readonly validationBindings?: ValidationBindings;
  /**
   * OAS 3.1/3.2 use the OpenAPI JSON Schema dialect. The runtime preserves
   * that dialect URI but uses Ajv's 2020-12 evaluator for its JSON Schema
   * vocabularies and the OAS base vocabulary as annotations.
   */
  validateSchema?: boolean;
}

function wrapSyncValidator(validate: ValidateFunction): OpenApiSyncRuntimeValidator {
  function runtimeValidator(this: unknown, value: unknown): boolean {
    return validate.call(this, value);
  }
  Object.defineProperty(runtimeValidator, 'errors', {
    enumerable: true,
    get: () => validate.errors as readonly ErrorObject[] | null | undefined,
  });
  return runtimeValidator;
}

function createAjv(options: OpenApiAjvOptions): Ajv2020 {
  const { validationBindings, ...ajvOptions } = options;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateSchema: false,
    discriminator: true,
    ...ajvOptions,
  });
  addFormats(ajv);
  addModelKeywords(ajv);
  addValidationKeyword(ajv, validationBindings);
  return ajv;
}

export function createOpenApiAjvEngine(
  options: OpenApiAjvOptions = {},
): OpenApiRuntimeValidationEngine {
  const ajv = createAjv(options);
  const wrappers = new WeakMap<AnyValidateFunction, OpenApiRuntimeValidator>();
  return {
    addSchema(schema, id): void {
      ajv.addSchema(lowerDiscriminatorMappings(schema), id);
    },
    getSchema(reference): OpenApiRuntimeValidator | undefined {
      const validator = ajv.getSchema(reference);
      if (!validator) return undefined;
      let wrapper = wrappers.get(validator);
      if (!wrapper) {
        wrapper = wrapGeneralValidator(validator);
        wrappers.set(validator, wrapper);
      }
      return wrapper;
    },
  };
}

function wrapGeneralValidator(validate: AnyValidateFunction): OpenApiRuntimeValidator {
  if (isAsyncAjvValidator(validate)) {
    let errors: readonly unknown[] | null = null;
    const runtimeValidator: ModelRuntimeValidator = async function(this: unknown, value: unknown): Promise<boolean> {
      try {
        await validate.call(this, value);
        errors = null;
        return true;
      } catch (error) {
        if (error instanceof ValidationError) {
          errors = error.errors;
          return false;
        }
        throw error;
      }
    };
    Object.defineProperty(runtimeValidator, 'errors', {
      enumerable: true,
      get: () => errors,
    });
    return runtimeValidator;
  }
  const runtimeValidator = wrapSyncValidator(validate);
  return runtimeValidator;
}

/**
 * Generated codecs expose synchronous validate/assert APIs. This provider
 * checks Ajv's async marker once when a schema is resolved, keeping the warm
 * validation call synchronous and direct.
 */
export function createOpenApiSyncAjvEngine(
  options: OpenApiAjvOptions = {},
): OpenApiSyncRuntimeValidationEngine {
  const ajv = createAjv(options);
  const wrappers = new WeakMap<ValidateFunction, OpenApiSyncRuntimeValidator>();
  return {
    addSchema(schema, id): void {
      ajv.addSchema(lowerDiscriminatorMappings(schema), id);
    },
    getSchema(reference): OpenApiSyncRuntimeValidator | undefined {
      const validator = ajv.getSchema(reference);
      if (!validator) return undefined;
      if (isAsyncAjvValidator(validator)) {
        throw new LibError(
          LibErrorKind.ValidationUnavailable,
          `Schema ${JSON.stringify(reference)} uses asynchronous Ajv validation; generated synchronous model APIs require a synchronous schema.`,
        );
      }
      const syncValidator = validator;
      let wrapper = wrappers.get(syncValidator);
      if (!wrapper) {
        wrapper = wrapSyncValidator(syncValidator);
        wrappers.set(syncValidator, wrapper);
      }
      return wrapper;
    },
  };
}

function isAsyncAjvValidator(validator: AnyValidateFunction): validator is AsyncValidateFunction {
  return '$async' in validator && validator.$async === true;
}
