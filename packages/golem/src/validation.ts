import { findGeneratedModelDefinition, findGeneratedModelDefinitionForConstructor } from './model-registry.js';
import { presentValue } from './presence.js';
import type { generatedModelFieldsBrand, GeneratedModelConstructor, ModelField, ModelValidationContext } from './model.js';
import type { ModelTypeDescriptor, RegisteredGeneratedModelDefinition } from './model-registry.js';
export type { SchemaIssue, SchemaIssueDetail, Validator } from './validation-runtime.js';
export { runValidation } from './validation-runner.js';
export * from './schema-registry-validation.js';

import {
  assertAcyclicValue,
  defineModelProperty,
} from './conversion.js';
import {
  IssueSource, IssueRepresentation, LibError, LibErrorKind,
  snapshotIssues, toIssue,
  type Issue, type IssueCode, type IssuePath,
} from './errors.js';
export type { Issue, IssuePath } from './errors.js';
import {
  findCodecIdForConstructor,
  requireObjectCodec,
  validationUnfinished,
  untransformedCallError,
  type AllowGetterOptions,
  type ObjectCodec,
  type ValidateOptions,
} from './object-codec.js';

/** Internal continuation policy; both modes use the same rules and schemas. */
export type ValidationMode = 'first' | 'all';

/** `true` or nothing passes; `false`, a message or `{ message }` fails with a `custom` issue. */
export type ValidationRuleResult = boolean | string | { readonly message: string } | undefined | void;
export type ValidationRule<Value, Model extends object> = (value: Value, model: Model) => ValidationRuleResult | Promise<ValidationRuleResult>;
export type ModelValidationRules<Fields extends object, Owner extends object = Fields, Field extends ModelField<Fields> = ModelField<Fields>> = Partial<{
  [Key in Field]: ValidationRule<Fields[Key], Owner> | readonly ValidationRule<Fields[Key], Owner>[];
}>;
export type ValidationMessage = string | ((issue: Issue) => string);
export interface FieldValidationMessage {
  readonly path?: IssuePath;
  readonly code: IssueCode;
  readonly message: ValidationMessage;
}
export type ValidationMessageKey<Model extends object> = IssueCode | `${ModelField<Model>}.${IssueCode}`;
export type ValidationMessages<Model extends object> = Readonly<Partial<Record<ValidationMessageKey<Model>, ValidationMessage>>> | readonly FieldValidationMessage[];
export interface ExternalFieldError { readonly path: IssuePath; readonly message: string | readonly string[] }
type InternalValidationRule = (value: unknown, model: object) => ValidationRuleResult | Promise<ValidationRuleResult>;

interface InstanceRuleRegistration {
  readonly rules: ReadonlyMap<string, readonly InternalValidationRule[]>;
  readonly format: (issue: Issue, explicit: boolean) => Issue;
}

interface InstanceValidationState {
  readonly rules: Map<string, InternalValidationRule[]>;
  readonly messageOverrides: Map<string, ValidationMessage>;
  registration?: InstanceRuleRegistration;
  /** The value is checked as a ModelValidator at the public boundary. */
  validator?: unknown;
}

// State belongs to the model instance.  An own symbol keeps it out of model
// fields, enumeration and JSON while avoiding a global instance registry.
const instanceValidationState = Symbol('exprtlabs.validationState');

function readInstanceValidationState(model: object): InstanceValidationState | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(model, instanceValidationState);
  return descriptor?.value as InstanceValidationState | undefined;
}

