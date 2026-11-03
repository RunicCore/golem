// The extension entry of mobx (`./mobx-extension`). It fills two hooks and has no rewrite: the validator enhancer that a class model passes to its validator, and the
// observable operation of an SDK client. Hook names are plain text and golem-model is a type import only, because a project may hold only an SDK job.
import type { ValidatorEnhancerParticipant } from '@exprtlabs/golem-model/plan';
import { aliased, packageExport } from '@exprtlabs/golem/internal/emitter';
import { GolemDiagnosticSeverity, type GolemExtension } from '@exprtlabs/golem/generator-api';
import type { OperationWrapperParticipant } from '../plan.js';

/** Where the run-time names of the extension are imported from: values from the internal entry, types from the public subpath. */
const MOBX_RUNTIME = { key: 'mobx', specifier: '@exprtlabs/golem-openapi-ts/internal/mobx-runtime', typeSpecifier: '@exprtlabs/golem-openapi-ts/mobx' } as const;
const MOBX_VALIDATION_RUNTIME = { key: 'mobx-validation', specifier: '@exprtlabs/golem-openapi-ts/internal/mobx-validation-runtime', typeSpecifier: '@exprtlabs/golem-openapi-ts/mobx-validation' } as const;

/** Fills `model.validatorEnhancer`: a class model that validates passes this function as its `enhanceValidator`. */
const validatorEnhancer: ValidatorEnhancerParticipant = () => packageExport({ ...MOBX_VALIDATION_RUNTIME, name: 'enhanceValidatorWithMobX' });

/** Fills `client.operationWrapper`: each operation is an observable operation. A standalone SDK carries no MobX runtime, so the mode golem is required. */
const operationWrapper: OperationWrapperParticipant = (mode) => mode === 'golem'
  ? { wrapper: {
    operationType: aliased(packageExport({ ...MOBX_RUNTIME, name: 'ObservableApiOperation', typeOnly: true }), 'ApiOperation'),
    createOperation: aliased(packageExport({ ...MOBX_RUNTIME, name: 'createObservableApiOperation' }), 'createApiOperation'),
  } }
  : { diagnostic: {
    code: 'OPENAPI_MOBX_NEEDS_GOLEM_MODE',
    severity: GolemDiagnosticSeverity.Error,
    message: 'The mobx extension needs the MobX runtime of @exprtlabs/golem-openapi-ts, which a standalone SDK does not carry. Set mode: golem on this sdks job, or remove extensions: mobx from the openapi-ts block.',
  } };

export const extension: GolemExtension = { hooks: { 'model.validatorEnhancer': validatorEnhancer, 'client.operationWrapper': operationWrapper } };
