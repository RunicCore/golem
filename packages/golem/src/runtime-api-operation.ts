/**
 * The runtime name that the MobX runtime of `@exprtlabs/golem-openapi-ts` imports (entry `internal/api-operation-runtime`). It stands outside
 * `runtime-client.ts` and `runtime-sdk.ts`, so a standalone SDK copy does not carry it and a model-only app that imports the MobX runtime does not load the client runtime.
 * The path is internal: the name may change in any release.
 */
export { createTrackedApiOperation } from './api-operation.js';
