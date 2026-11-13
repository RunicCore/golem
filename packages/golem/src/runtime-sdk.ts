/**
 * The runtime names that a standalone generated SDK imports. golem's build bundles this entry into the one minified file that
 * the OpenAPI-to-TypeScript package ships (`scripts/build-sdk-runtime.mjs`), so an SDK runs with no `@exprtlabs/golem` installed.
 * The entry holds no codec registry, because a standalone SDK registers no codec (no `createObjectCodec`). The bundle takes from
 * `model-registry.ts` only the lookups that `conversion.ts` calls (`findGeneratedModelDefinition`, `isGeneratedModel`), which find no
 * model in a standalone SDK; `registerGeneratedModel` stays out.
 * The path is internal: the names may change in any release.
 */
export * from './runtime-client.js';
export * from './runtime-client-validation.js';
export * from './runtime-temporal.js';
export * from './runtime-validation.js';
export {
  assertAcyclicEncodeInput, assertPropertyAcyclic, assertWireAcyclic, beginDecode, beginEncode, constructModel, convertModelField, convertModelItems,
  convertModelRecord, convertModelTupleItems, copyModelRecord, decodeCheckedInput, decodeDetachedInput, defineModelProperty,
  deserializeDate, endDecode, endEncode, isVariantObject, jsonWithDiscriminator, rejectModelObject, wireChecked, requireModelObject, serializeDate,
  stripPlan, stripUndeclared, unknownDiscriminatorValue, withDeclaredFields, withDiscriminatorValue,
} from './conversion.js';
export {
  assertModelValue, fastable, isValidModelValue, parseJson, serdeValidates, stringifyJsonArray, stringifyJsonBoolean,
  stringifyJsonNumber, stringifyJsonScalar, stringifyJsonString, validationUnavailableStub,
} from './object-codec.js';
export { IssueRepresentation, IssueSource, LibError } from './errors.js';
export { withoutInstanceState } from './presence.js';