function ensureInstanceValidationState(model: object): InstanceValidationState {
  const existing = readInstanceValidationState(model);
  if (existing) return existing;
  const state: InstanceValidationState = {
    rules: new Map(),
    messageOverrides: new Map(),
  };
  const registration: InstanceRuleRegistration = {
    rules: state.rules,
    format: (issue, explicit) => {
      const validator = state.validator;
      if (validator instanceof ModelValidator) return validator.formatIssue(issue, explicit);
      return issue;
    },
  };
  state.registration = registration;
  try {
    Object.defineProperty(model, instanceValidationState, {
      value: state,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch (cause) {
    throw new LibError(
      LibErrorKind.Validation,
      'Validation state cannot be attached to a non-extensible model instance.',
      [],
      { cause, causedByInput: false },
    );
  }
  return state;
}

function instanceRuleRegistration(model: object): InstanceRuleRegistration | undefined {
  const state = readInstanceValidationState(model);
  return state?.registration;
}

/**
 * Rule evaluation stays synchronous until a rule returns a promise; the
 * traversal then suspends and resumes without restarting.
 */
type ValidationStep<Value> = Value | Promise<Value>;

/**
 * Assimilate a thenable exactly once at the suspension boundary.  Calling
 * `Promise.resolve` after probing `.then` would read a user supplied getter a
 * second time; using the captured method preserves callback counts.  The call
 * itself is queued so custom thenables keep the asynchronous scheduling of
 * `await`, while already-normalized promises pass through without another
 * adoption wrapper.
 */
function adoptValidationThenable<Value>(value: unknown): Promise<Value> | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  if (value instanceof Promise) return value as Promise<Value>;
  let then: unknown;
  try {
    then = Reflect.get(value, 'then');
  } catch (cause) {
    return Promise.reject(cause);
  }
  if (typeof then !== 'function') return undefined;
  return new Promise<Value>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        Reflect.apply(then, value, [resolve, reject]);
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

function isNativeValidationPromise<Value>(value: ValidationStep<Value>): value is Promise<Value> {
  return value instanceof Promise;
}

function modelDefinition(model: object) {
  const definition = findGeneratedModelDefinition(model);
  if (!definition) throw new LibError(LibErrorKind.ValidationUnavailable, 'Generated model metadata is missing. Regenerate the model.');
  return definition;
}

function codecIdForDefinition(definition: RegisteredGeneratedModelDefinition): string | undefined {
  return definition.codecId ?? findCodecIdForConstructor(definition.constructor);
}

function objectCodecForDefinition(definition: RegisteredGeneratedModelDefinition): ObjectCodec {
  const codecId = codecIdForDefinition(definition);
  if (!codecId) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      'Generated model codec is not registered. Regenerate the model with validation enabled.',
    );
  }
  return requireObjectCodec(codecId);
}

function issuePointer(path: IssuePath): string {
  return path.map(segment => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** An issue from a model rule, which carries its own message when it has one. */
function customIssue(path: IssuePath, reason?: string): Issue {
  return toIssue({ path, code: 'custom', ...(reason === undefined ? {} : { reason }) }, IssueSource.Custom, IssueRepresentation.Model);
}

function messageOverrideKey(path: IssuePath | null | undefined, code: string): string {
  const normalized = path == null || path.length === 0 ? null : path;
  return JSON.stringify([normalized, code]);
}

/** The model and each generated model along an issue path, with its path offset. */
function ownersForIssue(model: object, issue: Issue): { model: object; offset: number }[] {
  const owners: { model: object; offset: number }[] = [{ model, offset: 0 }];
  let current: unknown = model;
  for (let index = 0; index < issue.path.length; index++) {
    if (current === null || typeof current !== 'object') break;
    current = Reflect.get(current, issue.path[index] as PropertyKey);
    if (current !== null && typeof current === 'object' && findGeneratedModelDefinition(current)) {
      owners.push({ model: current, offset: index + 1 });
    }
  }
  return owners;
}

/** Apply message registrations of each owning model, innermost last. */
function formatIssues(model: object, issues: readonly Issue[]): readonly Issue[] {
  return issues.map(issue => {
    const owners = ownersForIssue(model, issue);
    let formatted = issue;
    const explicit = issue.code === 'custom' && issue.reason !== undefined;
    for (let ownerIndex = owners.length - 1; ownerIndex >= 0; ownerIndex--) {
      const owner = owners[ownerIndex];
      const registration = instanceRuleRegistration(owner.model);
      if (!registration) continue;
      try {
        const local = registration.format({ ...formatted, path: issue.path.slice(owner.offset) }, explicit);
        formatted = { ...local, path: issue.path };
      } catch (cause) {
        if (cause instanceof LibError) throw cause;
        throw new LibError(LibErrorKind.Validation, 'A validation message could not be formatted.', [{ ...issue, source: IssueSource.Custom }], { cause, causedByInput: false });
      }
    }
    return formatted;
  });
}

interface LocalRuleIssue { readonly issue: Issue; readonly explicit: boolean }
const noLocalRuleIssues: readonly LocalRuleIssue[] = [];

/** True when a generated issue sits at the path or below it. */
function hasIssueAtOrBelow(issues: readonly Issue[], path: IssuePath): boolean {
  return issues.some(issue => path.every((segment, index) => String(issue.path[index]) === String(segment)) && issue.path.length >= path.length);
}

function evaluateInstanceRules(root: object, mode: ValidationMode, generated: readonly Issue[]): ValidationStep<readonly Issue[]> {
  const memo = new WeakMap<object, readonly LocalRuleIssue[]>();
  const active = new Set<object>();
  const issues: Issue[] = [];
  const evaluateLocal = (model: object, path: IssuePath): ValidationStep<readonly LocalRuleIssue[]> => {
    const existing = memo.get(model);
    if (existing) return existing;
    const registration = instanceRuleRegistration(model);
    if (!registration) return noLocalRuleIssues;
    const local: LocalRuleIssue[] = [];
    const entries = [...registration.rules.entries()];
    const finish = (): readonly LocalRuleIssue[] => {
      memo.set(model, local);
      return local;
    };
    const appendRuleResult = (field: string, result: ValidationRuleResult): boolean => {
      try {
        if (result === true || result === undefined) return false;
        if (typeof result !== 'boolean' && typeof result !== 'string'
          && (typeof result !== 'object' || result === null || typeof result.message !== 'string')) {
          throw new TypeError('Validation rules must return a boolean, message or issue.');
        }
        const reason = typeof result === 'string' ? result : typeof result === 'object' ? result.message : '';
        local.push({ issue: customIssue([field], reason || undefined), explicit: reason.length > 0 });
        return true;
      } catch (cause) {
        if (cause instanceof LibError) throw cause;
        throw new LibError(LibErrorKind.Validation, 'A custom validation rule could not finish.', [customIssue([...path, field], 'A custom validation rule could not finish.')], { cause, causedByInput: false });
      }
    };
    const evaluateRules = (fieldIndex: number, ruleIndex: number): ValidationStep<readonly LocalRuleIssue[]> => {
      for (let currentFieldIndex = fieldIndex; currentFieldIndex < entries.length; currentFieldIndex++) {
        const [field, rules] = entries[currentFieldIndex];
        // A rule that throws on a value the generated checks already rejected adds nothing: their issue reports that value.
        const rejected = hasIssueAtOrBelow(generated, [...path, field]);
        for (let currentRuleIndex = currentFieldIndex === fieldIndex ? ruleIndex : 0; currentRuleIndex < rules.length; currentRuleIndex++) {
          const rule = rules[currentRuleIndex];
          let rawResult: ValidationRuleResult | Promise<ValidationRuleResult>;
          try {
            rawResult = rule(Reflect.get(model, field), model);
          } catch (cause) {
            if (cause instanceof LibError) throw cause;
            if (rejected) continue;
            throw new LibError(LibErrorKind.Validation, 'A custom validation rule could not finish.', [customIssue([...path, field], 'A custom validation rule could not finish.')], { cause, causedByInput: false });
          }
          const applyResult = (result: ValidationRuleResult): ValidationStep<readonly LocalRuleIssue[]> => {
            if (appendRuleResult(field, result) && mode === 'first') return finish();
            return evaluateRules(currentFieldIndex, currentRuleIndex + 1);
          };
          const onRejected = (cause: unknown): ValidationStep<readonly LocalRuleIssue[]> => {
            if (cause instanceof LibError) throw cause;
            if (rejected) return evaluateRules(currentFieldIndex, currentRuleIndex + 1);
            throw new LibError(LibErrorKind.Validation, 'A custom validation rule could not finish.', [customIssue([...path, field], 'A custom validation rule could not finish.')], { cause, causedByInput: false });
          };
          if (rawResult instanceof Promise) return rawResult.then(applyResult, onRejected);
          const continuation = adoptValidationThenable<ValidationRuleResult>(rawResult);
          if (continuation) return continuation.then(applyResult, onRejected);
          if (appendRuleResult(field, rawResult) && mode === 'first') return finish();
        }
      }
      return finish();
    };
    return evaluateRules(0, 0);
  };
  const visit = (value: unknown, path: IssuePath, ancestors: readonly { model: object; offset: number }[]): ValidationStep<void> => {
    if (value === null || typeof value !== 'object' || active.has(value) || (mode === 'first' && issues.length)) return;
    active.add(value);
    const release = (): void => { active.delete(value); };
    try {
      const definition = findGeneratedModelDefinition(value);
      const owners = definition ? [...ancestors, { model: value, offset: path.length }] : ancestors;
      const visitFields = (container: object, fields: readonly (string | number)[], index: number): ValidationStep<void> => {
        for (let fieldIndex = index; fieldIndex < fields.length; fieldIndex++) {
          const field = fields[fieldIndex];
          const child = visit(Reflect.get(container, field), [...path, field], owners);
          if (isNativeValidationPromise(child)) return child.then(() => visitFields(container, fields, fieldIndex + 1));
        }
      };
      const visitArrayItems = (array: readonly unknown[], index: number): ValidationStep<void> => {
        for (let itemIndex = index; itemIndex < array.length; itemIndex++) {
          const child = visit(array[itemIndex], [...path, itemIndex], owners);
          if (isNativeValidationPromise(child)) return child.then(() => visitArrayItems(array, itemIndex + 1));
        }
      };
      const finishModel = (definition: RegisteredGeneratedModelDefinition, local: readonly LocalRuleIssue[]): ValidationStep<void> => {
        for (const entry of local) {
          const fullPath = [...path, ...entry.issue.path];
          let issue = { ...entry.issue, path: fullPath };
          for (let ownerIndex = owners.length - 1; ownerIndex >= 0; ownerIndex--) {
            const owner = owners[ownerIndex];
            const registration = instanceRuleRegistration(owner.model);
            if (registration) {
              try {
                const formatted = registration.format({ ...issue, path: fullPath.slice(owner.offset) }, entry.explicit);
                issue = { ...formatted, path: fullPath };
              } catch (cause) {
                if (cause instanceof LibError) throw cause;
                throw new LibError(LibErrorKind.Validation, 'A validation message could not be formatted.', [issue], { cause, causedByInput: false });
              }
            }
          }
          issues.push(issue);
          if (mode === 'first') return;
        }
        const fields = definition.additionalProperties
          ? [...new Set([...definition.fields, ...Object.keys(value)])]
          : definition.fields;
        return visitFields(value, fields, 0);
      };
      if (definition) {
        const local = evaluateLocal(value, path);
        if (isNativeValidationPromise(local)) return local.then(result => finishModel(definition, result)).then(result => { release(); return result; }, error => { release(); throw error; });
        const result = finishModel(definition, local);
        if (isNativeValidationPromise(result)) return result.then(value => { release(); return value; }, error => { release(); throw error; });
        release();
        return result;
      } else if (Array.isArray(value)) {
        const result = visitArrayItems(value, 0);
        if (isNativeValidationPromise(result)) return result.then(value => { release(); return value; }, error => { release(); throw error; });
        release();
        return result;
      } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
        const keys = Object.keys(value);
        const result = visitFields(value, keys, 0);
        if (isNativeValidationPromise(result)) return result.then(value => { release(); return value; }, error => { release(); throw error; });
        release();
        return result;
      }
      release();
      return;
    } catch (error) {
      release();
      throw error;
    }
  };
  const result = visit(root, [], []);
  return isNativeValidationPromise(result) ? result.then(() => issues) : issues;
}

function codecValidationValue(model: object, definition: RegisteredGeneratedModelDefinition): object {
  if (definition.additionalProperties) return model;
  // The JSON view, as the codec validator reads it: a declared field counts when it is own, enumerable and not
  // `undefined`. A prototype getter does not supply a field.
  const payload: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const value = presentValue(model, field);
    if (value !== undefined) defineModelProperty(payload, field, value);
  }
  return payload;
}

/** The issues the codec's assert throws, none when the value passes. Any other error is not about the value and propagates. */
function codecIssues(codec: ObjectCodec, value: unknown, options: ValidateOptions): readonly Issue[] {
  try {
    codec.assert(value, options);
    return [];
  } catch (error) {
    if (error instanceof LibError && error.kind === LibErrorKind.Validation) return error.issues;
    throw error;
  }
}

async function collectCodecIssues(
  model: object,
  mode: ValidationMode,
  validationContext?: ModelValidationContext,
): Promise<readonly Issue[]> {
  assertAcyclicValue(model, LibErrorKind.Serialization);
  const definition = modelDefinition(model);
  const failFast = mode === 'first';
  let generated: readonly Issue[] = [];
  const codecId = codecIdForDefinition(definition);
  // A model registered without a profile validates only what it declares; with nothing to check it is not validatable.
  if (!codecId && !instanceRuleRegistration(model)?.rules.size) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      'This model has no generated validation or custom rules. Regenerate it with validation enabled or add rules.',
    );
  }
  if (codecId) {
    generated = codecIssues(
      requireObjectCodec(codecId),
      codecValidationValue(model, definition),
      { failFast, ...(validationContext === undefined ? {} : { validationContext }) },
    );
  }
  const overlay = mode === 'first' && generated.length ? [] : await evaluateInstanceRules(model, mode, generated);
  const issues = formatIssues(model, [...generated, ...overlay]);
  return mode === 'first' ? issues.slice(0, 1) : issues;
}

