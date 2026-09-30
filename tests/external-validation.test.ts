import assert from 'node:assert/strict';
import test from 'node:test';

import {
  registerGeneratedModel,
  findGeneratedModelDefinition,
  findGeneratedModelDefinitionForConstructor,
  type GeneratedModel,
  type GeneratedModelValidatorEnhancer,
  type generatedModelFieldsBrand,
  type generatedModelWireBrand,
  type ModelTypeDescriptor,
} from '@exprtlabs/golem/model';
import { installCodecModel } from './register-codec-model.js';
import { enhanceValidatorWithMobX } from '@exprtlabs/golem/mobx-validation';
import {
  getValidator,
  validateInstance,
  type ModelValidator,
} from '@exprtlabs/golem/validation';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';

type NumberModel = GeneratedModel<{ value: number }, { value: number }>;

// Declaration-only check: a handwritten subclass gets the generated field
// type through the erased brand, so a rule can name `value` without generic
// arguments or a model lookup table.
class BrandedBase implements GeneratedModel<{ value: string }, { value: number }> {
  declare readonly [generatedModelWireBrand]: { value: string };
  declare readonly [generatedModelFieldsBrand]: { value: number };
  declare value: number;
}
class BrandedChild extends BrandedBase {
  public registerRule(): ModelValidator<{ value: number }, this> {
    return getValidator(this).extend({ value: value => value > 0 || 'positive' });
  }
}
type BrandedChildFields = BrandedChild[typeof generatedModelFieldsBrand];
const brandedField: keyof BrandedChildFields = 'value';
void brandedField;
const enhancerTypeCheck: GeneratedModelValidatorEnhancer = enhanceValidatorWithMobX;
void enhancerTypeCheck;

function generated<Model extends object>(model: Model): Model & NumberModel {
  return model as Model & NumberModel;
}

const numberDescriptor: ModelTypeDescriptor = {
  kind: 'object',
  properties: { value: { kind: 'number' } },
  required: ['value'],
  additionalProperties: false,
};

function registerNumberModel(
  constructor: new (...args: never[]) => { value: number },
  options: {
    readonly validation: boolean;
    readonly encode?: (model: { value: number }) => unknown;
    readonly enhanceValidator?: GeneratedModelValidatorEnhancer;
  } = { validation: true },
): void {
  installCodecModel({
    constructor,
    name: `NumberModel_${constructor.name}`,
    fields: ['value'],
    profileValidation: options.validation,
    conversion: {
      decode: value => Object.assign(new constructor(), value as object),
      encode: options.encode ?? (model => ({ value: model.value })),
    },
    definitions: { [`NumberModel_${constructor.name}`]: numberDescriptor },
    ...(options.enhanceValidator ? { enhanceValidator: options.enhanceValidator } : {}),
  });
}

test('validate collects model issues without creating validator state', async () => {
  class NumberModel {
    public value = 0;
  }
  registerNumberModel(NumberModel);
  const model = new NumberModel();
  const issues = await validateInstance(generated(model));
  assert.deepEqual(issues, []);
  assert.equal(Object.isFrozen(issues), true);
  assert.equal(Object.keys(model).includes('$validator'), false);
  assert.equal(Object.keys(model).includes('value'), true);
});

test('getValidator is stable, keeps rules in instance state, and stateless validation does not mutate it', async () => {
  class NumberModel {
    public value = 0;
  }
  registerNumberModel(NumberModel);
  const model = new NumberModel();
  const validator = getValidator(generated(model));
  const same = getValidator(generated(model));
  assert.strictEqual(validator, same);

  validator.extend({ value: () => 'Value must be positive.' });
  await validator.validate();
  const stored = validator.issues;
  validator.setErrors({ value: 'Server rejected the value.' });
  const withExternalError = validator.issues;

  const issues = await validateInstance(generated(model));
  assert.equal(issues.some(issue => issue.message === 'Value must be positive.'), true);
  assert.strictEqual(validator.issues, withExternalError);
  assert.notStrictEqual(issues, stored);
  assert.deepEqual(validator.errorsFor('value'), ['Value must be positive.', 'Server rejected the value.']);
});

test('a failed validator enhancer is not cached and can be retried', () => {
  class NumberModel {
    public value = 1;
  }
  let enhancerCalls = 0;
  registerNumberModel(NumberModel, {
    validation: true,
    enhanceValidator: validator => {
      enhancerCalls += 1;
      if (enhancerCalls === 1) throw new Error('enhancer failed');
      return validator;
    },
  });

  const model = generated(new NumberModel());
  assert.throws(() => getValidator(model), /enhancer failed/);
  const validator = getValidator(model);
  assert.strictEqual(getValidator(model), validator);
  assert.equal(enhancerCalls, 2);
});

