/**
 * The helpers that the built-in generators share and an extension generator does not need (`@exprtlabs/golem/internal/generator-support`).
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 * The extension API stays on `@exprtlabs/golem/generator-api`.
 */
export {
  DEFAULT_CONTROLLER_SUFFIXES, DEFAULT_MODEL_SUFFIXES, canonicalPath, displayPath, isRecord, outsideModelsRootMessage, stripSourceSuffix,
  suffixPattern,
} from './generator-core.js';
export {
  NameScope, RESERVED_BINDING_NAMES, RESERVED_MODEL_MEMBERS, assertPortableFilenames, bindingName, camelIdentifier, identifier,
} from './names.js';
export { sourceDigest } from './model-manifest-core.js';
export { queryFieldTable } from './query-fields.js';
export { parameterStyleRule } from '../client-runtime/parameter-styles.js';
export { mediaEssence } from '../client-runtime/media-type.js';
export type { ParameterLocation, ParameterStyleRule } from '../client-runtime/parameter-styles.js';
export { schemaIssueMessage } from '../issue-messages.js';