/**
 * A generated profile states whether validation was emitted: disabled fails,
 * enabled requires the conversion and schema metadata. A model registered
 * without a profile validates whatever metadata and rules it has.
 */
function publicValidationDefinition(model: unknown): RegisteredGeneratedModelDefinition {
  if (model === null || typeof model !== 'object') {
    throw new LibError(LibErrorKind.ValidationUnavailable, 'Validation requires a generated model instance.');
  }
  const definition = modelDefinition(model);
  if (definition.profile?.validation === false) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      'This model was generated without an enabled validation profile. Regenerate it with validation enabled.',
    );
  }
  // Here the profile, if any, validates at `true` or `'sanity'`.
  if (definition.profile !== undefined) {
    if (!definition.conversion) {
      throw new LibError(
        LibErrorKind.ValidationUnavailable,
        'Generated model conversion metadata is missing. Regenerate the model.',
      );
    }
    // Resolve the generated ObjectCodec before custom rules run.
    requireObjectCodecForConstructor(definition.constructor);
  }
  return definition;
}

function requireObjectCodecForConstructor(constructor: Function): ObjectCodec {
  const definition = findGeneratedModelDefinitionForConstructor(constructor);
  if (!definition) {
    throw new LibError(LibErrorKind.ValidationUnavailable, 'Generated model metadata is missing. Regenerate the model.');
  }
  return objectCodecForDefinition(definition);
}

