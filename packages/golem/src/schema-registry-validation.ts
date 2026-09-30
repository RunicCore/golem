import { LibError, LibErrorKind } from './errors.js';
import { runValidation } from './validation-runner.js';

export interface ValidationResult {
  valid: boolean;
  errors?: readonly unknown[] | null;
}

export interface RuntimeValidator {
  (value: unknown): boolean | Promise<boolean>;
  readonly errors?: readonly unknown[] | null;
}

/**
 * Adapter boundary for a JSON Schema implementation that supports the emitted
 * schemaDialect. Constraints not representable in TypeScript remain enforced
 * by this runtime engine.
 */
export interface RuntimeValidationEngine {
  addSchema(schema: object | boolean, id: string): void;
  getSchema(reference: string): RuntimeValidator | undefined;
}

export interface OperationRuntimeValidators {
  readonly input: RuntimeValidator;
  readonly responses: ReadonlyMap<string, RuntimeValidator>;
}

/** Schema data a generated SDK binds to its runtime validators. */
export interface SchemaRegistryData<Schema extends string, Operation extends string> {
  readonly schemaRegistry: { readonly $id: string };
  readonly runtimeSchemaRegistry: object;
  readonly schemaNames: readonly Schema[];
  readonly operationNames: readonly Operation[];
  readonly operationResponseSchemaEntries: readonly (readonly [Operation, string, string])[];
  schemaReference(name: Schema): string;
  operationInputReference(name: Operation): string;
  operationResponseReference(name: Operation, status: string, contentType: string): string;
}

function registerSchemaRegistry<S extends string, O extends string>(
  engine: RuntimeValidationEngine,
  data: SchemaRegistryData<S, O>,
): void {
  const { schemaRegistry, runtimeSchemaRegistry } = data;
  if (!engine.getSchema(schemaRegistry.$id)) {
    engine.addSchema(runtimeSchemaRegistry, schemaRegistry.$id);
  }
  const defs = Reflect.get(runtimeSchemaRegistry, '$defs');
  if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
    for (const resource of Object.values(defs as Record<string, unknown>)) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
      const id = Reflect.get(resource, '$id');
      if (typeof id === 'string' && !engine.getSchema(id)) {
        engine.addSchema(resource, id);
      }
    }
  }
}

export function createRegistryValidators<S extends string, O extends string>(
  engine: RuntimeValidationEngine,
  data: SchemaRegistryData<S, O>,
): ReadonlyMap<S, RuntimeValidator> {
  registerSchemaRegistry(engine, data);
  const validators = new Map<S, RuntimeValidator>();
  for (const name of data.schemaNames) {
    const validator = engine.getSchema(data.schemaReference(name));
    if (!validator) throw new LibError(LibErrorKind.ValidationUnavailable, `Runtime validator could not compile schema: ${name}`);
    validators.set(name, validator);
  }
  return validators;
}

export function createRegistryOperationValidators<S extends string, O extends string>(
  engine: RuntimeValidationEngine,
  data: SchemaRegistryData<S, O>,
): ReadonlyMap<O, OperationRuntimeValidators> {
  registerSchemaRegistry(engine, data);
  const responseEntries = new Map<O, Array<readonly [string, string]>>();
  for (const [name, status, contentType] of data.operationResponseSchemaEntries) {
    const entries = responseEntries.get(name) ?? [];
    entries.push([status, contentType]);
    responseEntries.set(name, entries);
  }
  const validators = new Map<O, OperationRuntimeValidators>();
  for (const name of data.operationNames) {
    const input = engine.getSchema(data.operationInputReference(name));
    if (!input) throw new LibError(LibErrorKind.ValidationUnavailable, `Runtime validator could not compile operation input: ${name}`);
    const responses = new Map<string, RuntimeValidator>();
    for (const [status, contentType] of responseEntries.get(name) ?? []) {
      const validator = engine.getSchema(data.operationResponseReference(name, status, contentType));
      if (!validator) {
        throw new LibError(LibErrorKind.ValidationUnavailable, `Runtime validator could not compile operation response: ${name} ${status} ${contentType}`);
      }
      responses.set(`${status}:${contentType}`, validator);
    }
    validators.set(name, { input, responses });
  }
  return validators;
}

export async function validateWith(
  validator: RuntimeValidator,
  value: unknown,
): Promise<ValidationResult> {
  return runValidation(validator, value);
}
