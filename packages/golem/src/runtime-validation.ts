/**
 * The runtime names that compiled validators import (entry `internal/validation-runtime`).
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 */
export { checkFormat, codePointLength, formatTest, jsonEqual } from './validation-runtime.js';