/**
 * Type predicate for a named interned IObject or IModel.
 * The build-time rewrite replaces the call with the generated codec. An unrewritten call throws.
 */
export function validate<T>(_value: unknown, _options?: ValidateOptions & AllowGetterOptions): _value is T {
  throw untransformedCallError('validate');
}

/** The current issues, first issue only unless `failFast: false`, without changing validator state. */
export async function validateInstance<Model extends object>(
  model: Model,
  options?: ValidateOptions,
): Promise<readonly Issue[]> {
  publicValidationDefinition(model);
  try {
    const mode = options?.failFast === false ? 'all' : 'first';
    const issues = await collectCodecIssues(model, mode, options?.validationContext);
    return snapshotIssues(issues);
  } catch (error) {
    return validationUnfinished(error);
  }
}

export class ModelValidator<Fields extends object, Owner extends object = Fields> {
  protected readonly model: Owner;
  protected readonly rules: Map<string, InternalValidationRule[]>;
  protected readonly messageOverrides: Map<string, ValidationMessage>;
  protected issuesValue: readonly Issue[] = [];
  protected pendingValue = false;
  private validationId = 0;

  /**
   * `cache` is false while a generated integration is being enhanced.  The
   * factory publishes the finished value only after the enhancer succeeds;
   * direct low-level construction keeps the historical default and attaches
   * itself immediately for nested rule/message formatting.
   */
  public constructor(model: Owner, cache = true) {
    this.model = model;
    const state = ensureInstanceValidationState(model);
    this.rules = state.rules;
    this.messageOverrides = state.messageOverrides;
    if (cache) state.validator = this;
  }

