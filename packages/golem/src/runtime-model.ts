/**
 * The runtime names that generated model code and rewritten sources import (`@exprtlabs/golem/internal/model-runtime`).
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 */
export { findGeneratedModelDefinition, findGeneratedModelDefinitionForConstructor, registerGeneratedModel } from './model.js';
export {
  assertAcyclicEncodeInput, assertPropertyAcyclic, assertWireAcyclic, beginDecode, beginEncode, convertModelField, convertModelItems,
  convertModelRecord, convertModelTupleItems, copyModelRecord, decodeCheckedInput, decodeDetachedInput, decodeGeneratedModelTrusted,
  defineModelProperty, deserializeDate, encodeGeneratedModel, endDecode, endEncode, isVariantObject, jsonWithDiscriminator, rejectModelObject,
  requireModelObject, serializeDate, unknownDiscriminatorValue, withDiscriminatorValue,
} from './conversion.js';
export {
  assertModelValue, createObjectCodec, isValidModelValue, IssueRepresentation, IssueSource, parseJson, registerIModelClass, requireIModelClass,
  requireObjectCodec, serdeValidates, stringifyJsonArray, stringifyJsonBoolean, stringifyJsonNumber, stringifyJsonScalar, stringifyJsonString,
  validationUnavailableStub, withoutInstanceState,
} from './serde.js';
// One serialize and one deserialize function for each Temporal type; the OpenAPI model emitter picks them by name.
export * from './temporal.js';
