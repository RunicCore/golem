import {
  action,
  computed,
  makeObservable,
  observable,
} from 'mobx';
import {
  getValidator as getPlainValidator,
  ModelValidator as PlainModelValidator,
} from './validation.js';

const enhancedValidators = new WeakSet<object>();

type ValidatorObservableKeys =
  | 'issuesValue'
  | 'pendingValue'
  | 'issues'
  | 'errors'
  | 'valid'
  | 'pending'
  | 'setIssues'
  | 'setPending'
  | 'clear'
  | 'setErrors';

export function enhanceValidatorWithMobX<
  Fields extends object = object,
  Owner extends object = Fields,
>(validator: PlainModelValidator<Fields, Owner>): PlainModelValidator<Fields, Owner> {
  if (!enhancedValidators.has(validator)) {
    makeObservable<PlainModelValidator<Fields, Owner>, ValidatorObservableKeys>(
      validator,
      {
        issuesValue: observable.shallow,
        pendingValue: observable,
        issues: computed,
        errors: computed,
        valid: computed,
        pending: computed,
        setIssues: action,
        setPending: action,
        clear: action,
        setErrors: action,
      },
    );
    enhancedValidators.add(validator);
  }
  return validator;
}

export class ModelValidator<Fields extends object, Owner extends object = Fields>
  extends PlainModelValidator<Fields, Owner> {
  public constructor(model: Owner) {
    super(model);
    enhanceValidatorWithMobX(this);
  }
}

/** The model's stateful validator, observable through MobX. */
export function getValidator<Fields extends object = object, Owner extends object = Fields>(
  model: Owner,
): PlainModelValidator<Fields, Owner> {
  // The dependency-free module owns instance identity and state.  This
  // adapter only adds observability, so plain and MobX callers share one
  // validator for a model instance.
  return enhanceValidatorWithMobX(getPlainValidator<Fields, Owner>(model));
}

export type {
  ModelField,
  ModelRuntimeValidator,
  ModelValidationRules,
  Issue,
  ValidationMessage,
  ValidationMessages,
} from './validation.js';
export {
  configureModelValidationEngine,
  registerModelValidationEngineFactory,
} from './validation.js';
