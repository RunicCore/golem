/**
 * The runtime names that a standalone generated SDK imports. golem's build bundles this entry into the one minified file that
 * `@exprtlabs/golem-openapi` ships (`scripts/build-sdk-runtime.mjs`), so an SDK runs with no `@exprtlabs/golem` installed.
 * The entry holds no codec registry, because a standalone SDK registers no codec (no `createObjectCodec`); `model-registry.ts` joins the bundle
 * only through the checks of `conversion.ts`, which golem mode shares and which find no model in a standalone SDK.
 * The path is internal: the names may change in any release.
 */
export * from './runtime-client.js';
export * from './runtime-client-validation.js';
export * from './runtime-temporal.js';
export * from './runtime-validation.js';
export {
  assertAcyclicEncodeInput, assertPropertyAcyclic, assertWireAcyclic, beginDecode, beginEncode, convertModelField, convertModelItems,
  convertModelRecord, convertModelTupleItems, copyModelRecord, decodeCheckedInput, decodeDetachedInput, defineModelProperty,
  deserializeDate, endDecode, endEncode, isVariantObject, jsonWithDiscriminator, rejectModelObject, requireModelObject, serializeDate,
  unknownDiscriminatorValue, withDeclaredFields, withDiscriminatorValue,
} from './conversion.js';
export {
  assertModelValue, fastable, isValidModelValue, parseJson, serdeValidates, stringifyJsonArray, stringifyJsonBoolean,
  stringifyJsonNumber, stringifyJsonScalar, stringifyJsonString, validationUnavailableStub,
} from './object-codec.js';
export { IssueRepresentation, IssueSource, LibError } from './errors.js';
export { withoutInstanceState } from './presence.js';
