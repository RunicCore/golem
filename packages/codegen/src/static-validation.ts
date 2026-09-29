import type { ModelRuntimeValidationEngine, ModelRuntimeValidator } from './model.js';
import { LibError, LibErrorKind } from './errors.js';

/** An engine over compiled schemas; it never compiles or accepts new schemas. */
export function createStaticValidationEngine(
  validators: Readonly<Record<string, ModelRuntimeValidator>>,
  schemas: Readonly<Record<string, object | boolean>>,
): ModelRuntimeValidationEngine {
  const compiled = Object.freeze({ ...validators });
  // Resource lookups are cheap; the schema text is compared only when an add is attempted.
  const resources = new Map<string, object | boolean>(Object.entries(schemas));
  for (const schema of Object.values(schemas)) {
    if (typeof schema !== 'object') continue;
    const defs: unknown = Reflect.get(schema, '$defs');
    if (!defs || typeof defs !== 'object') continue;
    for (const resource of Object.values(defs)) {
      if (!resource || typeof resource !== 'object') continue;
      const id: unknown = Reflect.get(resource, '$id');
      if (typeof id === 'string') resources.set(id, resource);
    }
  }
  return {
    getSchema(reference) { return Object.hasOwn(compiled, reference) ? compiled[reference] : undefined; },
    addSchema(schema, id) {
      const compiledSchema = resources.get(id);
      if (compiledSchema === undefined || JSON.stringify(compiledSchema) !== JSON.stringify(schema)) {
        throw new LibError(LibErrorKind.ValidationUnavailable, `This validation engine cannot add or replace compiled schema ${id}. Regenerate the validators.`);
      }
    },
  };
}