  public get issues(): readonly Issue[] { return this.issuesValue; }
  public get errors(): Readonly<Record<string, readonly string[]>> {
    const errors: Record<string, string[]> = Object.create(null);
    for (const issue of this.issuesValue) (errors[issuePointer(issue.path)] ??= []).push(issue.message);
    return Object.freeze(Object.fromEntries(Object.entries(errors).map(([path, messages]) => [path, Object.freeze(messages)])));
  }
  public get valid(): boolean { return this.issuesValue.length === 0; }
  public get pending(): boolean { return this.pendingValue; }

  public extend(rules: ModelValidationRules<Fields, Owner>): this {
    for (const [field, configured] of Object.entries(rules)) {
      if (!configured) continue;
      const additions = Array.isArray(configured) ? configured : [configured];
      const current = this.rules.get(field) ?? [];
      for (const addition of additions as ValidationRule<unknown, Owner>[]) {
        current.push((value, model) => addition(value, model as Owner));
      }
      this.rules.set(field, current);
    }
    return this;
  }

  public messages(messages: ValidationMessages<Fields>): this {
    if (Array.isArray(messages)) {
      for (const entry of messages as readonly FieldValidationMessage[]) {
        this.messageOverrides.set(messageOverrideKey(entry.path, entry.code), entry.message);
      }
    } else {
      for (const [key, message] of Object.entries(messages)) {
        if (!message) continue;
        // Existing shorthand identifies a literal top-level field; nested paths use entries.
        const split = key.lastIndexOf('.');
        const code = split < 0 ? key : key.slice(split + 1);
        const path = split < 0 ? null : [key.slice(0, split)];
        this.messageOverrides.set(messageOverrideKey(path, code), message as ValidationMessage);
      }
    }
    return this;
  }

