/**
 * The runtime names that rewritten controller sources import when they need the `@nestjs/common` peer dependency
 * (`@exprtlabs/golem/internal/nest-runtime`).
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 */
export { nestModelCodec, nestModelReturn, nestModelUnion } from './nest-binding.js';