test('getValidator and validate reject disabled validation before conversion', async () => {
  let encodeCalls = 0;
  class DisabledModel {
    public value = 1;
  }
  registerGeneratedModel(DisabledModel, {
    fields: ['value'],
    profile: { validation: false },
    conversion: {
      decode: value => Object.assign(new DisabledModel(), value as object),
      encode: model => {
        encodeCalls += 1;
        return { value: model.value };
      },
    },
  });
  const model = generated(new DisabledModel());
  assert.throws(
    () => getValidator(model),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
  await assert.rejects(
    () => validateInstance(model),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
  assert.equal(encodeCalls, 0);
});

test('model metadata is resolved through the prototype, not an instance constructor field', async () => {
  class BaseModel {
    public value = 1;
  }
  class ChildModel extends BaseModel {}
  registerNumberModel(BaseModel);
  const child = generated(new ChildModel());
  // Shadow runtime identity without adding an unexpected serialized field.
  Object.defineProperty(child, 'constructor', { configurable: true, enumerable: false, value: class Foreign {} });
  assert.deepEqual(await validateInstance(child), []);
  assert.equal(getValidator(child) instanceof Object, true);
  assert.deepEqual(encodeGeneratedModel(child), { value: 1 });
});

test('missing conversion and validation metadata fail before rules can run', async () => {
  class IncompleteModel {
    public value = 1;
  }
  registerGeneratedModel(IncompleteModel, {
    fields: ['value'],
    profile: { validation: true },
  });
  assert.throws(
    () => getValidator(generated(new IncompleteModel())),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
});

test('frozen models support stateless operations and previously initialized validation state', async () => {
  class FrozenModel { public value = 1; }
  registerNumberModel(FrozenModel);
  const frozen = generated(Object.freeze(new FrozenModel()));
  const symbols = Object.getOwnPropertySymbols(frozen);
  assert.deepEqual(await validateInstance(frozen), []);
  assert.deepEqual(encodeGeneratedModel(frozen), { value: 1 });
  assert.deepEqual(Object.getOwnPropertySymbols(frozen), symbols);
  assert.throws(() => getValidator(frozen), (error: unknown) =>
    error instanceof LibError && error.kind === LibErrorKind.Validation && error.cause instanceof TypeError);
  assert.deepEqual(Object.getOwnPropertySymbols(frozen), symbols);

  const editable = generated(new FrozenModel());
  const validator = getValidator(editable);
  Object.freeze(editable);
  assert.strictEqual(getValidator(editable), validator);
  validator.extend({ value: () => 'Existing state remains usable.' });
  assert.equal(await validator.validate(), false);
  validator.clear();
  assert.deepEqual(validator.issues, []);
});

test('an instance never inherits the validator or rules of another instance', async () => {
  class NumberModel { public value = 1; }
  registerNumberModel(NumberModel);
  const original = generated(new NumberModel());
  const originalValidator = getValidator(original).extend({ value: () => 'Only the original.' });
  const derived = generated(Object.create(original) as NumberModel);
  const derivedValidator = getValidator(derived);
  assert.notStrictEqual(derivedValidator, originalValidator);
  assert.equal(await originalValidator.validate(), false);
  assert.equal(await derivedValidator.validate(), true);
  assert.deepEqual(await validateInstance(derived), []);
});

test('derived registration shadows inherited metadata and failed replacement leaves both attachments intact', async () => {
  class Base { public value = 1; }
  class Derived extends Base { public label = 'child'; }
  registerNumberModel(Base);
  const parent = findGeneratedModelDefinitionForConstructor(Base);
  assert.strictEqual(findGeneratedModelDefinition(new Derived()), parent);
  const registerDerived = () => registerGeneratedModel(Derived, {
    fields: ['value', 'label'],
    profile: { validation: false },
    conversion: {
      encode: model => ({ value: model.value, label: model.label }),
      decode: () => new Derived(),
    },
  });
  registerDerived();
  const first = findGeneratedModelDefinitionForConstructor(Derived);
  registerDerived();
  const replacement = findGeneratedModelDefinitionForConstructor(Derived);
  assert.notStrictEqual(replacement, first);
  assert.notStrictEqual(replacement, parent);
  assert.strictEqual(findGeneratedModelDefinition(new Derived()), replacement);
  assert.strictEqual(findGeneratedModelDefinitionForConstructor(Base), parent);
  assert.deepEqual(encodeGeneratedModel(generated(new Derived())), { value: 1, label: 'child' });
  Object.freeze(Derived.prototype);
  assert.throws(registerDerived, TypeError);
  assert.strictEqual(findGeneratedModelDefinitionForConstructor(Derived), replacement);
  assert.strictEqual(findGeneratedModelDefinition(new Derived()), replacement);
});
