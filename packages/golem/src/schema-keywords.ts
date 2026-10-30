/**
 * Schema keywords shared by runtime validation and the build-time schema
 * assembly. Kept apart so runtime entries never load schema assembly.
 */

/** Custom-predicate envelope: `{ schema, bindings }` or a binding list. */
export const VALIDATION_KEYWORD = 'exprtValidation';
/** Model plane only: the value of a class-valued field must be an instance of its class (`{ name, path, id? }`; see `ModelTypeDescriptor`, `classRef`). */
export const MODEL_CLASS_KEYWORD = 'golemModelClass';
/** Model plane only: ties a union branch to the variant class its encoder selects. */
export const MODEL_INSTANCE_KEYWORD = 'golemModelInstance';
/**
 * Registry key of the codec ids a model class lists on its prototype. The runtime
 * registers under it and generated validators read it, so both take it from here.
 */
export const MODEL_CODEC_IDS_KEY = '@exprtlabs/golem:modelCodecIds';
/**
 * Registry key of the declared field names a generated model lists on its own prototype: a frozen array, or `null` for
 * a model that allows additional keys. `instanceFields` (presence.ts) and `instanceFieldsCode` (tooling/union-conversion.ts) read it to tell a
 * declared key from program state.
 */
export const MODEL_FIELDS_KEY = '@exprtlabs/golem:modelFields';
/**
 * Placeholder `$ref` for an external generated-model codec. Emit replaces this
 * with the nested codec's runtime id and `addSchema`s that codec's payload.
 */
export const GENERATED_MODEL_SCHEMA_REF_PREFIX = '__exprtGeneratedModel:';
