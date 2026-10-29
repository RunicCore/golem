/**
 * The runtime names that generated code imports when it needs the `mobx` peer dependency (`@exprtlabs/golem/internal/mobx-runtime`).
 * The path is internal: golem build requires each built-in generator at the runtime's exact version, so the names may change in any release.
 */
export { asGenObservable, createObservableApiOperation } from './mobx.js';
// A model-only app with `mobx: true` also loads client validation, because `mobx-validation` imports `validation`.
export { enhanceValidatorWithMobX } from './mobx-validation.js';
