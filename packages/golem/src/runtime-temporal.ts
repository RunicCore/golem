/**
 * The runtime names that generated code imports when a model has a Temporal field (entry `internal/temporal-runtime`).
 * A model with no Temporal field never loads it, so its declaration files need no `esnext.temporal` lib.
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 */
// One serialize and one deserialize function for each Temporal type; the OpenAPI model emitter picks them by name.
export * from './temporal.js';
