/**
 * The extension API (`@exprtlabs/golem/generator-api`): the plan entry and generator entry that a golem package implements, and the
 * helpers it shares with golem's own packages. Providers return contents; the CLI owns all writes.
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
  CodecsHostValue,
  GeneratorHostContext,
  GeneratorSession,
  GolemArtifact,
  GolemDiagnostic,
  GolemDiagnosticCode,
  GolemGeneratorEntry,
  GolemPlanEntry,
  GolemProfile,
  GolemProvider,
  GolemResult,
  InputObserver,
  ModelBoundaryValue,
  PlanContext,
  PlannedJob,
  ResolvedGolemProfile,
  SourceDiscoveryOptions,
} from './generator-core.js';
export type { HookFill, HookParticipants } from './extension-hooks.js';
export type { JobFacts, JobOutput } from './job-facts.js';
export type { GolemExtension, RewriteCore, RewriteParticipant, RewriteParticipantInput, RewriteParticipantResult } from './rewrite-participant.js';
