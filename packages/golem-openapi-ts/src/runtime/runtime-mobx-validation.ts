/**
 * The runtime name that generated code imports when its profile has both `mobx` and `validation`
 * (`@exprtlabs/golem-openapi-ts/internal/mobx-validation-runtime`). It is apart from `internal/mobx-runtime` so that an app with `mobx` and no
 * validation does not load the validation code.
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the name may change in any release.
 */
export { enhanceValidatorWithMobX } from './mobx-validation.js';
