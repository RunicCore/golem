/**
 * The extension API (`@exprtlabs/golem/generator-api`): the job contract that an extension generator package implements, and the
 * helpers it shares with the built-in generators. Providers return contents; the CLI owns all writes.
 */
export {
  compareText,
  discoverSources,
  GolemDiagnosticSeverity,
  isInsideDirectory,
  parseYamlFile,
  resolveProfile,
  stableJson,
  stableValue,
  YamlFileError,
} from './generator-core.js';
export type {
  ControllerContext,
  ControllerModels,
  ControllerTag,
  ControllerUriVersioning,
  ControllerUriVersioningType,
  GeneratorJobContext,
  GeneratorSession,
  GolemArtifact,
  GolemDiagnostic,
  GolemDiagnosticCode,
  GolemProfile,
  GolemProvider,
  GolemResult,
  InputObserver,
  ModelContext,
  OpenApiContext,
  ResolvedGolemProfile,
  SourceDiscoveryOptions,
} from './generator-core.js';
