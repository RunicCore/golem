/**
 * Schema keywords shared by runtime validation and the build-time schema
 * assembly. Kept apart so runtime entries never load schema assembly.
 */

/** Custom-predicate envelope: `{ schema, bindings }` or a binding list. */
export const VALIDATION_KEYWORD = 'exprtValidation';
/** Internal model-plane keyword; wire/OpenAPI dates remain date-time strings. */
export const MODEL_DATE_KEYWORD = 'golemModelDate';
/** Model plane only: ties a union branch to the variant class its encoder selects. */
export const MODEL_INSTANCE_KEYWORD = 'golemModelInstance';
/**
 * Placeholder `$ref` for an external generated-model codec. Emit replaces this
 * with the nested codec's runtime id and `addSchema`s that codec's payload.
 */
export const GENERATED_MODEL_SCHEMA_REF_PREFIX = '__exprtGeneratedModel:';