  private message(issue: Issue, explicit: boolean): Issue {
    if (explicit) return issue;
    const configured = this.messageOverrides.get(messageOverrideKey(issue.path, issue.code))
      ?? this.messageOverrides.get(messageOverrideKey(null, issue.code));
    if (configured === undefined) return issue;
    const message = typeof configured === 'function' ? configured(issue) : configured;
    if (typeof message !== 'string') throw new TypeError('Validation messages must be strings.');
    return { ...issue, message };
  }

  /** Internal formatting seam used by stateless nested evaluation. */
  public formatIssue(issue: Issue, explicit: boolean): Issue {
    return this.message(issue, explicit);
  }

  public async validate(options?: ValidateOptions): Promise<boolean> {
    const id = ++this.validationId;
    this.setPending(true);
    try {
      const mode = options?.failFast === false ? 'all' : 'first';
      const issues = await collectCodecIssues(this.model, mode, options?.validationContext);
      if (id === this.validationId) this.setIssues(issues);
      return issues.length === 0;
    } catch (error) { return validationUnfinished(error); }
    finally { if (id === this.validationId) this.setPending(false); }
  }

  public error(field: ModelField<Fields> | IssuePath): string | undefined { return this.errorsFor(field)[0]; }
  public errorsFor(field: ModelField<Fields> | IssuePath): readonly string[] {
    const path = typeof field === 'string' ? [field] : field;
    return this.issuesValue.filter(issue => issue.path.length === path.length && issue.path.every((part, index) => part === path[index])).map(issue => issue.message);
  }

  public setErrors(errors: Partial<Record<ModelField<Fields>, string | readonly string[]>> | readonly ExternalFieldError[]): void {
    const entries: readonly ExternalFieldError[] = Array.isArray(errors) ? errors as readonly ExternalFieldError[]
      : Object.entries(errors).filter(([, message]) => message !== undefined).map(([field, message]) => ({ path: [field], message: message as string | readonly string[] }));
    const issues = entries.flatMap(entry => (typeof entry.message === 'string' ? [entry.message] : entry.message).map((message): Issue => ({
      code: 'external', message, path: entry.path, source: IssueSource.External, representation: IssueRepresentation.Model,
    })));
    ++this.validationId;
    this.setIssues([...this.issuesValue.filter(issue => issue.source !== IssueSource.External), ...issues]);
    this.setPending(false);
  }

  public clear(): void { ++this.validationId; this.setIssues([]); this.setPending(false); }
  public setIssues(issues: readonly Issue[]): void { this.issuesValue = snapshotIssues(issues); }
  public setPending(pending: boolean): void { this.pendingValue = pending; }
}

function findCachedModelValidator<Fields extends object, Owner extends object>(
  model: Owner,
): ModelValidator<Fields, Owner> | undefined {
  const cached = readInstanceValidationState(model)?.validator;
  return cached instanceof ModelValidator ? cached as ModelValidator<Fields, Owner> : undefined;
}

/** Return the stable, stateful validator associated with a generated model. */
export function getValidator<Fields extends object, Owner extends object>(
  model: Owner & { readonly [generatedModelFieldsBrand]: Fields },
): ModelValidator<Fields, Owner>;
export function getValidator<Fields extends object = object, Owner extends object = Fields>(
  model: Owner,
): ModelValidator<Fields, Owner>;
export function getValidator<Fields extends object, Owner extends object = Fields>(
  model: Owner,
): ModelValidator<Fields, Owner> {
  const definition = publicValidationDefinition(model);
  const existing = findCachedModelValidator<Fields, Owner>(model);
  if (existing) return existing;
  const created = new ModelValidator<Fields, Owner>(model, false);
  const enhancer = definition.enhanceValidator;
  const enhanced = enhancer ? enhancer(created) : created;
  ensureInstanceValidationState(model).validator = enhanced;
  return enhanced;
}

export type {
  GeneratedModelConstructor,
  ModelField,
  ModelTypeDescriptor,
};
