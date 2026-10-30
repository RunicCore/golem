/**
 * The runtime names that generated model code and rewritten sources import (`@exprtlabs/golem/internal/model-runtime`).
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 */
export type { GeneratedModelConversion, GeneratedModelValidatorEnhancer } from './model-registry.js';
export type { ObjectCodecImpl } from './object-codec.js';
export { findGeneratedModelDefinition, findGeneratedModelDefinitionForConstructor, registerGeneratedModel } from './model-registry.js';
export {
  assertAcyclicEncodeInput, assertPropertyAcyclic, assertWireAcyclic, beginDecode, beginEncode, convertModelField, convertModelItems,
  convertModelRecord, convertModelTupleItems, copyModelRecord, decodeCheckedInput, decodeDetachedInput, decodeGeneratedModelTrusted,
  defineModelProperty, deserializeDate, endDecode, endEncode, isVariantObject, jsonWithDiscriminator, rejectModelObject, rejectNonStringWire,
  requireModelObject, serializeDate, unknownDiscriminatorValue, withDeclaredFields, withDiscriminatorValue,
} from './conversion.js';
export {
  assertModelValue, createObjectCodec, fastable, isValidModelValue, parseJson, registerIModelClass, requireIModelClass, requireObjectCodec, serdeValidates,
  stringifyJsonArray, stringifyJsonBoolean, stringifyJsonNumber, stringifyJsonScalar, stringifyJsonString, validationUnavailableStub,
} from './object-codec.js';
export { IssueRepresentation, IssueSource } from './errors.js';
export { withoutInstanceState } from './presence.js';
