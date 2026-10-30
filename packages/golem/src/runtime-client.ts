/**
 * The runtime names that a generated OpenAPI client imports (entry `internal/client-runtime`). A model-only app never loads it.
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 */
export { applySecurity } from './client-runtime/security.js';
export { convertRequestBody, convertRequestParameters, encodeBody, inboundHandler, requireObjectInput, responseDecoder } from './client-runtime/body-codecs.js';
export {
  addCookieParameter, addCookieStyleParameter, addQueryParameter, appendQuery, encode, serializeContentParameter, serializeHeaderSimple,
  serializePath, setQueryString,
} from './client-runtime/parameters.js';
export { ClientRuntime, isUndeclaredResponseError } from './client-runtime/core.js';
export { createApiOperation } from './client.js';
